export type UserRole = 'superadmin' | 'admin' | 'sales_manager' | 'sales_specialist' | 'rsr' | 'collector' | 'delivery'

/**
 * Which business function an admin covers (migration 024). Only meaningful for
 * role 'admin' — everyone else is 'all'. Deliberately not part of UserRole: the
 * role column is shared with the mobile app, this column is web-only.
 */
export type AdminScope = 'all' | 'sales' | 'collection' | 'delivery'
export type CustomerType = 'existing' | 'new' | 'prospect'
export type SalesChannel = 'distributor' | 'dealer' | 'end_user' | 'private_label'
export type ClientStatus = 'active' | 'lost' | 'deleted'
export type MeetingType = 'f2f' | 'online'
export type OnlinePlatform = 'zoom' | 'googlemeet'
export type LocationType = 'client_office' | 'other'
export type MeetingOutcome = 'successful' | 'follow_up' | 'no_decision' | 'lost_opportunity'
export type ClockType = 'office' | 'event'
export type ClockAction = 'in' | 'out'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

/**
 * Collection module (F-007). Spec'd with the client at the 2026-07-03 meeting,
 * revised 2026-07-25, and revised again 2026-07-26; see Features.md F-007,
 * Meeting-2026-07-25-Collection-Delivery.md, and
 * Wireframe-Collection-Delivery-BizLink.html in the vault.
 *
 * A CollectionVisit spans both halves of the module, because it is one record
 * with two authors:
 *
 *  - the **Collection Admin**, on web, creates it — picks the store, the
 *    collection day, and the amount due, publishing the "daily electronic
 *    collection list" of the July 3 spec. Crucially the admin does NOT pick a
 *    collector: the list is a shared pool, not a per-person route.
 *  - the **collector**, on the phone, closes it — takes the store off the list
 *    and records payment method, the amount actually received, two proof
 *    photos, GPS, timestamp. Their identity lands on the row at that moment.
 *
 * `amount_due` is the clearest expression of that split: the admin sets it here
 * and it is deliberately NOT shown on the collector's Collect Payment screen
 * (2026-07-25 anchoring-bias decision — collectors were matching the displayed
 * figure instead of counting what was handed over). Web keeps it because
 * reconciling received-against-owed is exactly the admin's job.
 *
 * ⚠️ The vault currently disagrees with itself about Counter. The BizLink
 * wireframe (2026-07-26, vault PR #6) made it a payment METHOD and deleted the
 * dedicated `c-counterPhoto` slot; the spec-of-record wireframe, Features.md
 * F-007, and the planned-schema notes in Database.md all still describe it as a
 * separate required photo. We follow the newer wireframe per the vault's
 * newest-wins convention. If Ced reconciles the other three the other way, this
 * reverts to a `counter_photo_url` field and a third required capture.
 *
 * Nothing here is in the database yet — no collection tables exist as of
 * migration 024 — so this currently backs mock data only.
 */
export type PaymentMethod = 'cash' | 'check' | 'gcash' | 'counter'

/** Where a collector hands off the money they're holding. */
export type RemittanceDestination = 'office' | 'bayad_center' | 'bank_deposit'

export type CollectionVisitStatus = 'collected' | 'rescheduled' | 'pending'

export type RemittanceStatus = 'submitted' | 'reconciled' | 'variance'

export interface CollectionVisit {
  id: string
  client_id: string
  status: CollectionVisitStatus

  // --- Put on the day's list by the Collection Admin (web) ------------------

  /** The collection day this store sits on. Drives the collector's daily list. */
  scheduled_for: string
  /** Admin profile who put this store on the list. */
  listed_by: string | null
  listed_at: string
  /**
   * What the store owes, in PHP, as known to the office. Admin-entered and
   * withheld from the collector — see the module note above.
   */
  amount_due: number

  // --- Captured by the collector on the phone -------------------------------

