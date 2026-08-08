'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canManageCollection } from '@/lib/permissions'
import { sendSmsBatch, toE164, smsConfigured, type SmsRequest } from '@/lib/collection/busybee'
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

/**
 * The SMS copy. PLACEHOLDER until the final wording is confirmed with the
 * business — kept to one 160-char segment and naming the store so a collector
 * glancing at a lock screen knows where to go. Change the text here, in one
 * place, when the copy is signed off.
 */
function additionalSmsBody(storeName: string): string {
  const base = `Oracle: additional collection added — ${storeName}. Open the app for details.`
  return base.length <= 160 ? base : `${base.slice(0, 157)}…`
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
    return {
      error: null,
      visitId: inserted.id,
      sms: { ...empty, recipients: 0 },
    }
  }

  const requests: SmsRequest[] = []
  for (const c of collectors ?? []) {
    const to = toE164(c.contact_number as string | null)
    if (to) requests.push({ to, body: additionalSmsBody(input.clientName) })
  }

  const results = await sendSmsBatch(requests)
  const sent = results.filter(r => r.ok).length

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
