/**
 * Every value `profiles.role` may hold, matching the CHECK constraint as of
 * migration 027.
 *
 * `executive` is mobile-only and read-only end-to-end — it creates, edits, and
 * approves nothing, it just reads dashboards, reports, and maps across every
 * team. Web knows about it purely so a superadmin can issue and find the
 * account; there are no executive screens on this side.
 *
 * Adding a value here is not optional bookkeeping. This union feeds several
 * exhaustive Records (ROLE_LABEL, ROLE_TONE, ROLE_ICON, ROLE_DESCRIPTION), and
 * a role the database allows but this list omits reaches the UI as `undefined`
 * lookups — which is exactly how a live executive account hard-crashed the
 * Users page on 2026-07-24, before those lookups grew fallbacks.
 */
export type UserRole = 'superadmin' | 'admin' | 'executive' | 'sales_manager' | 'sales_specialist' | 'rsr' | 'collector' | 'delivery'

/**
 * Which business function an admin covers (migration 024). Only meaningful for
 * role 'admin' — everyone else is 'all'. Deliberately not part of UserRole: the
 * role column is shared with the mobile app, this column is web-only.
 */
export type AdminScope = 'all' | 'sales' | 'collection' | 'delivery'
/**
 * The client lifecycle, four stages since migration 038 widened the check
 * constraint (`prospect → in_progress → new → existing`) and 040 split the old
 * promote_client_to_new() into two stage-specific functions. Both were applied
 * by hand on 2026-07-27 and back-filled into supabase/migrations/.
 *
 * `in_progress` is written by the database, never by web: entering it also
 * stamps `clients.in_progress_at`, which the close-deal trigger reads to stop
 * one meeting from chaining both transitions. Web reads and displays the stage;
 * it does not assign it.
 *
 * The column is also NULLABLE (migration 013, mobile's two-phase Create Client —
 * Phase A inserts a company name and nothing else). Rows enter the app through
 * `normalizeClient` in lib/hooks/use-clients.ts, which resolves that null the
 * same way migration 040's own guards do, so this stays non-nullable here.
 */
export type CustomerType = 'existing' | 'new' | 'in_progress' | 'prospect'
export type SalesChannel = 'distributor' | 'dealer' | 'end_user' | 'private_label'
export type ClientStatus = 'active' | 'lost' | 'deleted'
/**
 * How a client's permanent office pin came to be set — the CHECK constraint in
 * migration 052. See `Client.office_lat`.
 */
export type OfficePinSource = 'manual' | 'client_office_meeting'
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
 *
 * 'delivery_receipt' was added by mobile on 2026-08-01 and widened into the DB
 * CHECK by migration 061: the delivery receipt itself settles the balance, so no
 * cash changes hands at the visit. Like Counter it takes the payment photo only
 * and no amount — mobile writes `amount_collected = 0` for both, which is the
 * honest value rather than a null.
 *
 * ⚠️ This union is NOT a guarantee about what the database holds. It is what web
 * knows about, and mobile can ship a new value before we do — that is exactly
 * how 'delivery_receipt' arrived, and how an `executive` role once crashed the
 * Users page. Anything keying a Record off this union must tolerate a miss.
 */
export type PaymentMethod = 'cash' | 'check' | 'gcash' | 'counter' | 'delivery_receipt'

/** Where a collector hands off the money they're holding. */
export type RemittanceDestination = 'office' | 'bayad_center' | 'bank_deposit'

export type CollectionVisitStatus = 'collected' | 'rescheduled' | 'pending'

export type RemittanceStatus = 'submitted' | 'reconciled' | 'variance'

