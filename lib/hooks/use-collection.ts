'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { recordAuditLog } from '@/lib/audit/actions'
import { singleChange } from '@/lib/audit/entries'
import { peso } from '@/lib/money'
import { REMITTANCE_STATUS_LABEL } from '@/lib/status-styles'
import type {
  Client, CollectionPayment, CollectionVisit, Profile, Remittance, RemittanceStatus,
} from '@/types'

/**
 * Live Collection data (migration 043).
 *
 * Columns are named explicitly rather than `*`, for the reason use-clients.ts
 * documents: the database is shared with the mobile repo, and `*` would let a
 * column mobile adds reach the UI untyped instead of surfacing as a loud error.
 */

// `address_line1/2` + `landmark` ride along with `office_address` because a
// store's address is spread across two generations of columns and `clientAddress`
// composes them — selecting only the legacy free-text field made the maps page
// report "No address on file" for stores that carry a perfectly good structured
// one. All of these are long-deployed (013) and already selected by use-clients.
const CLIENT_JOIN = `
  id, company_name, contact_person, contact_position, contact_number,
  office_address, address_line1, address_line2, landmark,
  customer_type, sales_channel, assigned_agent_id, status,
  city, province, lost_at, reassignable_at, created_at, updated_at
`

const PROFILE_JOIN = `id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at`

// ⚠️ `customer_signature_url` is deliberately ABSENT until migration 061 is
// deployed. PostgREST rejects the ENTIRE select on one unknown column, so naming
// it early doesn't degrade to a null field — it returns zero rows and takes the
// whole Collection page down with a "column does not exist" banner. Add it back
// as the first step after 061 merges; `normalizeVisit` already defaults it to
// null so nothing else has to change on the day.
const VISIT_COLUMNS = `
  id, client_id, client_name, area, status, scheduled_for, listed_by, listed_at, amount_due,
  claimed_by, claimed_at, claimed_by_name,
  collector_id, amount_collected, payment_method, payment_photo_url,
  delivery_receipt_photo_url, gps_lat, gps_lng, remarks, rescheduled_to,
  visited_at, created_at,
  client:clients!client_id ( ${CLIENT_JOIN} ),
  collector:profiles!collector_id ( ${PROFILE_JOIN} )
`

// The three migration-068 columns, selected ON TOP of VISIT_COLUMNS. Kept apart
// so the fetch below can FALL BACK to VISIT_COLUMNS alone during the window
// between this code deploying and 068 being applied: PostgREST rejects the whole
// select on one unknown column (the customer_signature_url lesson above), so
// naming them unconditionally would take the page down until the migration
// caught up. `normalizeVisit` defaults all three, so the fallback simply shows
// no additional state; once 068 is live the primary select succeeds and the
// Delivered/Viewed board lights up with no redeploy. This removes any
// app/migration deploy-ordering coupling.
//
// `client_lat`/`client_lng` (migration 114 — the store's default map pin) join
// the same group for the same reason: 114 ships in this repo and CI applies it
// on merge, but the Vercel build and the migration push race, so for a few
// minutes the new code can be live against the old schema.
const ADDITIONAL_COLUMNS = `
  is_additional, additional_received_at, additional_seen_at,
  client_lat, client_lng
`

/** True when a select failed only because 068's/114's columns aren't there yet. */
function isMissingAdditionalColumn(error: { message?: string } | null): boolean {
  return !!error?.message
    && /is_additional|additional_received_at|additional_seen_at|client_lat|client_lng/.test(error.message)
}

// The installments behind a partial store (migration 070). Fetched in one pass
// and grouped onto their visits rather than joined into VISIT_COLUMNS, so the
// query can be skipped entirely — and tolerate the table not existing yet —
// during the window before 070 deploys. See loadPayments.
const PAYMENT_COLUMNS = `
  id, visit_id, collector_id, amount, payment_method, payment_photo_url,
  delivery_receipt_photo_url, gps_lat, gps_lng, remarks, paid_at, created_at,
  collector:profiles!collector_id ( ${PROFILE_JOIN} )
`

function normalizePayment(row: Record<string, unknown>): CollectionPayment {
  return {
    ...(row as unknown as CollectionPayment),
    amount: num(row.amount) ?? 0,
    gps_lat: num(row.gps_lat),
    gps_lng: num(row.gps_lng),
    collector: one<Profile>(row.collector),
  }
}

