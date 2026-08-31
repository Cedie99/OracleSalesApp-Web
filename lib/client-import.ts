import * as XLSX from 'xlsx'
import { matchPsgcLocality } from '@/lib/data/psgc-match'
import type { CustomerType, Profile, SalesChannel } from '@/types'

/**
 * Bulk client import — parsing, normalisation and validation for the superadmin
 * upload page (`app/(admin)/clients/import`).
 *
 * Everything here is pure: no React, no network. The page feeds it a file and a
 * roster, and gets back one verdict per row. That split exists because the file
 * is the untrustworthy part of this feature — a spreadsheet filled in by hand,
 * off-system, by someone who cannot see the database — so the rules it is judged
 * against have to be readable in one place and testable without a browser.
 *
 * WHY THE CHECKS ARE STRICTER THAN THE DATABASE. Only `company_name` and
 * `assigned_agent_id` are actually NOT NULL (migration 013 dropped the rest when
 * mobile began creating clients bare-bones in the field). A bulk path cannot
 * lean on that. Two columns are therefore required here that the column
 * definitions allow to be null:
 *
 *   - `city`, because the duplicate guard is a partial unique index on
 *     (normalized_company_name, city) and a UNIQUE index treats NULLs as
 *     DISTINCT — so a row with no city can be imported twice, and again on the
 *     next upload, with nothing to stop it. One blank cell silently switches off
 *     the only protection standing between this feature and a duplicated
 *     customer master.
 *   - `customer_type`, because a NULL there is not neutral. Migration 040's
 *     `advance_prospect_to_in_progress()` matches on
 *     `customer_type IS NULL OR customer_type = 'prospect'`, so a blank-type row
 *     silently enters the prospect lifecycle the first time an agent logs a
 *     qualifying meeting against it. Blank defaults to 'existing' here (with a
 *     warning) rather than being written as null.
 *
 * Everything else that is nullable in the database stays optional here, and a
 * bad value in an optional column drops that value with a warning instead of
 * failing the row — a malformed phone number is not a reason to refuse a client.
 */

// --- The sheet contract -----------------------------------------------------

/**
 * The columns of the template, in order. `public/templates/client-import-template.xlsx`
 * is generated to match this list exactly; keep the two in step.
 */
export const IMPORT_HEADERS = [
  'company_name', 'city', 'province', 'agent_email', 'customer_type', 'sales_channel',
  'contact_person', 'contact_position', 'contact_number', 'office_address', 'landmark',
  'office_lat', 'office_lng',
] as const

export type ImportHeader = (typeof IMPORT_HEADERS)[number]

/** Headers the file MUST carry. The rest may be absent entirely. */
const REQUIRED_HEADERS: ImportHeader[] = ['company_name', 'city', 'agent_email']

/**
 * Columns that must never arrive from a spreadsheet.
 *
 * `normalized_company_name` is `GENERATED ALWAYS` (migration 014/099) and errors
 * on insert. `details_deadline_at` is written by a BEFORE INSERT trigger (021),
 * `current_cycle_id`/`cycle_started_at` by an AFTER INSERT trigger (051), and
 * `credit_balance` by the credit-ledger roll-up (117). `status`, `lost_at` and
 * `reassignable_at` are a loss transition that has to go through
 * `declare_client_lost()` (088/112) or the client ends up unclaimable.
 *
 * Presence of any of these is a file-level error rather than a per-row one: it
 * means the wrong template is being used, and every row would be wrong the same
 * way.
 */
const FORBIDDEN_HEADERS = [
  'id', 'status', 'normalized_company_name', 'details_deadline_at', 'details_completed_at',
  'credit_balance', 'current_cycle_id', 'cycle_started_at', 'lost_at', 'reassignable_at',
  'created_at', 'updated_at', 'in_progress_at', 'office_pin_source', 'assigned_agent_id',
  'created_source',
]

/** Roles that may hold a client — the same list the Clients page assigns from. */
export const IMPORTABLE_AGENT_ROLES = ['sales_specialist', 'sales_manager', 'rsr']

const CUSTOMER_TYPES: CustomerType[] = ['prospect', 'in_progress', 'new', 'existing']
const SALES_CHANNELS: SalesChannel[] = ['distributor', 'dealer', 'end_user', 'private_label']

/** Philippines bounding box, matching the guard in `set_client_location()` (113). */
const PH_BOUNDS = { minLat: 4.0, maxLat: 21.5, minLng: 116.0, maxLng: 127.0 }

// --- Results ----------------------------------------------------------------

/**
 * How a row came out.
 *
 * 'duplicate' is deliberately not 'error': a re-run of the same file, or a row
 * for a customer already on the system, is the expected case rather than a
 * mistake, and burying it in an error list trains people to ignore the error
 * list. Duplicates are skipped, counted, and listed separately.
 */
