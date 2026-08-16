'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canManageCollection } from '@/lib/permissions'
import { sendSmsBatch, toE164, smsConfigured, type SmsRequest } from '@/lib/collection/busybee'
import { recordAuditLog } from '@/lib/audit/actions'
import { peso } from '@/lib/money'
import { format } from 'date-fns'
import type { AdminScope, UserRole } from '@/types'

/**
 * The write path for an "additional" collection store — the half of the
 * cross-repo Additional Collection feature that fires an SMS, so it cannot go
 * through the client-side `createVisit` every other store uses.
 *
 * Two reasons this is a server action and not a plain insert:
 *
 *  1. The BusyBee key is server-only (`BUSYBEE_API_KEY`). A client-side insert
 *     could set `is_additional`, but it could never send the notification.
 *  2. Resolving recipients means reading every active collector's
 *     `contact_number`, which the browser's anon session has no business doing
 *     in bulk.
 *
 * The store itself is listed with the service-role client so the row lands with
 * `is_additional = true` regardless of how RLS evolves; the caller is checked
 * against the same Collection-admin gate the page sits behind.
 */

export interface ListAdditionalStoreInput {
  clientId: string
  /** The client's `company_name`, denormalized onto the row (migration 045). */
  clientName: string
  /** The client's `city`, denormalized for the same reason. */
  area: string | null
  /** `yyyy-MM-dd` from the date input. */
  scheduledFor: string
  amountDue: number
  /** The admin publishing the store. */
  listedBy: string | null
}

export interface ListAdditionalStoreResult {
  error: string | null
  visitId: string | null
  /** How the notification fan-out went, so the dialog can say what happened. */
  sms: {
    /** Whether the SMS provider is wired at all (false while BusyBee is stubbed). */
    configured: boolean
    /** Active collectors we found a dialable number for. */
    recipients: number
    sent: number
    failed: number
  }
}

/** Verifies the signed-in caller may manage Collection. Returns null when OK. */
async function requireCollectionAdmin(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return 'Not authenticated.'

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, admin_scope')
    .eq('user_id', user.id)
    .single()

  if (!canManageCollection(profile?.role as UserRole | undefined, profile?.admin_scope as AdminScope | undefined)) {
    return 'Only a Collection admin can add an additional store.'
  }
  return null
}

/** Store fields the SMS draws on, read from the client row at send time. */
interface AdditionalStoreDetails {
  companyName: string
  contactPerson: string | null
  contactPosition: string | null
  /** The STORE's number (for calling ahead), not the collector's. */
  contactNumber: string | null
  officeAddress: string | null
  landmark: string | null
  city: string | null
  province: string | null
  /** `yyyy-MM-dd` collection day. */
  scheduledFor: string
}

/**
 * The SMS copy for an additional store, broadcast to every active collector.
 *
 * Two hard constraints shape it:
 *
 *  1. GSM-7 only. A single non-GSM character (₱, an em dash, a smart quote) flips
 *     the whole message to UCS-2, which more than halves the per-segment budget
 *     (70 vs 160) and multiplies cost. So amounts read `PHP` not `₱`, separators
 *     are plain `-`, and nothing here is smart-punctuated. It runs to a few
 *     segments now that it carries the full store detail — that is the trade the
 *     business asked for (informative over one-segment).
 *
 *  2. No amount due. The figure the store owes is deliberately kept from
 *     collectors (2026-07-25 anchoring-bias decision — they were matching the
 *     shown number instead of counting the cash) and must not leak through this
 *     side channel. Everything else identifying and locating the store is fair
 *     game; the money is not.
 *
 * Fields that come back null (no landmark, no store number) are skipped rather
 * than printed empty, so the message stays clean for sparse client rows.
 */
function additionalSmsBody(d: AdditionalStoreDetails): string {
  const lines: string[] = ['Oracle Collection - new additional store to collect:', d.companyName]

  const who = [d.contactPerson, d.contactPosition].filter(Boolean).join(', ')
  const contact = [who, d.contactNumber].filter(Boolean).join(' - ')
  if (contact) lines.push(`Contact: ${contact}`)

  const location = [d.officeAddress, d.landmark, d.city, d.province].filter(Boolean).join(', ')
  if (location) lines.push(`Location: ${location}`)

  lines.push(`Collect on: ${format(new Date(`${d.scheduledFor}T12:00:00`), 'EEE, dd MMM yyyy')}`)
  lines.push('Open the app to take this store off the list.')

  return lines.join('\n')
}

