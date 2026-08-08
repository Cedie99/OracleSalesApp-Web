/**
 * Single source of truth for every status / role / channel pill in the admin web app.
 *
 * Before this module the same maps were copy-pasted across six page files
 * (`OUTCOME_STYLE` alone appeared three times, verbatim) and had drifted onto
 * dark-mode-tuned Tailwind shades — `text-yellow-400` on a white card is ~1.7:1
 * and fails WCAG outright. Every pill now resolves to one of the six badge
 * families defined in app/globals.css, all verified >=4.5:1 in both themes.
 *
 * Cross-platform contract: the semantic assignments below mirror the mobile
 * side's status tints (Design-System-Catalog.md §1 "Status badge tints") so a
 * "Lost Opportunity" pill reads red-soft on web and on the phone. If you change
 * a colour here, change it there too — that pairing is the whole point.
 */
import type {
  AdditionalAckState,
  ApprovalStatus,
  ClientStatus,
  ClockType,
  CustomerType,
  DeliveryStatus,
  MeetingOutcome,
  CollectionVisitStatus,
  PaymentMethod,
  RemittanceDestination,
  RemittanceStatus,
  SalesChannel,
  UserRole,
} from '@/types'

export type BadgeTone = 'brand' | 'navy' | 'purple' | 'amber' | 'red' | 'neutral'

/** Tailwind classes for a tone. Pair with <Badge variant="tone">. */
export const TONE_CLASS: Record<BadgeTone, string> = {
  brand: 'bg-[var(--badge-brand-bg)] text-[var(--badge-brand-fg)]',
  navy: 'bg-[var(--badge-navy-bg)] text-[var(--badge-navy-fg)]',
  purple: 'bg-[var(--badge-purple-bg)] text-[var(--badge-purple-fg)]',
  amber: 'bg-[var(--badge-amber-bg)] text-[var(--badge-amber-fg)]',
  red: 'bg-[var(--badge-red-bg)] text-[var(--badge-red-fg)]',
  neutral: 'bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-fg)]',
}

/** Text-only variant, for stat-card numerals and icons that sit on the canvas. */
export const TONE_TEXT: Record<BadgeTone, string> = {
  brand: 'text-[var(--badge-brand-fg)]',
  navy: 'text-[var(--badge-navy-fg)]',
  purple: 'text-[var(--badge-purple-fg)]',
  amber: 'text-[var(--badge-amber-fg)]',
  red: 'text-[var(--badge-red-fg)]',
  neutral: 'text-[var(--badge-neutral-fg)]',
}

// --- Meeting outcome -------------------------------------------------------

export const OUTCOME_TONE: Record<MeetingOutcome, BadgeTone> = {
  successful: 'brand',
  follow_up: 'amber',
  no_decision: 'neutral',
  lost_opportunity: 'red',
}

export const OUTCOME_LABEL: Record<MeetingOutcome, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up Required',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost Opportunity',
}

/** Compact forms for dashboard chips, where the full label wraps. */
export const OUTCOME_LABEL_SHORT: Record<MeetingOutcome, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost',
}

// --- Client ----------------------------------------------------------------

/**
 * Ordered most-established first, matching the Clients page filter. `in_progress`
 * takes the one remaining unused tone — purple — which the Dashboard uses for its
 * own metric card. Record surfaces do NOT use it directly; see customerTypeBadge.
 */
export const CUSTOMER_TYPE_TONE: Record<CustomerType, BadgeTone> = {
  existing: 'brand',
  new: 'navy',
  in_progress: 'purple',
  prospect: 'amber',
}

export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  existing: 'Existing',
  new: 'New',
  in_progress: 'In Progress',
  prospect: 'Prospect',
}

/**
 * How a client's stage reads on a *record* surface — a row in the Clients table,
 * the detail dialog, the map's selected-client badge.
 *
 * In Progress renders as a qualified prospect ("Prospect · In Progress") in the
 * prospect tone, rather than as a fourth peer pill. The distinction is real —
 * migration 040 will not advance a client to New from anything but 'in_progress'
 * — but at record level the question an admin is asking is "customer, or not
 * yet", and a fourth colour in that vocabulary costs more than it explains.
 *
 * Deliberately NOT how the Dashboard renders it. There the count IS the subject
 * (in-progress is the near-term pipeline: a successful qualifying meeting has
 * happened and only the PO is outstanding), so it keeps its own card, its own
 * purple, and its own Success Rate row.
 */