export type RowVerdict = 'ready' | 'warning' | 'duplicate' | 'error'

export interface RowIssue {
  /** The offending column, or null for a whole-row problem. */
  field: ImportHeader | null
  message: string
  severity: 'warning' | 'error'
}

/** The exact column set written to `clients`. Nothing else is ever sent. */
export interface ClientInsert {
  company_name: string
  city: string
  province: string | null
  assigned_agent_id: string
  customer_type: CustomerType
  sales_channel: SalesChannel | null
  contact_person: string | null
  contact_position: string | null
  contact_number: string | null
  office_address: string | null
  landmark: string | null
  office_lat: number | null
  office_lng: number | null
  office_pin_source: 'manual' | null
  office_pin_updated_at: string | null
  details_completed_at: string | null
  status: 'active'
  /** Provenance (migration 127). Always 'import' on this path, by definition. */
  created_source: 'import'
}

export interface ImportRow {
  /** 1-based row number as it appears in Excel, header included. */
  rowNumber: number
  companyName: string
  /** Resolved payload, present unless the row errored. */
  values: ClientInsert | null
  issues: RowIssue[]
  verdict: RowVerdict
  /** `normalized_company_name || city`, matching the unique index. */
  dedupeKey: string | null
}

export interface ImportReport {
  rows: ImportRow[]
  /** Problems with the file itself. Any entry here means nothing can be imported. */
  fileErrors: string[]
  counts: Record<RowVerdict, number>
  /** Rows that would actually be inserted, in sheet order. */
  importable: ImportRow[]
}

// --- Normalisation ----------------------------------------------------------