  /**
   * Who actually worked this store — recorded when they collect, NOT chosen in
   * advance. The daily list is a shared pool: the admin publishes the stores and
   * their amounts, and any collector works it down (the mobile wireframe's
   * `cStores` carries no collector field at all). Null while the store is still
   * pending, which is why this can't be an assignment.
   */
  collector_id: string | null
  /**
   * Exact amount typed by the collector to match the payment photo. Null when the
   * visit was rescheduled or is still pending. This is the figure reconciled
   * against remittance totals.
   */
  amount_collected: number | null
  payment_method: PaymentMethod | null
  /**
   * Photo of however the payment arrived — cash, check, GCash confirmation
   * screen, or the counter receipt. Camera-only, <=3MB. One slot whose meaning
   * follows `payment_method`, which is why Counter needs no photo field of its
   * own (2026-07-26 wireframe change).
   */
  payment_photo_url: string | null
  /**
   * Proof the receipt was handed to the customer, added 2026-07-25 (Addendum 3)
   * and still its own capture after the 2026-07-26 change. Required before the
   * collector's app will accept "✓ Collected", so a collected visit missing it
   * means the record predates the rule or reached us through a path that
   * skipped it — either way the admin needs to see the hole, not a blank space.
   */
  delivery_receipt_photo_url: string | null
  gps_lat: number | null
  gps_lng: number | null
  remarks: string | null
  /** Set when status is 'rescheduled' — the collection-day reschedule rule. */
  rescheduled_to: string | null
  visited_at: string | null
  created_at: string
  client?: Client
  collector?: Profile
}

/**
 * Delivery module (F-007). Modelled on the delivery screens in
 * Wireframe-Collection-Delivery-BizLink.html, which is the spec of record for
 * this flow — the vault's Features.md still lists delivery as open question
 * OQ-5, but that doc is stale; the flow was agreed with the client.
 *
 * Deliberately unlike Collection in one respect: there is NO GPS capture here.
 * The wireframe states it outright — "Walang GPS sa delivery module (per
 * confirmed scope) — timestamp + proof photo lang." Do not add GPS fields.
 */
export type DeliveryStatus = 'pending' | 'followup' | 'delivered'

export interface PurchaseOrder {
  id: string
  po_number: string
  client_id: string
  /** Delivery area, e.g. "Balanga". Coarser than an address — no GPS in scope. */
  area: string
  /** Free-text line items as captured on the PO, e.g. "12 × Engine Oil 1L". */
  items: string
  status: DeliveryStatus
  /**
   * Which day of the 3-day follow-up window this PO is on, 1-3. Set only when
   * status is 'followup'. A failed delivery attempt starts the countdown and
   * each subsequent failure advances it; an undelivered PO is auto-deleted once
   * the window expires, so day 3 is the last chance to act.
   */
  followup_day: number | null
  /** Name of whoever signed for the goods. Required to mark delivered. */
  receiver_name: string | null
  /** Camera-only capture of the delivered items / signed DR, compressed <=3MB. */
  proof_url: string | null
  delivered_at: string | null
  remarks: string | null
  /** Assigned delivery personnel — a profile with the `delivery` role (migration 023). */
  assigned_to: string
  created_at: string
  client?: Client
  assignee?: Profile
}

export interface Remittance {
  id: string
  collector_id: string
  destination: RemittanceDestination
  /** Total the collector declared they are handing over. */
  amount_remitted: number
  /** Sum of the visits this remittance covers — variance = remitted - collected. */
  amount_collected: number
  status: RemittanceStatus
  /** Name of the receiving officer. Required for destination 'office'. */
  receiver_name: string | null
  /** Photo of the signed acknowledgment / receipt (e.g. a 7-11 slip). */
  signed_proof_url: string | null
  /**
   * In-app signature pad capture from the receiving officer. Required before an
   * OFFICE remittance can submit (added 2026-07-16 per direct instruction).
   * Not required for bayad-center or bank-deposit destinations.
   */
  receiver_signature_url: string | null
  visit_ids: string[]
  submitted_at: string
  created_at: string
  collector?: Profile
}