export async function listAdditionalStore(
  input: ListAdditionalStoreInput
): Promise<ListAdditionalStoreResult> {
  const empty = { configured: smsConfigured(), recipients: 0, sent: 0, failed: 0 }

  const permError = await requireCollectionAdmin()
  if (permError) return { error: permError, visitId: null, sms: empty }

  const admin = createAdminClient()

  // Insert mirrors createVisit (lib/hooks/use-collection.ts), plus the flag.
  const { data: inserted, error: insertError } = await admin
    .from('collection_visits')
    .insert({
      client_id: input.clientId,
      client_name: input.clientName,
      area: input.area,
      status: 'pending',
      // Midday so the store lands on the intended day regardless of timezone —
      // see the note in createVisit.
      scheduled_for: new Date(`${input.scheduledFor}T12:00:00`).toISOString(),
      listed_by: input.listedBy,
      amount_due: input.amountDue,
      is_additional: true,
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    return { error: insertError?.message ?? 'Could not list the store.', visitId: null, sms: empty }
  }

  // Recipients: every active collector. The list is a shared pool — no store is
  // assigned — so the urgent add is broadcast to everyone who might work it.
  const { data: collectors, error: collectorsError } = await admin
    .from('profiles')
    .select('contact_number')
    .eq('role', 'collector')
    .eq('is_active', true)

  if (collectorsError) {
    // The store IS listed and mobile will still badge it; only the nudge failed.
    // Report success-with-a-caveat rather than pretending the whole thing broke.
    // Still logged — the admin's action succeeded, and this is the branch where
    // knowing the SMS never went out matters most.
    await logAdditionalStore(input, inserted.id, { ...empty, recipients: 0 })
    return {
      error: null,
      visitId: inserted.id,
      sms: { ...empty, recipients: 0 },
    }
  }

  // The message is the same for every collector, so build it once. Pull the
  // store's full detail from the client row — the input carries only name and
  // area, and the SMS now names the contact and full location too. A failed or
  // missing lookup falls back to the input, so the text still goes out named.
  const { data: client } = await admin
    .from('clients')
    .select('company_name, contact_person, contact_position, contact_number, office_address, landmark, city, province')
    .eq('id', input.clientId)
    .single()

  const body = additionalSmsBody({
    companyName: (client?.company_name as string | null) ?? input.clientName,
    contactPerson: (client?.contact_person as string | null) ?? null,
    contactPosition: (client?.contact_position as string | null) ?? null,
    contactNumber: (client?.contact_number as string | null) ?? null,
    officeAddress: (client?.office_address as string | null) ?? null,
    landmark: (client?.landmark as string | null) ?? null,
    city: (client?.city as string | null) ?? input.area,
    province: (client?.province as string | null) ?? null,
    scheduledFor: input.scheduledFor,
  })

  const requests: SmsRequest[] = []
  for (const c of collectors ?? []) {
    const to = toE164(c.contact_number as string | null)
    if (to) requests.push({ to, body })
  }

  const results = await sendSmsBatch(requests)
  const sent = results.filter(r => r.ok).length

  await logAdditionalStore(input, inserted.id, {
    configured: smsConfigured(),
    recipients: requests.length,
    sent,
    failed: requests.length - sent,
  })

  return {
    error: null,
    visitId: inserted.id,
    sms: {
      configured: smsConfigured(),
      recipients: requests.length,
      sent,
      failed: requests.length - sent,
    },
  }
}

/**
 * The audit entry for an additional store.
 *
 * Separate from the plain `collection_visit.listed` that `createVisit` writes,
 * because the two are different acts: this one interrupts collectors mid-day
 * with an SMS. Whether that fan-out actually reached anyone is the part someone
 * asks about afterwards ("we listed it, why did nobody go?"), so the delivery
 * counts ride along in `metadata` — the SMS result is not stored anywhere else.
 */
async function logAdditionalStore(
  input: ListAdditionalStoreInput,
  visitId: string,
  sms: ListAdditionalStoreResult['sms'],
): Promise<void> {
  await recordAuditLog({
    action: 'collection_visit.listed_additional',
    entityTable: 'collection_visits',
    entityId: visitId,
    entityLabel: input.clientName,
    summary:
      `Listed ${input.clientName} as an additional collection for ${input.scheduledFor}` +
      (sms.configured ? ` — SMS to ${sms.sent}/${sms.recipients} collectors` : ''),
    changes: [
      { field: 'scheduled_for', label: 'Scheduled for', from: null, to: input.scheduledFor },
      { field: 'amount_due', label: 'Amount due', from: null, to: peso(input.amountDue) },
      { field: 'area', label: 'Area', from: null, to: input.area },
    ],
    metadata: { sms },
  })
}