export function customerTypeBadge(type: CustomerType): { tone: BadgeTone; label: string } {
  if (type !== 'in_progress') return { tone: CUSTOMER_TYPE_TONE[type], label: CUSTOMER_TYPE_LABEL[type] }
  return {
    tone: CUSTOMER_TYPE_TONE.prospect,
    label: `${CUSTOMER_TYPE_LABEL.prospect} · ${CUSTOMER_TYPE_LABEL.in_progress}`,
  }
}

/**
 * Sales channel is a taxonomy, not a lifecycle state — nothing about being a
 * "Dealer" is more urgent than being a "Distributor". So it renders neutral.
 *
 * This is deliberate, and it was a bug fix: channel pills sit directly beside
 * customer-type pills on the Clients page, and with both dimensions coloured a
 * prospect/end-user client showed two identical amber pills side by side, which
 * read as one repeated fact. Colour is reserved for status (customer type,
 * client status, outcome, approval) so the eye lands on the thing that changes.
 */
export const CHANNEL_TONE: Record<SalesChannel, BadgeTone> = {
  distributor: 'neutral',
  dealer: 'neutral',
  end_user: 'neutral',
  private_label: 'neutral',
}

export const CHANNEL_LABEL: Record<SalesChannel, string> = {
  distributor: 'Distributor',
  dealer: 'Dealer',
  end_user: 'End-User',
  private_label: 'Private Label',
}

export const CLIENT_STATUS_TONE: Record<ClientStatus, BadgeTone> = {
  active: 'brand',
  lost: 'red',
  deleted: 'neutral',
}

export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  active: 'Active',
  lost: 'Lost',
  deleted: 'Deleted',
}

// --- Approvals -------------------------------------------------------------

export const APPROVAL_TONE: Record<ApprovalStatus, BadgeTone> = {
  pending: 'amber',
  approved: 'brand',
  rejected: 'red',
}

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

// --- Users -----------------------------------------------------------------

export const ROLE_TONE: Record<UserRole, BadgeTone> = {
  superadmin: 'brand',
  admin: 'brand',
  // Executive shares navy with sales_manager, and collector shares neutral with
  // delivery: five usable tones cover eight roles, so pairs that are the same
  // kind of thing share one. Executive and sales_manager both read other
  // people's work rather than logging their own; collector and delivery are both
  // mobile operations support. The label and icon distinguish each pair, so the
  // colour doesn't need to.
  executive: 'navy',
  sales_manager: 'navy',
  sales_specialist: 'amber',
  rsr: 'purple',
  collector: 'neutral',
  delivery: 'neutral',
}

/**
 * Tone for a role string that came out of the database. Unknown roles render
 * neutral rather than resolving to `undefined` and silently dropping the pill's
 * background — see the note on `roleLabel` in lib/permissions.ts.
 */
export function roleTone(role: string | null | undefined): BadgeTone {
  return ROLE_TONE[role as UserRole] ?? 'neutral'
}

export const PLATFORM_TONE = {
  web: 'navy',
  mobile: 'brand',
} as const satisfies Record<string, BadgeTone>

// --- Clock records ---------------------------------------------------------

export const CLOCK_TYPE_TONE: Record<ClockType, BadgeTone> = {
  office: 'navy',
  event: 'purple',
}

export const CLOCK_TYPE_LABEL: Record<ClockType, string> = {
  office: 'Office',
  event: 'Event',
}

// --- Collection (F-007) ----------------------------------------------------

/** Every payment method, in the order the collector's app tiles them. */
export const PAYMENT_METHODS: PaymentMethod[] = [
  'cash', 'check', 'gcash', 'counter', 'delivery_receipt',
]

/**
 * 'counter' means the customer paid over the counter and the collector
 * photographed that receipt — it became a payment method on 2026-07-26, having
 * previously been a separate proof capture. 'delivery_receipt' (2026-08-01,
 * migration 061) is the same idea a step further: the delivery receipt settles
 * the balance and no cash is handed over at all. See the note on PaymentMethod.
 */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  gcash: 'GCash',
  counter: 'Counter',
  delivery_receipt: 'Delivery Receipt',
}

/** Payment method is a taxonomy like sales channel, so it stays neutral. */
export const PAYMENT_METHOD_TONE: Record<PaymentMethod, BadgeTone> = {
  cash: 'neutral',
  check: 'neutral',
  gcash: 'neutral',
  counter: 'neutral',
  delivery_receipt: 'neutral',
}

/**
 * Label for a method that may not be one we know about. The database is shared
 * with mobile, which can ship a value before web widens the union — so anything
 * rendering a method straight off a row goes through this rather than indexing
 * PAYMENT_METHOD_LABEL and trusting the result. An unknown value renders
 * readably instead of blank, and tells whoever sees it what to grep for.
 */
