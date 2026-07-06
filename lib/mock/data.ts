import type { Profile, Client, Meeting, ClockRecord, ClientEditRequest, DashboardMetrics } from '@/types'

export const mockProfiles: Profile[] = [
  { id: 'agent-1', user_id: 'u1', full_name: 'Cyril Santos', role: 'sales_specialist', team_id: 'team-1', created_at: '2024-01-10T08:00:00Z' },
  { id: 'agent-2', user_id: 'u2', full_name: 'Jun Reyes', role: 'sales_specialist', team_id: 'team-1', created_at: '2024-01-12T08:00:00Z' },
  { id: 'agent-3', user_id: 'u3', full_name: 'Maria Dela Cruz', role: 'sales_specialist', team_id: 'team-2', created_at: '2024-02-01T08:00:00Z' },
  { id: 'mgr-1', user_id: 'u4', full_name: 'Sir Eric Mendoza', role: 'sales_manager', team_id: 'team-1', created_at: '2024-01-05T08:00:00Z' },
  { id: 'mgr-2', user_id: 'u5', full_name: 'Sir Mike Lim', role: 'sales_manager', team_id: 'team-2', created_at: '2024-01-05T08:00:00Z' },
  { id: 'admin-1', user_id: 'u6', full_name: 'Admin User', role: 'admin', team_id: null, created_at: '2024-01-01T08:00:00Z' },
  { id: 'rsr-1', user_id: 'u7', full_name: 'Reggie Pascual', role: 'rsr', team_id: 'team-1', created_at: '2024-02-10T08:00:00Z' },
  { id: 'rsr-2', user_id: 'u8', full_name: 'JP Villanueva', role: 'rsr', team_id: 'team-2', created_at: '2024-02-15T08:00:00Z' },
  { id: 'col-1', user_id: 'u9', full_name: 'Billy Gabi', role: 'collector', team_id: null, created_at: '2024-03-01T08:00:00Z' },
]

export const mockClients: Client[] = [
  {
    id: 'client-1', company_name: 'Oracle Petroleum', contact_person: 'Bong Aquino', contact_position: 'Procurement Manager',
    contact_number: '09171234567', office_address: '123 EDSA, Makati City', customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'agent-1', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-03-01T09:00:00Z', updated_at: '2024-06-01T09:00:00Z',
    agent: mockProfiles[0],
  },
  {
    id: 'client-2', company_name: 'San Basilica Beauty Corp', contact_person: 'Maricel Torres', contact_position: 'Owner',
    contact_number: '09281112222', office_address: 'Alabang, Muntinlupa', customer_type: 'new',
    sales_channel: 'dealer', assigned_agent_id: 'agent-1', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-05-10T09:00:00Z', updated_at: '2024-06-10T09:00:00Z',
    agent: mockProfiles[0],
  },
  {
    id: 'client-3', company_name: 'Bataan Industrial Supply', contact_person: 'Ramon Cruz', contact_position: 'CEO',
    contact_number: '09391234567', office_address: 'Mariveles, Bataan', customer_type: 'prospect',
    sales_channel: 'end_user', assigned_agent_id: 'agent-2', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-06-20T09:00:00Z', updated_at: '2024-06-20T09:00:00Z',
    agent: mockProfiles[1],
  },
  {
    id: 'client-4', company_name: 'Metro Fuel Distributors', contact_person: 'Lito Fernandez', contact_position: 'VP Sales',
    contact_number: '09451239876', office_address: 'Quezon City', customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'agent-3', status: 'lost',
    lost_at: '2024-06-10T00:00:00Z', reassignable_at: '2024-06-24T00:00:00Z', created_at: '2024-01-15T09:00:00Z', updated_at: '2024-06-10T09:00:00Z',
    agent: mockProfiles[2],
  },
  {
    id: 'client-5', company_name: 'Laguna Chemical Works', contact_person: 'Susan Ramos', contact_position: 'Director',
    contact_number: '09561237890', office_address: 'Calamba, Laguna', customer_type: 'new',
    sales_channel: 'end_user', assigned_agent_id: 'agent-2', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-04-20T09:00:00Z', updated_at: '2024-05-20T09:00:00Z',
    agent: mockProfiles[1],
  },
  {
    id: 'client-6', company_name: 'Starbucks Alabang', contact_person: 'Karen Go', contact_position: 'Area Manager',
    contact_number: '09671110000', office_address: 'Alabang Town Center', customer_type: 'prospect',
    sales_channel: 'private_label', assigned_agent_id: 'agent-3', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-06-18T09:00:00Z', updated_at: '2024-06-18T09:00:00Z',
    agent: mockProfiles[2],
  },
]

