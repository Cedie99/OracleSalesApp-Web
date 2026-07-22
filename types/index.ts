export type UserRole = 'superadmin' | 'admin' | 'sales_manager' | 'sales_specialist' | 'rsr' | 'collector'
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
 * Collection module (F-007). Spec'd with the client at the 2026-07-03 meeting;
 * see Features.md F-007 and Wireframe-Collection-Delivery-BizLink.html in the vault.
 *
 * These types describe what the *mobile* collector captures. Web is an oversight
 * surface only — superadmin/admin reconcile and export, they never record a
 * collection. Nothing here is in the database yet (no collection tables exist as
 * of migration 022) and no collector screens exist in the mobile app, so this
 * currently backs mock data only.
 */
export type PaymentMethod = 'cash' | 'check' | 'gcash'

/** Where a collector hands off the money they're holding. */
export type RemittanceDestination = 'office' | 'bayad_center' | 'bank_deposit'

export type CollectionVisitStatus = 'collected' | 'rescheduled' | 'pending'

export type RemittanceStatus = 'submitted' | 'reconciled' | 'variance'

export interface CollectionVisit {
  id: string
  collector_id: string
  client_id: string
  status: CollectionVisitStatus
  /** Amount due at the store for this visit, in PHP. */
  amount_due: number
  /**
   * Exact amount typed by the collector to match the payment photo. Null when the
   * visit was rescheduled or is still pending. This is the figure reconciled
   * against remittance totals.
   */
  amount_collected: number | null
  payment_method: PaymentMethod | null
  /** Camera-only capture, compressed <=3MB per spec. */
  photo_url: string | null
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
  office_lat?: number
  office_lng?: number
  customer_type: CustomerType
  sales_channel: SalesChannel
  assigned_agent_id: string
  status: ClientStatus
  rating?: number
  lost_at: string | null
  reassignable_at: string | null
  created_at: string
  updated_at: string
  agent?: Profile
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