export function paymentMethodLabel(method: string | null): string {
  if (!method) return '—'
  return PAYMENT_METHOD_LABEL[method as PaymentMethod] ?? method.replace(/_/g, ' ')
}

/**
 * One scale across both operational modules: **brand = done, amber = still to
 * do, navy = deferred, red = went wrong.**
 *
 * `pending` was `neutral` here and `navy` on Delivery — two modules disagreeing
 * about the same idea. Worse, neutral's foreground is a dark slate that at
 * status-dot size is nearly indistinguishable from the brand green, so a
 * finished store and an untouched one looked alike on the day board. Amber is
 * what the rest of the card already uses for outstanding work (the "N left"
 * badge, the "Still out" figure), so pending now matches it.
 *
 * `rescheduled` moves to navy to keep amber meaning exactly one thing. It is a
 * deferral, not a shortfall — the store is someone else's problem on another
 * day — so it should not compete with the stores still owed today.
 */
export const VISIT_STATUS_TONE: Record<CollectionVisitStatus, BadgeTone> = {
  collected: 'brand',
  rescheduled: 'navy',
  pending: 'amber',
  // Purple, not amber, so a store mid-payment reads as its own state rather than
  // blurring into the untouched pending pool — a partial has money in and a
  // balance still out, which is neither "not started" nor "done". Purple already
  // means "in progress" elsewhere in this app (a client's in_progress stage), so
  // the vocabulary carries over. Migration 070.
  partial: 'purple',
}

export const VISIT_STATUS_LABEL: Record<CollectionVisitStatus, string> = {
  collected: 'Collected',
  rescheduled: 'Rescheduled',
  pending: 'Pending',
  partial: 'Partial',
}

/**
 * The "additional store" notice, tracked as it reaches the field (migrations
 * 068/069). Same done/now/deferred scale as VISIT_STATUS_TONE: viewed = brand
 * (it landed and a collector opened it), delivered = navy (on a phone, not yet
 * opened), pending = amber (still trying to reach a phone — the one an admin may
 * have to chase by calling). The "Additional" tag itself renders purple, a tone
 * no collection status uses, so an urgent add stands out from the day's list.
 */
export const ADDITIONAL_ACK_TONE: Record<AdditionalAckState, BadgeTone> = {
  viewed: 'brand',
  delivered: 'navy',
  pending: 'amber',
}

export const ADDITIONAL_ACK_LABEL: Record<AdditionalAckState, string> = {
  viewed: 'Viewed',
  delivered: 'Delivered',
  pending: 'Pending',
}

/** `variance` is red on purpose — a cash shortfall is the one thing an admin must not miss. */
export const REMITTANCE_STATUS_TONE: Record<RemittanceStatus, BadgeTone> = {
  reconciled: 'brand',
  submitted: 'navy',
  variance: 'red',
}

export const REMITTANCE_STATUS_LABEL: Record<RemittanceStatus, string> = {
  reconciled: 'Reconciled',
  submitted: 'Submitted',
  variance: 'Variance',
}

export const REMITTANCE_DESTINATION_LABEL: Record<RemittanceDestination, string> = {
  office: 'Office',
  bayad_center: '7-11 / Bayad Center',
  bank_deposit: 'Bank Deposit',
}

// --- Delivery (F-007) ------------------------------------------------------

/**
 * Failed is red, and it is the only red on this page: under the one-day rule a
 * failed delivery is the single outcome that needs someone in the office to act
 * — the goods are back in the warehouse and nothing re-lists itself.
 */
/** Same scale as VISIT_STATUS_TONE — see the note there. */
export const DELIVERY_STATUS_TONE: Record<DeliveryStatus, BadgeTone> = {
  delivered: 'brand',
  failed: 'red',
  pending: 'amber',
}

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  delivered: 'Delivered',
  failed: 'Failed delivery',
  pending: 'Pending',
}

/**
 * The payment tiles a driver sees on a COD stop. Collection's fourth method,
 * 'counter', is deliberately absent — it means the customer paid at their own
 * counter, which has no meaning when goods are being handed over at the door.
 */
export const COD_METHODS: PaymentMethod[] = ['cash', 'check', 'gcash']

/**
 * Catch-all label lookup used by the client page's edit-request diffs, where the
 * field being rendered isn't known at the type level. Prefer the typed maps above.
 */
export const VALUE_LABEL: Record<string, string> = {
  ...CUSTOMER_TYPE_LABEL,
  ...CHANNEL_LABEL,
  ...CLIENT_STATUS_LABEL,
}