export const mockMeetings: Meeting[] = [
  {
    id: 'meet-1', client_id: 'client-1', agent_id: 'agent-1', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.5547, gps_lng: 121.0244, photo_url: null,
    agenda: ['New business opportunity', 'Price negotiation/quotation'],
    remarks: 'Client is interested in expanding the contract.', outcome: 'successful',
    contact_person: 'Bong Aquino', contact_position: 'Procurement Manager',
    meeting_date: '2024-06-25T10:00:00Z', created_at: '2024-06-25T10:05:00Z',
    client: mockClients[0], agent: mockProfiles[0],
  },
  {
    id: 'meet-2', client_id: 'client-2', agent_id: 'agent-1', recorded_by: 'mgr-1',
    meeting_type: 'f2f', online_platform: null, location_type: 'other', location_name: 'Starbucks Alabang',
    gps_lat: 14.4221, gps_lng: 121.0348, photo_url: null,
    agenda: ['Product/Company presentation', 'Relationship building'],
    remarks: 'First meeting. Client is receptive.', outcome: 'follow_up',
    contact_person: 'Maricel Torres', contact_position: 'Owner',
    meeting_date: '2024-06-24T14:00:00Z', created_at: '2024-06-24T14:10:00Z',
    client: mockClients[1], agent: mockProfiles[0], recorder: mockProfiles[3],
  },
  {
    id: 'meet-3', client_id: 'client-3', agent_id: 'agent-2', recorded_by: null,
    meeting_type: 'online', online_platform: 'zoom', location_type: 'client_office', location_name: null,
    gps_lat: null, gps_lng: null, photo_url: null,
    agenda: ['New business opportunity'],
    remarks: null, outcome: 'no_decision',
    contact_person: 'Ramon Cruz', contact_position: 'CEO',
    meeting_date: '2024-06-23T09:00:00Z', created_at: '2024-06-23T09:15:00Z',
    client: mockClients[2], agent: mockProfiles[1],
  },
  {
    id: 'meet-4', client_id: 'client-4', agent_id: 'agent-3', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.6507, gps_lng: 121.0496, photo_url: null,
    agenda: ['Negotiation (other matters)', 'Collection'],
    remarks: 'Client decided to go with a competitor.', outcome: 'lost_opportunity',
    contact_person: 'Lito Fernandez', contact_position: 'VP Sales',
    meeting_date: '2024-06-10T11:00:00Z', created_at: '2024-06-10T11:20:00Z',
    client: mockClients[3], agent: mockProfiles[2],
  },
  {
    id: 'meet-5', client_id: 'client-5', agent_id: 'agent-2', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.2291, gps_lng: 121.1613, photo_url: null,
    agenda: ['Closed deal'],
    remarks: 'Contract signed for 6 months.', outcome: 'successful',
    contact_person: 'Susan Ramos', contact_position: 'Director',
    meeting_date: '2024-06-22T13:00:00Z', created_at: '2024-06-22T13:30:00Z',
    client: mockClients[4], agent: mockProfiles[1],
  },
  {
    id: 'meet-6', client_id: 'client-6', agent_id: 'agent-3', recorded_by: null,
    meeting_type: 'online', online_platform: 'googlemeet', location_type: 'other', location_name: 'Google Meet',
    gps_lat: null, gps_lng: null, photo_url: null,
    agenda: ['Product/Company presentation', 'New business opportunity'],
    remarks: 'Promising lead. Needs follow up next week.', outcome: 'follow_up',
    contact_person: 'Karen Go', contact_position: 'Area Manager',
    meeting_date: '2024-06-21T15:00:00Z', created_at: '2024-06-21T15:10:00Z',
    client: mockClients[5], agent: mockProfiles[2],
  },
]