export interface CollectionVisit {
  id: string
  client_id: string
  /**
   * Customer name copied onto the row when the admin published it (migration
   * 045). Exists because the `collector` role has no RLS read on `clients`, so
   * the phone cannot resolve `client_id` to a name on its own.
   *
   * Web should keep reading `client?.company_name` — that reflects the customer
   * as they are NOW. This is what the row said on the day it was published, and
   * the two diverge if a customer is renamed. Null on rows published before 045.
   */
  client_name: string | null
  /**
   * Locality copied from `clients.city` at publish time, for the same reason as
   * `client_name`. Collection has no admin-entered area field — unlike delivery,
   * where the admin types one.
   */
  area: string | null
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
   * The collector currently EN ROUTE to this store (migration 046) — distinct
   * from `collector_id`, which is who actually worked it. A claim is a hard
   * lock: nobody else may work the store while this is set. One active claim
   * per collector, enforced by a partial unique index on pending rows, so
   * completing a store frees the slot automatically.
   *
   * Never expires. Cleared by the claimer or by an admin. Deliberately survives
   * completion as history — the index predicate already frees the slot.
   */
  claimed_by: string | null
  claimed_at: string | null
  /**
   * Claimer's name copied onto the row, for the same reason as `client_name`:
   * a collector can read only their own `profiles` row (migration 003), so the
   * phone cannot resolve another collector's `claimed_by` to a name.
   */
  claimed_by_name: string | null
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
  /**
   * The customer's acknowledgment signature, drawn on the collector's phone
   * (migration 061). Mobile requires it on every payment method before it will
   * accept "✓ Collected" — including counter and delivery_receipt, where it is
   * the only thing tying the settlement to the customer.
   *
   * Null on every visit collected before 2026-08-01, and on newer ones until the
   * deferred upload lands. It is therefore NOT yet counted as a required capture
   * by `hasMissingProof` — see the note in lib/collection.ts.
   */
  customer_signature_url: string | null
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
 * Wireframe-Collection-Delivery-BizLink.html and revised by the 2026-07-25
 * session (Meeting-2026-07-25-Collection-Delivery.md and its five addenda).
 *
 * Structurally this is Collection with different nouns, and deliberately so —
 * one record, two authors:
 *
 *  - the **Delivery Admin**, on web, lists the PO for a delivery day (customer,
 *    area, items, and whether it is COD). That is the trip list.
 *  - the **driver**, on the phone, closes it — plate number, proof photo, an
 *    outcome, and the COD payment if there is one. Their name, their truck's
 *    plate, and the stop's sequence number all land on the row at that moment.
 *
 * Two things separate it from Collection:
 *
 *  1. **The COD amount IS shown to the driver**, the exact opposite of the
 *     anchoring-bias rule that hides `amount_due` from collectors. A COD figure
 *     is the fixed price of goods being handed over, not a negotiable balance
 *     (2026-07-25 COD addendum, flagged there as a judgment call).
 *  2. **Proof is lighter.** A photo plus a "Delivered" remark is enough;
 *     receiver name and signature are both optional, because customers often
 *     refuse to give a name.
 *
 * ⚠️ GPS reversal (2026-07-27). Earlier passes of this file said outright "no
 * GPS in the delivery module — do not add GPS fields; their absence is the
 * decision, not a gap", sourced from the wireframe's "Walang GPS sa delivery
 * module (per confirmed scope)". That is superseded: the latest meeting asked
 * for Collection AND Delivery maps so the office can trace a collector's or
 * driver's trip across a day. The coordinates ride along with the image capture
 * that already happens at every stop, so this costs the driver no extra step —
 * which is why it was cheap enough to reverse.
 *
 * Nothing here is in the database — no delivery tables exist as of migration
 * 024 — so this backs mock data only.
 */

/**
 * A PO lives for exactly one delivery day (2026-07-27, direct instruction).
 * Either the driver hands it over that day, or the goods come back on the truck
 * and it is a failed delivery — there is no multi-day follow-up countdown.
 *
 * ⚠️ The wireframes and the mobile first draft still model a 3-day follow-up
 * window plus a separate `backload` status. Both are wrong here. The only
 * "3-day rule" the vault can source is Meeting-2026-06-24's CLIENT-lifecycle
 * auto-delete, which Meeting-2026-07-03 superseded with the 1-month rule — it
 * was never a delivery rule and leaked into the delivery screens. And a failed
 * delivery IS a backload: nothing was accepted, so the goods ride back. They are
 * one outcome, not two, which is why `backload_photo_url` is a capture on a
 * failed row rather than a status of its own.
 */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed'

export interface PurchaseOrder {
  id: string
  po_number: string
  client_id: string
  /**
   * Customer name copied onto the row at publish time (migration 045), because
   * the `delivery` role has no RLS read on `clients`. Same caveat as
   * `CollectionVisit.client_name`: point-in-time, so web keeps using
   * `client?.company_name` for current state. Null on rows published before 045.
   */
  client_name: string | null
  /**
   * Delivery area, e.g. "Balanga". Coarser than an address — no GPS in scope,
   * and with the customer name it is the whole of what the admin lists. There
   * is deliberately no line-items field: the trip ticket carries customer +
   * plate, not an itemised manifest (2026-07-25 "kept deliberately simple",
   * confirmed 2026-07-27 for the admin side).
   */
  area: string
  status: DeliveryStatus

  // --- Put on a delivery day's trip list by the Delivery Admin (web) ---------