/** Strip the invisible characters spreadsheets accumulate, then collapse runs. */
function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/[ ​‌‍﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The database's own company key, mirroring `normalize_company_name()` as
 * migration 099 redefined it: lowercase, then drop every non-alphanumeric
 * character. Duplicate detection has to be done on exactly this, or the preview
 * promises a row will import and the insert then trips the unique index.
 */
export function normalizeCompanyName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function dedupeKeyFor(companyName: string, city: string): string {
  return `${normalizeCompanyName(companyName)}||${city}`
}

/**
 * A Philippine mobile number in the shape the column already holds.
 *
 * Every one of the 437 populated `contact_number` values in production is
 * exactly 11 digits starting `09`, so that is what this produces. The other
 * accepted shapes are the ones a spreadsheet actually mangles into: Excel eats
 * the leading zero of `09171234567` and stores `9171234567`, and a pasted number
 * may carry `+63`/`63`, spaces, dashes or parentheses.
 *
 * Returns null when it cannot get to a plausible number — the caller drops the
 * value with a warning rather than storing something `toE164()` would later
 * refuse, which reads to an admin as "the text never arrived".
 */
export function normalizeMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (/^09\d{9}$/.test(digits)) return digits
  if (/^9\d{9}$/.test(digits)) return `0${digits}`
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`
  if (/^009\d{10}$/.test(digits)) return digits.slice(2)
  return null
}

/** Lowercase an enum the way a human would have typed it: "End User" -> end_user. */
function normalizeEnum(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]+/g, '_')
}

function parseCoordinate(raw: string): number | null {
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * The five fields the product treats as a complete client record — the same list
 * as mobile's Complete Info checklist (see `lib/client-info.ts`).
 *
 * When they are all present the row is stamped `details_completed_at`, which is
 * what takes it out of reach of the nightly prospect cleanup
 * (`app/api/cron/prospect-cleanup`). That job only sweeps
 * `customer_type = 'prospect'`, so an 'existing' import is not at risk either
 * way — but stamping it honestly means the client also stops being reported as
 * incomplete everywhere else, and a later re-typing of the row cannot flip it
 * into the prospect lifecycle.
 */
function isRecordComplete(v: Omit<ClientInsert, 'details_completed_at'>): boolean {
  return !!(v.company_name && v.contact_person && v.contact_number && v.office_address && v.sales_channel)
}

// --- Parsing ----------------------------------------------------------------

export interface ParsedSheet {
  headers: string[]
  /** One entry per data row, keyed by header, values as trimmed strings. */
  records: Record<string, string>[]
  fileErrors: string[]
}

/**
 * Read the first worksheet into plain string records.
 *
 * `raw: false` asks SheetJS for the FORMATTED value, which is what makes a
 * number-formatted phone column survive: the cell holds 9171234567 but displays
 * what the user typed. `defval: ''` keeps missing cells as empty strings so
 * every record has the same shape.
 */
export function parseWorkbook(data: ArrayBuffer): ParsedSheet {
  const fileErrors: string[] = []
  const wb = XLSX.read(data, { type: 'array' })

  // The template's data sheet is "Clients"; fall back to the first sheet so a
  // renamed tab is a warning-shaped problem rather than an unreadable file.
  const sheetName = wb.SheetNames.includes('Clients') ? 'Clients' : wb.SheetNames[0]
  if (!sheetName) {
    return { headers: [], records: [], fileErrors: ['This file has no worksheets.'] }
  }

  const grid = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
    header: 1, raw: false, defval: '', blankrows: false,
  })
  if (!grid.length) {
    return { headers: [], records: [], fileErrors: ['The sheet is empty.'] }
  }

  const headers = (grid[0] ?? []).map(h => clean(h).toLowerCase())
  const records: Record<string, string>[] = []
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? []
    if (!row.some(cell => clean(cell))) continue // spacer row
    const record: Record<string, string> = { __row: String(i + 1) }
    headers.forEach((h, idx) => { if (h) record[h] = clean(row[idx]) })
    records.push(record)
  }

  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) fileErrors.push(`Missing required column "${required}".`)
  }
  for (const forbidden of FORBIDDEN_HEADERS) {
    if (headers.includes(forbidden)) {
      fileErrors.push(`Column "${forbidden}" is set by the system and must be removed from the file.`)
    }
  }
  if (!records.length) fileErrors.push('The sheet has a header row but no data rows.')

  return { headers, records, fileErrors }
}

// --- Validation -------------------------------------------------------------

export interface ValidationContext {
  /** Active profiles in an assignable role. Matched on email, case-insensitively. */
  agents: Profile[]
  /**
   * `normalized_company_name || city` for every client already on the system
   * that is not soft-deleted — the live half of the unique index.
   */
  existingKeys: Set<string>
}

/**
 * Judge every parsed record.
 *
 * Order matters in one place: the in-file duplicate check runs as rows are
 * walked, so the FIRST occurrence of a company imports and the later ones are
 * the duplicates. That matches what a person expects from a list.
 */
export function validateRows(parsed: ParsedSheet, ctx: ValidationContext): ImportReport {
  const byEmail = new Map<string, Profile>()
  for (const agent of ctx.agents) {
    const email = agent.email?.trim().toLowerCase()
    if (email) byEmail.set(email, agent)
  }

  const seen = new Map<string, number>()
  const rows: ImportRow[] = []

  for (const record of parsed.records) {
    const rowNumber = Number(record.__row)
    const issues: RowIssue[] = []
    const add = (field: ImportHeader | null, message: string, severity: 'warning' | 'error' = 'error') =>
      issues.push({ field, message, severity })

    const companyName = record.company_name ?? ''
    if (!companyName) add('company_name', 'Company name is required.')

    // --- owner -------------------------------------------------------------
    const email = (record.agent_email ?? '').toLowerCase()
    const agent = email ? byEmail.get(email) : undefined
    if (!email) add('agent_email', 'An owning agent is required.')
    else if (!agent) {
      add('agent_email', `No active ${IMPORTABLE_AGENT_ROLES.join('/')} account with the email "${record.agent_email}".`)
    }

    // --- locality ----------------------------------------------------------
    const rawCity = record.city ?? ''
    const rawProvince = record.province ?? ''
    let city = ''
    let province: string | null = null
    if (!rawCity) {
      add('city', 'City is required — without it, duplicate detection cannot protect this row.')
    } else {
      const match = matchPsgcLocality(rawCity, rawProvince || null)
      if (!match) {
        add('city', `"${rawCity}" is not an official PSA/PSGC municipality or city${rawProvince ? '' : ', or it needs a province to tell it apart from a same-named one'}.`)
      } else {
        city = match.name
        province = match.province || null
        if (rawProvince && province && normalizeEnum(rawProvince) !== normalizeEnum(province)) {
          add('province', `Province corrected to "${province}" to match ${city}.`, 'warning')
        }
      }
    }

    // --- lifecycle stage ---------------------------------------------------
    let customerType: CustomerType = 'existing'
    const rawType = normalizeEnum(record.customer_type ?? '')
    if (!rawType) {
      add('customer_type', 'Blank — imported as "existing". A blank stage would let a later meeting pull this client into the prospect lifecycle.', 'warning')
    } else if (!CUSTOMER_TYPES.includes(rawType as CustomerType)) {
      add('customer_type', `"${record.customer_type}" is not one of: ${CUSTOMER_TYPES.join(', ')}.`)
    } else {
      customerType = rawType as CustomerType
    }

    // --- channel -----------------------------------------------------------
    let salesChannel: SalesChannel | null = null
    const rawChannel = normalizeEnum(record.sales_channel ?? '')
    if (rawChannel) {
      if (!SALES_CHANNELS.includes(rawChannel as SalesChannel)) {
        add('sales_channel', `"${record.sales_channel}" is not one of: ${SALES_CHANNELS.join(', ')}.`)
      } else {
        salesChannel = rawChannel as SalesChannel
      }
    }

    // --- phone: never fatal ------------------------------------------------
    let contactNumber: string | null = null
    const rawMobile = record.contact_number ?? ''
    if (rawMobile) {
      contactNumber = normalizeMobile(rawMobile)
      if (!contactNumber) {
        add('contact_number', `"${rawMobile}" is not a usable mobile number — imported without one.`, 'warning')
      } else if (contactNumber !== rawMobile) {
        add('contact_number', `Read as ${contactNumber}.`, 'warning')
      }
    }

    // --- office pin: both or neither ---------------------------------------
    let lat = parseCoordinate(record.office_lat ?? '')
    let lng = parseCoordinate(record.office_lng ?? '')
    const hasLatText = !!(record.office_lat ?? '')
    const hasLngText = !!(record.office_lng ?? '')
    if ((hasLatText || hasLngText) && (lat === null || lng === null)) {
      add(lat === null ? 'office_lat' : 'office_lng', 'A map pin needs both a latitude and a longitude — imported without a pin.', 'warning')
      lat = null; lng = null
    } else if (lat !== null && lng !== null) {
      const inBounds =
        lat >= PH_BOUNDS.minLat && lat <= PH_BOUNDS.maxLat &&
        lng >= PH_BOUNDS.minLng && lng <= PH_BOUNDS.maxLng
      if (!inBounds) {
        add('office_lat', `${lat}, ${lng} is outside the Philippines — imported without a pin.`, 'warning')
        lat = null; lng = null
      }
    }

    const hasError = issues.some(i => i.severity === 'error')
    const dedupeKey = companyName && city ? dedupeKeyFor(companyName, city) : null

    let verdict: RowVerdict
    let values: ClientInsert | null = null

    if (hasError) {
      verdict = 'error'
    } else if (dedupeKey && ctx.existingKeys.has(dedupeKey)) {
      verdict = 'duplicate'
      add(null, 'A client with this name already exists in this city — skipped.', 'warning')
    } else if (dedupeKey && seen.has(dedupeKey)) {
      verdict = 'duplicate'
      add(null, `Same company and city as row ${seen.get(dedupeKey)} — skipped.`, 'warning')
    } else {
      if (dedupeKey) seen.set(dedupeKey, rowNumber)
      verdict = issues.length ? 'warning' : 'ready'

      const now = new Date().toISOString()
      const base = {
        company_name: companyName,
        city,
        province,
        assigned_agent_id: agent!.id,
        customer_type: customerType,
        sales_channel: salesChannel,
        contact_person: record.contact_person || null,
        contact_position: record.contact_position || null,
        contact_number: contactNumber,
        office_address: record.office_address || null,
        landmark: record.landmark || null,
        office_lat: lat,
        office_lng: lng,
        // 052's CHECK allows 'manual' | 'client_office_meeting'. An imported pin
        // is an office-entered one, which is exactly what 'manual' means; the
        // other value is reserved for GPS auto-captured at a Client Office
        // meeting and must never be claimed by a spreadsheet.
        office_pin_source: lat !== null ? ('manual' as const) : null,
        office_pin_updated_at: lat !== null ? now : null,
        status: 'active' as const,
        // 127. Set here rather than at the call site so it cannot be forgotten
        // by a second caller: a row this function builds came from a
        // spreadsheet, and that is the only thing this value ever means.
        created_source: 'import' as const,
      }
      values = { ...base, details_completed_at: isRecordComplete(base) ? now : null }
    }

    rows.push({ rowNumber, companyName, values, issues, verdict, dedupeKey })
  }

  const counts: Record<RowVerdict, number> = { ready: 0, warning: 0, duplicate: 0, error: 0 }
  for (const row of rows) counts[row.verdict]++

  return {
    rows,
    fileErrors: parsed.fileErrors,
    counts,
    importable: rows.filter(r => r.values !== null),
  }
}

/**
 * How many rows go to the database per request.
 *
 * Each insert fires two triggers — `trg_set_client_deadline` (021) and
 * `open_cycle_on_client_insert` (051), the second of which INSERTs a
 * `client_cycles` row and UPDATEs the client back — so a batch of 200 is roughly
 * 600 statements. Large enough that an 11,000-row file is ~55 round trips rather
 * than 11,000, small enough to stay well inside a statement timeout and to make
 * the row-by-row retry on failure cheap.
 */
export const IMPORT_BATCH_SIZE = 200