export const mockEditRequests: ClientEditRequest[] = [
  {
    id: 'req-1', client_id: 'client-1', requested_by: 'agent-1',
    changes: { sales_channel: { old: 'distributor', new: 'dealer' } },
    status: 'pending', reviewed_by: null, reviewed_at: null, created_at: '2024-06-25T11:00:00Z',
    client: mockClients[0], requester: mockProfiles[0],
  },
  {
    id: 'req-2', client_id: 'client-5', requested_by: 'agent-2',
    changes: { customer_type: { old: 'new', new: 'existing' }, contact_number: { old: '09561237890', new: '09561237891' } },
    status: 'approved', reviewed_by: 'mgr-1', reviewed_at: '2024-06-24T10:00:00Z', created_at: '2024-06-23T09:00:00Z',
    client: mockClients[4], requester: mockProfiles[1], reviewer: mockProfiles[3],
  },
  {
    id: 'req-3', client_id: 'client-3', requested_by: 'agent-2',
    changes: { contact_person: { old: 'Ramon Cruz', new: 'Ramon C. Cruz Jr.' } },
    status: 'rejected', reviewed_by: 'mgr-1', reviewed_at: '2024-06-22T14:00:00Z', created_at: '2024-06-22T08:00:00Z',
    client: mockClients[2], requester: mockProfiles[1], reviewer: mockProfiles[3],
  },
]

export const mockClockRecords: ClockRecord[] = [
  {
    id: 'clk-1', agent_id: 'agent-1', type: 'office', action: 'in',
    gps_lat: 14.5547, gps_lng: 121.0244, photo_url: null, event_name: null,
    timestamp: '2024-06-25T08:02:00Z', created_at: '2024-06-25T08:02:00Z', agent: mockProfiles[0],
  },
  {
    id: 'clk-2', agent_id: 'agent-1', type: 'office', action: 'out',
    gps_lat: 14.5547, gps_lng: 121.0244, photo_url: null, event_name: null,
    timestamp: '2024-06-25T18:00:00Z', created_at: '2024-06-25T18:00:00Z', agent: mockProfiles[0],
  },
  {
    id: 'clk-3', agent_id: 'agent-2', type: 'event', action: 'in',
    gps_lat: 14.5995, gps_lng: 120.9842, photo_url: null, event_name: 'Trade Fair PICC 2024',
    timestamp: '2024-06-24T09:00:00Z', created_at: '2024-06-24T09:00:00Z', agent: mockProfiles[1],
  },
  {
    id: 'clk-4', agent_id: 'agent-2', type: 'event', action: 'out',
    gps_lat: 14.5995, gps_lng: 120.9842, photo_url: null, event_name: 'Trade Fair PICC 2024',
    timestamp: '2024-06-24T17:30:00Z', created_at: '2024-06-24T17:30:00Z', agent: mockProfiles[1],
  },
  {
    id: 'clk-5', agent_id: 'agent-3', type: 'office', action: 'in',
    gps_lat: 14.4221, gps_lng: 121.0348, photo_url: null, event_name: null,
    timestamp: '2024-06-25T07:55:00Z', created_at: '2024-06-25T07:55:00Z', agent: mockProfiles[2],
  },
]

export const mockDashboardMetrics: DashboardMetrics = {
  totalMeetings: 24,
  meetingsByType: { existing: 10, new: 8, prospect: 6 },
  successfulByType: { existing: 7, new: 5, prospect: 2 },
  closedDeals: 3,
  monthlyTrend: [
    { month: 'Jan', total: 12, successful: 8 },
    { month: 'Feb', total: 15, successful: 10 },
    { month: 'Mar', total: 18, successful: 11 },
    { month: 'Apr', total: 20, successful: 13 },
    { month: 'May', total: 22, successful: 15 },
    { month: 'Jun', total: 24, successful: 14 },
  ],
}