export interface Profile {
  id: string
  user_id: string
  full_name: string
  email?: string
  role: UserRole
  /** Defaults to 'all'; may be absent on rows written before migration 024. */
  admin_scope?: AdminScope
  team_id: string | null
  is_active?: boolean
  avatar_url?: string | null
  created_at: string
}

export interface Team {
  id: string
  name: string
  manager_id: string
  created_at: string
}

export interface Client {
  id: string
  company_name: string
  contact_person: string
  contact_position: string | null
  contact_number: string
  office_address: string
  /**
   * ⚠️ NOT IN THE DATABASE YET. The live `clients` table has no coordinate
   * columns — verified against the deployed schema on 2026-07-24. The mobile
   * app does not capture a location when a client is created; adding that pin
   * is a planned change, and these fields are the shape it will fill.
   *
   * Until then anything reading from Supabase sees them undefined, so the Maps
   * page renders with no pins by design. Do NOT substitute meeting GPS
   * (`Meeting.gps_lat/gps_lng`) — that records where the agent stood during a
   * visit, which is not the client's address, and plotting it would assert a
   * location the data cannot support.
   */
  office_lat?: number
  office_lng?: number
  customer_type: CustomerType
  sales_channel: SalesChannel
  assigned_agent_id: string
  status: ClientStatus
  /** ⚠️ NOT IN THE DATABASE — replaced by the binary progress bar. See lib/client-progress.ts. */
  rating?: number
  lost_at: string | null
  reassignable_at: string | null
  created_at: string
  updated_at: string
  agent?: Profile

  // --- Columns mobile added that web had never modelled (live as of 2026-07-24) ---

  /** Structured address parts. Mobile captures these; `office_address` is the legacy single field. */
  address_line1?: string | null
  address_line2?: string | null
  landmark?: string | null
  province?: string | null
  city?: string | null
  /**
   * Deadline for completing the client's full details after a bare-bones
   * creation in the field — the client-lifecycle timing rule. Null once met.
   */
  details_deadline_at?: string | null
  details_completed_at?: string | null
  /** Free-text reason captured when a client is marked lost/inactive. */
  inactive_reason?: string | null
  /** Lowercased/trimmed company_name, maintained by mobile for duplicate detection. */
  normalized_company_name?: string | null
}

export interface ClientEditRequest {
  id: string
  client_id: string
  requested_by: string
  changes: Record<string, { old: unknown; new: unknown }>
  status: ApprovalStatus
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  client?: Client
  requester?: Profile
  reviewer?: Profile
}

export interface Meeting {
  id: string
  client_id: string
  agent_id: string
  recorded_by: string | null
  meeting_type: MeetingType
  online_platform: OnlinePlatform | null
  location_type: LocationType
  location_name: string | null
  gps_lat: number | null
  gps_lng: number | null
  photo_url: string | null
  agenda: string[]
  remarks: string | null
  outcome: MeetingOutcome
  contact_person: string
  contact_position: string | null
  meeting_date: string
  created_at: string
  client?: Client
  agent?: Profile
  recorder?: Profile

  // --- Start/end capture, added by mobile (live as of 2026-07-24) ---
  //
  // The pair of timestamps is what makes a real meeting duration computable —
  // previously the web Excel export had to approximate it. `end_gps_*` records
  // where the agent actually finished, which can differ from where they started.

  start_photo_url?: string | null
  start_captured_at?: string | null
  end_photo_url?: string | null
  end_captured_at?: string | null
  end_gps_lat?: number | null
  end_gps_lng?: number | null
}

export interface ClockRecord {
  id: string
  agent_id: string
  type: ClockType
  action: ClockAction
  gps_lat: number | null
  gps_lng: number | null
  photo_url: string | null
  event_name: string | null
  timestamp: string
  created_at: string
  agent?: Profile
}
