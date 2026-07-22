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
  ApprovalStatus,
  ClientStatus,
  ClockType,
  CustomerType,
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

export const CUSTOMER_TYPE_TONE: Record<CustomerType, BadgeTone> = {
  existing: 'brand',
  new: 'navy',
  prospect: 'amber',
}

export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  existing: 'Existing',
  new: 'New',
  prospect: 'Prospect',
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
  sales_manager: 'navy',
  sales_specialist: 'amber',
  rsr: 'purple',
  collector: 'neutral',
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

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  gcash: 'GCash',
}

/** Payment method is a taxonomy like sales channel, so it stays neutral. */
export const PAYMENT_METHOD_TONE: Record<PaymentMethod, BadgeTone> = {
  cash: 'neutral',
  check: 'neutral',
  gcash: 'neutral',
}

export const VISIT_STATUS_TONE: Record<CollectionVisitStatus, BadgeTone> = {
  collected: 'brand',
  rescheduled: 'amber',
  pending: 'neutral',
}

export const VISIT_STATUS_LABEL: Record<CollectionVisitStatus, string> = {
  collected: 'Collected',
  rescheduled: 'Rescheduled',
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

/**
 * Catch-all label lookup used by the client page's edit-request diffs, where the
 * field being rendered isn't known at the type level. Prefer the typed maps above.
 */
export const VALUE_LABEL: Record<string, string> = {
  ...CUSTOMER_TYPE_LABEL,
  ...CHANNEL_LABEL,
  ...CLIENT_STATUS_LABEL,
}
