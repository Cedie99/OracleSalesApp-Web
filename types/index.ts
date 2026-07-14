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