/**
 * Every installment, grouped by the visit it belongs to (newest first). One
 * query, not one per visit. Tolerates the pre-070 window: if `collection_payments`
 * doesn't exist yet the select errors and we return an empty map, so the page
 * shows no installment history rather than falling over — the same
 * deploy-order-proofing the additional columns use above.
 */
async function loadPayments(
  supabase: ReturnType<typeof createClient>,
): Promise<Map<string, CollectionPayment[]>> {
  const byVisit = new Map<string, CollectionPayment[]>()
  const { data, error } = await supabase
    .from('collection_payments')
    .select(PAYMENT_COLUMNS)
    .order('paid_at', { ascending: false })

  if (error || !data) return byVisit
  for (const raw of data) {
    const payment = normalizePayment(raw as Record<string, unknown>)
    const list = byVisit.get(payment.visit_id)
    if (list) list.push(payment)
    else byVisit.set(payment.visit_id, [payment])
  }
  return byVisit
}

const REMITTANCE_COLUMNS = `
  id, collector_id, destination, amount_remitted, amount_collected, status,
  receiver_name, signed_proof_url, receiver_signature_url, visit_ids,
  submitted_at, created_at,
  collector:profiles!collector_id ( ${PROFILE_JOIN} )
`

/**
 * PostgREST can serialise a `NUMERIC` column as a JSON *string* rather than a
 * number, depending on the value and driver. Every amount in this module is
 * summed (`reduce((sum, v) => sum + v.amount_collected)`), and string
 * concatenation there fails silently and spectacularly — "5600" + "5600" is
 * "56005600", which then renders as a peso figure. Coerce once, here, at the
 * boundary rows enter the app.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** PostgREST returns an embedded one-to-one as an object, but typings allow an array. */
function one<T>(value: unknown): T | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return (v as T | null) ?? undefined
}

function normalizeVisit(
  row: Record<string, unknown>,
  paymentsByVisit?: Map<string, CollectionPayment[]>,
): CollectionVisit {
  return {
    ...(row as unknown as CollectionVisit),
    // Installments behind a partial store (migration 070). Empty until 070 is
    // live — loadPayments yields an empty map on the missing table — which reads
    // the same as a store paid in one visit: no history to show.
    payments: paymentsByVisit?.get(row.id as string) ?? [],
    // Not selected until 061 deploys (see VISIT_COLUMNS), so default it rather
    // than let the type claim a field the row doesn't carry.
    customer_signature_url: (row.customer_signature_url as string | null) ?? null,
    // Likewise not selected until migration 068 deploys — default all three so
    // the type stays honest until the read is added. See the note in types.
    is_additional: (row.is_additional as boolean | undefined) ?? false,
    additional_received_at: (row.additional_received_at as string | null) ?? null,
    additional_seen_at: (row.additional_seen_at as string | null) ?? null,
    amount_due: num(row.amount_due) ?? 0,
    amount_collected: num(row.amount_collected),
    gps_lat: num(row.gps_lat),
    gps_lng: num(row.gps_lng),
    // Absent while the pre-114 fallback select is in play; null then reads as
    // "no default pin known", which is exactly how the maps page treats it.
    client_lat: num(row.client_lat),
    client_lng: num(row.client_lng),
    client: one<Client>(row.client),
    collector: one<Profile>(row.collector),
  }
}

function normalizeRemittance(row: Record<string, unknown>): Remittance {
  return {
    ...(row as unknown as Remittance),
    amount_remitted: num(row.amount_remitted) ?? 0,
    amount_collected: num(row.amount_collected) ?? 0,
    collector: one<Profile>(row.collector),
  }
}

/** What the admin fills in when putting a store on a day's list. */
export interface NewCollectionVisit {
  clientId: string
  /**
   * The selected client's `company_name`, denormalized onto the row (migration
   * 045). Not looked up here: the collector's phone can't read `clients`, so
   * the name has to be written at publish time by the admin, who has it.
   */
  clientName: string
  /** The selected client's `city`, denormalized for the same reason. */
  area: string | null
  /** `yyyy-MM-dd` from the date input. */
  scheduledFor: string
  amountDue: number
  /** The admin publishing the list. */
  listedBy: string | null
}