  /** The delivery day this PO sits on. Drives the driver's PO list. */
  scheduled_for: string
  /** Admin profile who put this PO on the list. */
  listed_by: string | null
  listed_at: string
  /**
   * Cash on delivery, a per-PO toggle rather than a mode the whole module runs
   * in (2026-07-25). Non-COD deliveries skip the payment step entirely.
   */
  cod: boolean
  /** What the driver collects on a COD stop. Null on non-COD POs. */
  cod_due: number | null

  // --- Captured by the driver on the phone ----------------------------------

  /**
   * Who actually ran this stop — recorded when they deliver, NOT chosen in
   * advance, exactly as with `CollectionVisit.collector_id`. Null while the PO
   * is still waiting, which is why this can't be an assignment.
   */
  driver_id: string | null
  /**
   * The driver currently EN ROUTE to this stop (migration 046) — the delivery
   * twin of `CollectionVisit.claimed_by`, same hard-lock and one-claim rules.
   * See that field for the full reasoning.
   */
  claimed_by: string | null
  claimed_at: string | null
  /** Claimer's name, denormalized — drivers can't read other `profiles` rows. */
  claimed_by_name: string | null
  /**
   * The truck's plate, typed by the driver at the stop. Paired with the customer
   * name, this is the whole of the "trip ticket" data the client asked for — a
   * full itemised trip ticket with a PO reference was explicitly deferred.
   */
  truck_plate: string | null
  /**
   * Position in the day's run, 1-based. Assigned at the moment of delivery from
   * the order the driver actually visits stops, mirroring the paper process —
   * it is NOT a pre-planned route the office hands down.
   */
  sequence_no: number | null
  /**
   * Who took the goods. Optional since 2026-07-25 — many customers refuse to
   * give a name, which is exactly why the signature below carries the weight.
   */
  receiver_name: string | null
  /**
   * The receiving party's signature, taken on the driver's phone. This is the
   * paper Trip Report's "COMPANY REPRESENTATIVE'S SIGNATURE" column, which is
   * signed on every row — so treat it as the expected proof that a human at the
   * customer took delivery, not an extra. Still never blocking on the phone.
   */
  receiver_signature_url: string | null
  /**
   * Arrival and departure at the stop, straight off the paper Trip Report's
   * TIME-IN / TIME-OUT columns — the driver writes both today, so the app has to
   * capture both. The gap between them is the dwell at the customer (5–15
   * minutes in the sheets we've seen) and it is the only measure of how long a
   * stop actually took.
   *
   * Both are set on a failed delivery too: the truck still arrived, waited, and
   * left. `time_out` doubles as the moment the stop closed out.
   */
  time_in: string | null
  time_out: string | null
  /** Camera-only capture of the delivered items / signed DR, compressed <=3MB. */
  proof_url: string | null
  /**
   * Camera-only capture of the goods riding back, required before the driver's
   * app will log a failed delivery at all — it documents what actually returned.
   * So a failed row without one arrived through a path that skipped the rule,
   * and the admin needs to see the hole rather than a blank space.
   */
  backload_photo_url: string | null
  /**
   * Where the truck actually stood when the driver captured the stop's photo —
   * the proof photo on a delivered stop, the backload photo on a failed one.
   * Added 2026-07-27 with the delivery map (see the GPS-reversal note above);
   * the fix comes free with the capture the driver already makes.
   *
   * Null on any stop nobody has reached, which is the same reason
   * `CollectionVisit.gps_lat` is null on a pending store: no photo, no fix. A
   * closed-out stop missing coordinates came through a path that skipped the
   * capture, and reads on the map as "no location" rather than as a gap in the
   * route.
   */
  gps_lat: number | null
  gps_lng: number | null
  remarks: string | null

  // --- COD payment, captured at the stop when `cod` is set -------------------
  //
  // The same payment step Collection uses: method tile, camera-only photo, exact
  // amount. 'counter' is not offered here — that method belongs to a store
  // paying at its own counter, which has no meaning on a delivery.

  cod_amount: number | null
  cod_method: PaymentMethod | null
  cod_photo_url: string | null
  /** True once this PO's COD money has been handed over in a remittance. */
  cod_remitted: boolean

