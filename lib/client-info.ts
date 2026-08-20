import type { Client, OfficePinSource } from '@/types'

/**
 * Reading a client RECORD — the five fields the product treats as "client
 * information", plus where the client actually is.
 *
 * The five are fixed by the mobile Complete Info screen and its checklist
 * (`lib/client-progress.ts` there, from the a-detail wireframe): company name,
 * contact person (a decision-maker), contact number, office address, sales
 * channel. Both platforms must agree on what counts, because the 1-month
 * data-quality deadline (`details_deadline_at`) is measured against exactly
 * that list — a web surface inventing a sixth requirement would report a client
 * as incomplete that the phone considers done.
 */

/** A client's address, split so a surface can label each part for what it is. */
export interface ClientAddress {
  /** Street line as entered — often a fragment in the field ("Blk 1"). */
  line: string | null
  /** "Tanza, Cavite". Null when the record has no city or province. */
  locality: string | null
  /** Free-text landmark ("across the San Roque church"), when captured. */
  landmark: string | null
  /** Everything joined, for one-line surfaces. Null when nothing is on file. */
  full: string | null
}

/**
 * Compose a client's office address from whatever the record actually carries.
 *
 * Two generations of columns live side by side. `office_address` is the legacy
 * single free-text field, and it is the ONLY one mobile's Complete Info screen
 * writes today (its "OFFICE ADDRESS" input; see the T-006 note in that repo's
 * lib/db.ts). `address_line1/2` + `landmark` + `city` + `province` are the
 * structured columns migration 013 added, filled by sync from older rows and
 * largely empty otherwise.
 *
 * The parts are joined rather than chosen between, because what an agent types
 * in the field is frequently a fragment — a real row reads "Blk 1" — and that
 * scrap on its own tells an admin nothing. Locality is appended only when the
 * street line doesn't already name it, so a complete address isn't made to say
 * "…, Tanza, Cavite, Tanza, Cavite".
 */
export function clientAddress(client: Client): ClientAddress {
  const line =
    [client.office_address, client.address_line1, client.address_line2]
      .map(part => part?.trim())
      .filter((part): part is string => !!part)
      // Mobile writes one of these, sync may have written another; identical
      // values across the two generations are the same fact twice.
      .filter((part, i, all) => all.findIndex(p => p.toLowerCase() === part.toLowerCase()) === i)
      .join(', ') || null

  const locality = [client.city, client.province]
    .map(part => part?.trim())
    .filter((part): part is string => !!part)
    .join(', ') || null

  const landmark = client.landmark?.trim() || null

  const needsLocality = locality && !line?.toLowerCase().includes(locality.toLowerCase())

  return {
    line,
    locality,
    landmark,
    full: [line, needsLocality ? locality : null].filter(Boolean).join(', ') || locality || null,
  }
}

/** True when the client carries its own permanent office pin (migration 052). */
export function hasOfficePin(client: Client): boolean {
  return client.office_lat != null && client.office_lng != null
}

/**
 * Where the office pin came from, in words an admin can act on.
 *
 * Worth stating rather than showing a bare coordinate: an auto-captured pin is
 * only as good as the agent's claim that the meeting really was at the client's
 * office, while a manual one was placed deliberately. See the contract in
 * Office-Location-Spec-2026-07-29.md (vault).
 */
export function officePinSourceLabel(source: OfficePinSource | null | undefined): string {
  if (source === 'manual') return 'Set by the agent'
  if (source === 'client_office_meeting') return 'Captured at a Client Office visit'
  return 'Source not recorded'
}

/** One item of the shared five-field completeness checklist. */
export interface ClientInfoGap {
  key: 'company_name' | 'contact_person' | 'contact_number' | 'office_address' | 'sales_channel'
  label: string
}

/**
 * The fields still missing from a client record, in the mobile checklist's own
 * order and wording. Empty means the record is complete.
 *
 * This is a DATA-QUALITY gate, not progress: a client at 0 gaps can still be at
 * 0% progress, which is driven solely by whether a product presentation has
 * happened (see lib/client-progress.ts). Conflating the two was explicitly
 * rejected on 2026-07-11.
 */
export function clientInfoGaps(client: Client): ClientInfoGap[] {
  const checklist: { key: ClientInfoGap['key']; label: string; done: boolean }[] = [
    { key: 'company_name', label: 'Company name', done: !!client.company_name },
    { key: 'contact_person', label: 'Contact person', done: !!client.contact_person },
    { key: 'contact_number', label: 'Contact number', done: !!client.contact_number },
    { key: 'office_address', label: 'Office address', done: !!client.office_address },
    { key: 'sales_channel', label: 'Sales channel', done: !!client.sales_channel },
  ]
  return checklist.filter(item => !item.done).map(({ key, label }) => ({ key, label }))
}

/**
 * Whether a client may be put on a Collection or Delivery day list.
 *
 * Two gates, and both are about whether there is anything to deliver or collect
 * in the first place:
 *
 *  1. **They have actually ordered.** Only `new` and `existing` clients have.
 *     Promotion out of `in_progress` into `new` requires explicit PO/order
 *     evidence (DEC-009, meeting 2026-07-24; enforced by
 *     `po_confirmation_requests`), so a `prospect` or an `in_progress` client
 *     is by definition someone who has never bought anything. Listing one is a
 *     truck sent to a shop with no goods for it, or a collector sent for money
 *     nobody owes. Note the UI already reads `in_progress` as a qualified
 *     prospect — "Prospect - In Progress" in lib/status-styles.ts — so both
 *     stages are excluded together.
 *
 *  2. **They are still a live record.** `lost` and soft-`deleted` clients are
 *     out. A deleted client is invisible on every other surface (the Clients
 *     page filters it), and these two pickers were the only place it still
 *     showed up.
 *
 * Deliberately NOT applied to rows already on a list: a client can go lost
 * while a PO of theirs is still pending, and that stop must keep rendering.
 * This gates what can be ADDED, nothing else.
 */
export function isListableCustomer(client: Client): boolean {
  if (client.status !== 'active') return false
  return client.customer_type === 'new' || client.customer_type === 'existing'
}

/** The subset of `clients` the Collection and Delivery pickers may offer. */
export function listableCustomers(clients: Client[]): Client[] {
  return clients.filter(isListableCustomer)
}