interface UseCollectionVisitsResult {
  visits: CollectionVisit[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
  createVisit: (draft: NewCollectionVisit) => Promise<string | null>
  removeVisit: (id: string) => Promise<string | null>
  cancelClaim: (id: string) => Promise<string | null>
}

/**
 * Every listed store, newest collection day first, with its client and whoever
 * worked it joined in.
 *
 * Not filtered by day here: the page groups into daily lists itself
 * (`buildDays`), the maps page slices by date range, and the dashboard
 * aggregates — all three want the same unfiltered set.
 */
export function useCollectionVisits(): UseCollectionVisitsResult {
  const [visits, setVisits] = useState<CollectionVisit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const primary = await supabase
      .from('collection_visits')
      .select(`${VISIT_COLUMNS}, ${ADDITIONAL_COLUMNS}`)
      .order('scheduled_for', { ascending: false })

    // The two selects infer different row shapes, so hold the rows at the shape
    // normalizeVisit already accepts rather than let the union fight itself.
    let rows = primary.data as Record<string, unknown>[] | null
    let queryError = primary.error

    // Pre-068 fallback: retry without the additional columns rather than fail
    // the whole page. See ADDITIONAL_COLUMNS.
    if (queryError && isMissingAdditionalColumn(queryError)) {
      const fallback = await supabase
        .from('collection_visits')
        .select(VISIT_COLUMNS)
        .order('scheduled_for', { ascending: false })
      rows = fallback.data as Record<string, unknown>[] | null
      queryError = fallback.error
    }

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      const paymentsByVisit = await loadPayments(supabase)
      setVisits((rows ?? []).map(row => normalizeVisit(row, paymentsByVisit)))
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // The board an admin leaves open while the day is being worked, so it takes
  // the fast cadence. Payments are watched alongside the visits because a
  // partial payment lands as its own row first — the visit's rolled-up
  // `amount_collected` follows from a trigger, but the photo and the remarks
  // arrive on the payment, and `loadPayments` above reads them.
  useAutoRefresh(load, {
    watch: [{ table: 'collection_visits' }, { table: 'collection_payments' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  /** Returns an error message, or null on success. */
  const createVisit = useCallback(
    async (draft: NewCollectionVisit): Promise<string | null> => {
      const supabase = createClient()
      const { data: inserted, error: insertError } = await supabase.from('collection_visits').insert({
        client_id: draft.clientId,
        // Denormalized at publish time — the phone can't resolve client_id
        // itself. See migration 045.
        client_name: draft.clientName,
        area: draft.area,
        status: 'pending',
        // Midday, so the store lands on the intended day whatever timezone the
        // browser is in — a bare date string would drift a day either side.
        scheduled_for: new Date(`${draft.scheduledFor}T12:00:00`).toISOString(),
        listed_by: draft.listedBy,
        amount_due: draft.amountDue,
        // Everything the collector fills in stays null: the store belongs to
        // nobody until someone actually works it.
      })
        .select('id')
        .single()

      if (insertError) return insertError.message

      void recordAuditLog({
        action: 'collection_visit.listed',
        entityTable: 'collection_visits',
        entityId: inserted?.id ?? null,
        entityLabel: draft.clientName,
        summary: `Listed ${draft.clientName} for collection on ${draft.scheduledFor}`,
        changes: [
          { field: 'scheduled_for', label: 'Scheduled for', from: null, to: draft.scheduledFor },
          { field: 'amount_due', label: 'Amount due', from: null, to: peso(draft.amountDue) },
          { field: 'area', label: 'Area', from: null, to: draft.area },
        ],
      })

      await load()
      return null
    },
    [load]
  )

  const removeVisit = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      // Read before the delete: once the row is gone the log has no way back to
      // which store this was, and "removed a collection visit" without a name
      // is not worth recording.
      const target = visits.find(v => v.id === id)

      const { error: deleteError } = await supabase
        .from('collection_visits')
        .delete()
        .eq('id', id)

      if (deleteError) return deleteError.message

      void recordAuditLog({
        action: 'collection_visit.removed',
        entityTable: 'collection_visits',
        entityId: id,
        entityLabel: target?.client_name ?? null,
        summary: `Removed ${target?.client_name ?? 'a store'} from the collection list`,
        // The row is gone, so the whole thing is the "before" — this is the only
        // surviving record of what was removed.
        metadata: target
          ? {
              scheduled_for: target.scheduled_for,
              amount_due: target.amount_due,
              status: target.status,
              claimed_by_name: target.claimed_by_name,
            }
          : null,
      })

      await load()
      return null
    },
    [load, visits]
  )

  /**
   * Release a collector's claim so the store returns to the shared pool
   * (migration 046). Admin-only in practice — RLS lets the claimer clear their
   * own, but web is only ever used by admins.
   *
   * The main reason this exists: claims never expire, so a store claimed at 4pm
   * and never worked stays locked, and with one claim per person that collector
   * can't take anything the next morning until someone clears it.
   */
  const cancelClaim = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      const target = visits.find(v => v.id === id)

      // All three together — `collection_visits_claim_complete` rejects a
      // partial claim.
      const { error: updateError } = await supabase
        .from('collection_visits')
        .update({ claimed_by: null, claimed_at: null, claimed_by_name: null })
        .eq('id', id)

      if (updateError) return updateError.message

      const collector = target?.claimed_by_name
      void recordAuditLog({
        action: 'collection_visit.claim_released',
        entityTable: 'collection_visits',
        entityId: id,
        entityLabel: target?.client_name ?? null,
        summary:
          `Released ${collector ? `${collector}'s` : 'the'} claim on ` +
          `${target?.client_name ?? 'a store'}`,
        changes: singleChange('claimed_by_name', 'Claimed by', collector ?? null, null),
      })

      await load()
      return null
    },
    [load, visits]
  )

  return { visits, loading, error, refresh, createVisit, removeVisit, cancelClaim }
}

interface UseRemittancesResult {
  remittances: Remittance[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
  setStatus: (id: string, status: RemittanceStatus) => Promise<string | null>
}

/** Money handed over by collectors, most recent first. */
export function useRemittances(): UseRemittancesResult {
  const [remittances, setRemittances] = useState<Remittance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('remittances')
      .select(REMITTANCE_COLUMNS)
      .order('submitted_at', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setRemittances((data ?? []).map(row => normalizeRemittance(row as Record<string, unknown>)))
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // Money in transit — a collector submitting a hand-over is something the
  // office wants to see land, not discover on reload.
  useAutoRefresh(load, {
    watch: [{ table: 'remittances' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  /**
   * Reconcile a remittance, or flag it as a variance. Returns an error message,
   * or null on success.
   *
   * Everything after `submitted` is web's to do. Mobile INSERTs the row and
   * never touches it again — not by convention but because it cannot: migration
   * 043 gives collectors INSERT and SELECT on `remittances` and no UPDATE
   * policy at all, so `status` would sit on its default forever if this page
   * didn't move it. Admins reach it through "Collection admins manage
   * remittances", which is `FOR ALL`.
   *
   * `submitted` is a legal target too, so a misclick can be undone — the CHECK
   * constraint allows all three values in any direction, and nothing downstream
   * treats reconciliation as one-way.
   */
  const setStatus = useCallback(
    async (id: string, status: RemittanceStatus): Promise<string | null> => {
      const supabase = createClient()
      const target = remittances.find(r => r.id === id)

      const { error: updateError } = await supabase
        .from('remittances')
        .update({ status })
        .eq('id', id)

      if (updateError) return updateError.message

      const collector = target?.collector?.full_name ?? 'a collector'
      void recordAuditLog({
        action: 'remittance.status_changed',
        entityTable: 'remittances',
        entityId: id,
        entityLabel: `${collector} — ${peso(target?.amount_remitted ?? 0)}`,
        summary:
          `Marked ${collector}'s ${peso(target?.amount_remitted ?? 0)} remittance as ` +
          `${REMITTANCE_STATUS_LABEL[status]}`,
        changes: singleChange(
          'status',
          'Status',
          target ? REMITTANCE_STATUS_LABEL[target.status] : null,
          REMITTANCE_STATUS_LABEL[status],
        ),
        // The variance is the reason anyone revisits one of these decisions, so
        // it belongs on the entry rather than being recomputed from two tables.
        metadata: target
          ? {
              amount_remitted: target.amount_remitted,
              amount_collected: target.amount_collected,
              variance: target.amount_remitted - target.amount_collected,
            }
          : null,
      })

      await load()
      return null
    },
    [load, remittances]
  )

  return { remittances, loading, error, refresh, setStatus }
}