  created_at: string
  client?: Client
  driver?: Profile
}

/**
 * A driver handing over the COD money they are holding.
 *
 * Reuses Collection's remittance pattern rather than inventing a second one, but
 * OFFICE-ONLY (2026-07-25, Addendum 4): the 7-11 and bank-deposit destinations
 * were removed from the driver's Remit screen, so there is no `destination`
 * field to choose and the receiver's in-app signature is always required —
 * unlike `Remittance`, where it is required for office only.
 */
export interface CodRemittance {
  id: string
  driver_id: string
  /** Total the driver declared they are handing over. */
  amount_remitted: number
  /** Sum of the COD payments this covers — variance = remitted - collected. */
  amount_collected: number
  status: RemittanceStatus
  /** Receiving officer at the office. */
  receiver_name: string
  /** Signature pad capture. Required — Office is the only destination. */
  receiver_signature_url: string | null
  po_ids: string[]
  submitted_at: string
  created_at: string
  driver?: Profile
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
   * The client's PERMANENT office pin — where the office/store actually is.
   *
   * Live since migration 052 (mobile Batch 4; contract:
   * Office-Location-Spec-2026-07-29.md in the vault). Written two ways only: an
   * agent explicitly setting it from Client Detail, or a meeting the agent
   * tagged as being at the Client Office, whose start GPS is then allowed to
   * stand in. Both are recorded in `office_pin_source`.
   *
   * Never derive this from anything else. Meeting GPS (`Meeting.gps_lat/lng`)
   * is where the AGENT stood during a visit — for an online meeting, nowhere
   * near the client — and the spec forbids inferring the pin from it, from an
   * address string, or from a geocode. A client with no pin simply has none.
   *
   * Most rows are still null: the columns are additive with no backfill.
   */
  office_lat?: number | null
  office_lng?: number | null
  /** How the pin was set — see `office_lat`. Null when there is no pin. */
  office_pin_source?: OfficePinSource | null
  /** Last write to the pin specifically, distinct from `updated_at`. */
  office_pin_updated_at?: string | null
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

export interface Notification {
  id: string
  /** Free-form event key, e.g. 'prospect_auto_deleted'. */
  type: string
  title: string
  message: string
  client_id: string | null
  /** Global read state — set once any admin has opened the panel, not per-admin. */
  read_at: string | null
  created_at: string
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

// --- Tag-along / companion requests (migrations 019-020, ADR-030) -----------
//
// An agent picks companions when creating a client or recording a meeting; the
// invitee accepts or declines from their phone. Web only ever reads these.
//
// The two invitee kinds are NOT interchangeable and must never be totalled
// together. A `manager` invitee is a validation gate: while the request is
// pending the meeting reserves no cutoff slot (it sits at `pending_validity` in
// the attribution ledger), and a decline excludes it permanently. A `teammate`
// invitee is shadowing or coaching — it gates nothing at all.

export type TagAlongContext = 'client_creation' | 'meeting'
export type TagAlongInviteeKind = 'manager' | 'teammate'
export type TagAlongStatus = 'pending' | 'accepted' | 'declined' | 'cancelled'

export interface TagAlongRequest {
  id: string
  context: TagAlongContext
  requester_id: string
  invitee_id: string
  invitee_kind: TagAlongInviteeKind
  related_client_id: string | null
  /** Non-null whenever `context` is 'meeting' — enforced by migration 020. */
  related_meeting_id: string | null
  status: TagAlongStatus
  created_at: string
  responded_at: string | null
  updated_at: string
  /** Resolved server-side; the FK targets `profiles.id`, not an auth uid. */
  requester_name?: string | null
  invitee_name?: string | null
  invitee_role?: UserRole | null
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

// --- Cutoff periods and quota attribution (migrations 057-060) ---------------
//
// Built by mobile (Batch 7A/7B) against the contract in the vault's
// Meeting-2026-07-31-Cutoff-Quota.md / Decisions.md ADR-053. Web reads both
// tables directly — admins have full SELECT on each — rather than through
// migration 060's RPCs, which are per-caller (get_my_cutoff_usage_summary) or
// per-client (get_client_cutoff_allowance) and so can't answer "show me every
// account at once", which is the only question the Maps quota lens asks.
//
// Migration 028's `quota_policy` is deliberately untouched by all of this and
// is NOT the source for any of it: it stays RSR-only, daily-target, legacy.

export type CutoffPeriodStatus = 'draft' | 'scheduled' | 'active' | 'closed' | 'superseded'

/**
 * An admin-defined cutoff period. Explicit start/end dates — periods are rows,
 * not derived from a rule, so an irregular or holiday-shifted cutoff is just a
 * different row.
 *
 * Immutable once live (contract O-8): an active or closed period is never
 * edited in place, it is superseded by a new row pointing back via
 * `supersedes_period_id`. Concurrently-live periods cannot overlap — a GiST
 * exclusion constraint rejects that at write time, so the UI should surface the
 * error rather than try to prevent every case itself.
 *
 * Targets are PER ROLE and independent (contract O-6): a null target means "not
 * configured for this role" and must render as such, never as zero and never as
 * a hardcoded fallback. `client_meeting_cap` is a different axis entirely — one
 * shared pool across new+existing, per client, per period.
 */
export interface CutoffPeriod {
  id: string
  label: string
  starts_on: string
  ends_on: string
  /** Period target for sales_specialist, in meetings per CUTOFF. Null = not configured. */
  sales_target: number | null
  /**
   * @deprecated Migration 063. Was a per-period number for rsr, which was the
   * wrong unit — an RSR is measured per working day. Use `rsr_daily_target`.
   * The column survives only because mobile's sync-down still selects it.
   */
  rsr_target: number | null
  /**
   * Target for rsr, in visits per WORKING DAY. The period expectation is this
   * times `workingDaysIn(period)`. Null = not configured for that role.
   */
  rsr_daily_target: number | null
  /**
   * Explicit working-day count, overriding weekdays-minus-holidays. For a
   * schedule the rule cannot express. Null means derive it.
   */
  working_days_override: number | null
  /** Per-client meeting ceiling: one pool shared across new and existing. */
  client_meeting_cap: number
  status: CutoffPeriodStatus
  supersedes_period_id: string | null
  version: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * How one meeting was classified against the cutoff rules.
 *
 * - `counted` — consumed a per-client slot and contributes to the role target.
 * - `over_cap` — valid and preserved, but the client's pool was already full.
 *   Excluded from BOTH the per-client allowance and the period target (O-3).
 *   This is the signal for "someone over-visited this account" — a client can
 *   never show more counted meetings than the cap, because the server refuses
 *   to allocate a slot rather than letting the number run over.
 * - `excluded_uncapped` — client was prospect/in_progress at the time: no slot
 *   consumed, but it still counts toward the agent's period target.
 * - `excluded_invalid` — outcome or evidence didn't qualify. Only Successful
 *   and Follow-up with a photo ever count.
 * - `pending_validity` — a manager tag-along confirmation is still open, so no
 *   slot is reserved yet. The only non-terminal value; re-decided when the
 *   request resolves.
 * - `unattributed` — no active period covered the meeting's start time. Counts
 *   toward nothing and is never automatically reassigned to a later period.
 */
/**
 * The standing quota numbers, and the one surface an admin edits (migration
 * 063). Single-row: the primary key can only hold `true`.
 *
 * Periods snapshot these at creation rather than reading them live, so changing
 * a target cannot rewrite what a finished cutoff was measured against.
 * `apply_standing_targets()` pushes a change forward to periods that have not
 * ended.
 */
export interface QuotaSettings {
  id: boolean
  /** Meetings per cutoff for sales_specialist. Null = not configured. */
  sales_target: number | null
  /** Visits per working day for rsr. Null = not configured. */
  rsr_daily_target: number | null
  /** The per-client ceiling. A limit, not a goal — see QuotaState. */
  client_meeting_cap: number
  updated_by: string | null
  updated_at: string
}

/** A company-wide non-working day. Weekends are derived, not stored. */
export interface Holiday {
  holiday_date: string
  label: string
  created_by: string | null
  created_at: string
}

/**
 * One field change on one period (migration 063), written only by
 * `apply_standing_targets()`. No client role may insert, which is the whole
 * point of an audit trail.
 */
export interface CutoffPeriodChange {
  id: string
  period_id: string
  changed_by: string | null
  changed_at: string
  field: string
  old_value: string | null
  new_value: string | null
}

export type CutoffAttribution =
  | 'counted'
  | 'over_cap'
  | 'excluded_uncapped'
  | 'excluded_invalid'
  | 'pending_validity'
  | 'unattributed'

/**
 * One row per meeting, written exclusively by `attribute_meeting_cutoff()`
 * inside an AFTER INSERT trigger. No client role has INSERT or UPDATE, which is
 * the entire integrity guarantee — web reads this and never derives its own
 * count from `meetings`, or the two would disagree.
 *
 * ⚠️ Meetings inserted BEFORE migration 059 went live have no row here at all.
 * The trigger only fires on insert and nothing backfills, so historical
 * meetings are absent rather than `unattributed`. Anything reporting on this
 * table has to say so instead of implying those visits never happened.
 */
export interface MeetingCutoffAttribution {
  meeting_id: string
  period_id: string | null
  client_id: string
  agent_id: string
  /** The client's lifecycle stage at attribution time, not necessarily now. */
  captured_client_stage: CustomerType | null
  attribution: CutoffAttribution
  /** 1-based slot consumed. Non-null exactly when attribution is 'counted'. */
  slot_index: number | null
  attributed_at: string
}
