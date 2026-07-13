import { startOfMonth, subMonths, addDays, subDays } from 'date-fns'
import type { Profile, Client, Meeting, MeetingOutcome, ClockRecord, ClientEditRequest } from '@/types'
import { TEAM_1_ID, TEAM_2_ID, TEAM_RSR_1_ID, TEAM_RSR_2_ID } from '@/lib/teams'

// Meeting dates below are anchored to "today" (not hardcoded to a fixed
// year) so the Dashboard's "this month" stats and 12-month trend chart
// always have real data, no matter when the app is actually opened.
const TODAY = new Date()

/** N days before today, at a specific time of day. Always in the past — never a future date, regardless of what day of the month "today" is. */
function daysAgo(n: number, hour: number, minute = 0): string {
  const d = subDays(TODAY, n)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

export const mockProfiles: Profile[] = [
  { id: 'agent-1', user_id: 'u1', full_name: 'Cyril Santos', role: 'sales_specialist', team_id: TEAM_1_ID, created_at: '2024-01-10T08:00:00Z' },
  { id: 'agent-2', user_id: 'u2', full_name: 'Jun Reyes', role: 'sales_specialist', team_id: TEAM_1_ID, created_at: '2024-01-12T08:00:00Z' },
  { id: 'agent-3', user_id: 'u3', full_name: 'Maria Dela Cruz', role: 'sales_specialist', team_id: TEAM_2_ID, created_at: '2024-02-01T08:00:00Z' },
  { id: 'mgr-1', user_id: 'u4', full_name: 'Sir Eric Mendoza', role: 'sales_manager', team_id: TEAM_1_ID, created_at: '2024-01-05T08:00:00Z' },
  { id: 'mgr-2', user_id: 'u5', full_name: 'Sir Mike Lim', role: 'sales_manager', team_id: TEAM_2_ID, created_at: '2024-01-05T08:00:00Z' },
  { id: 'admin-1', user_id: 'u6', full_name: 'Admin User', role: 'admin', team_id: null, created_at: '2024-01-01T08:00:00Z' },
  { id: 'rsr-1', user_id: 'u7', full_name: 'Reggie Pascual', role: 'rsr', team_id: TEAM_RSR_1_ID, created_at: '2024-02-10T08:00:00Z' },
  { id: 'rsr-2', user_id: 'u8', full_name: 'JP Villanueva', role: 'rsr', team_id: TEAM_RSR_2_ID, created_at: '2024-02-15T08:00:00Z' },
  { id: 'col-1', user_id: 'u9', full_name: 'Billy Gabi', role: 'collector', team_id: null, created_at: '2024-03-01T08:00:00Z' },
  { id: 'agent-4', user_id: 'u10', full_name: 'Ana Bautista', role: 'sales_specialist', team_id: TEAM_2_ID, created_at: '2024-02-20T08:00:00Z' },
  { id: 'rsr-mgr-1', user_id: 'u11', full_name: 'Nestor Aquino', role: 'rsr_manager', team_id: TEAM_RSR_1_ID, created_at: '2024-01-08T08:00:00Z' },
  { id: 'rsr-mgr-2', user_id: 'u12', full_name: 'Divina Cortez', role: 'rsr_manager', team_id: TEAM_RSR_2_ID, created_at: '2024-01-08T08:00:00Z' },
]

export const mockClients: Client[] = [
  {
    id: 'client-1', company_name: 'Oracle Petroleum', contact_person: 'Bong Aquino', contact_position: 'Procurement Manager',
    contact_number: '09171234567', office_address: '123 EDSA, Makati City', office_lat: 14.5547, office_lng: 121.0244, customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'agent-1', status: 'active', rating: 5,
    lost_at: null, reassignable_at: null, created_at: '2024-03-01T09:00:00Z', updated_at: '2024-06-01T09:00:00Z',
    agent: mockProfiles[0],
  },
  {
    id: 'client-2', company_name: 'San Basilica Beauty Corp', contact_person: 'Maricel Torres', contact_position: 'Owner',
    contact_number: '09281112222', office_address: 'Alabang, Muntinlupa', office_lat: 14.4221, office_lng: 121.0348, customer_type: 'new',
    sales_channel: 'dealer', assigned_agent_id: 'agent-1', status: 'active', rating: 4,
    lost_at: null, reassignable_at: null, created_at: '2024-05-10T09:00:00Z', updated_at: '2024-06-10T09:00:00Z',
    agent: mockProfiles[0],
  },
  {
    id: 'client-3', company_name: 'Bataan Industrial Supply', contact_person: 'Ramon Cruz', contact_position: 'CEO',
    contact_number: '09391234567', office_address: 'Mariveles, Bataan', office_lat: 14.5254, office_lng: 120.5199, customer_type: 'prospect',
    sales_channel: 'end_user', assigned_agent_id: 'agent-2', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-06-20T09:00:00Z', updated_at: '2024-06-20T09:00:00Z',
    agent: mockProfiles[1],
  },
  {
    id: 'client-4', company_name: 'Metro Fuel Distributors', contact_person: 'Lito Fernandez', contact_position: 'VP Sales',
    contact_number: '09451239876', office_address: 'Quezon City', office_lat: 14.6507, office_lng: 121.0496, customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'agent-3', status: 'lost',
    lost_at: '2026-07-02T00:00:00Z', reassignable_at: '2026-07-16T00:00:00Z', created_at: '2024-01-15T09:00:00Z', updated_at: '2026-07-02T09:00:00Z',
    agent: mockProfiles[2],
  },
  {
    id: 'client-5', company_name: 'Laguna Chemical Works', contact_person: 'Susan Ramos', contact_position: 'Director',
    contact_number: '09561237890', office_address: 'Calamba, Laguna', office_lat: 14.2291, office_lng: 121.1613, customer_type: 'new',
    sales_channel: 'end_user', assigned_agent_id: 'agent-2', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-04-20T09:00:00Z', updated_at: '2024-05-20T09:00:00Z',
    agent: mockProfiles[1],
  },
  {
    id: 'client-6', company_name: 'Starbucks Alabang', contact_person: 'Karen Go', contact_position: 'Area Manager',
    contact_number: '09671110000', office_address: 'Alabang Town Center', office_lat: 14.4198, office_lng: 121.0398, customer_type: 'prospect',
    sales_channel: 'private_label', assigned_agent_id: 'agent-3', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-06-18T09:00:00Z', updated_at: '2024-06-18T09:00:00Z',
    agent: mockProfiles[2],
  },
  {
    id: 'client-7', company_name: 'Greenfield Agri Supply', contact_person: 'Nora Villamor', contact_position: 'Purchasing Head',
    contact_number: '09181239001', office_address: 'Cabuyao, Laguna', office_lat: 14.2786, office_lng: 121.1257, customer_type: 'existing',
    sales_channel: 'dealer', assigned_agent_id: 'agent-2', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-02-14T09:00:00Z', updated_at: '2024-06-02T09:00:00Z',
    agent: mockProfiles[1],
  },
  {
    id: 'client-8', company_name: 'Cavite Marine Depot', contact_person: 'Edgar Solis', contact_position: 'Owner',
    contact_number: '09291238888', office_address: 'Bacoor, Cavite', office_lat: 14.4590, office_lng: 120.8969, customer_type: 'prospect',
    sales_channel: 'end_user', assigned_agent_id: 'agent-1', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-06-28T09:00:00Z', updated_at: '2024-06-28T09:00:00Z',
    agent: mockProfiles[0],
  },
  {
    id: 'client-9', company_name: 'Pasig Fleet Services', contact_person: 'Wendell Ong', contact_position: 'Operations Manager',
    contact_number: '09171112223', office_address: 'Pasig City', office_lat: 14.5764, office_lng: 121.0851, customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'agent-3', status: 'lost',
    lost_at: '2026-05-23T00:00:00Z', reassignable_at: '2026-06-06T00:00:00Z', created_at: '2023-11-01T09:00:00Z', updated_at: '2026-05-23T09:00:00Z',
    agent: mockProfiles[2],
  },
  {
    id: 'client-10', company_name: 'Cavite Fresh Mart', contact_person: 'Jinky Ramirez', contact_position: 'Purchasing Officer',
    contact_number: '09189991234', office_address: 'Dasmariñas, Cavite', office_lat: 14.3294, office_lng: 120.9367, customer_type: 'new',
    sales_channel: 'dealer', assigned_agent_id: 'agent-4', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-06-15T09:00:00Z', updated_at: '2024-06-15T09:00:00Z',
    agent: mockProfiles[9],
  },
  {
    id: 'client-11', company_name: '7-Eleven Commonwealth', contact_person: 'Grace Fernandez', contact_position: 'Branch Supervisor',
    contact_number: '09201234567', office_address: 'Commonwealth Ave, Quezon City', office_lat: 14.6969, office_lng: 121.0817, customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'rsr-1', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-01-20T09:00:00Z', updated_at: '2024-06-01T09:00:00Z',
    agent: mockProfiles[6],
  },
  {
    id: 'client-12', company_name: 'Mercury Drug Cubao', contact_person: 'Allan Ibarra', contact_position: 'Store Manager',
    contact_number: '09301234567', office_address: 'Cubao, Quezon City', office_lat: 14.6197, office_lng: 121.0529, customer_type: 'existing',
    sales_channel: 'distributor', assigned_agent_id: 'rsr-2', status: 'active',
    lost_at: null, reassignable_at: null, created_at: '2024-01-22T09:00:00Z', updated_at: '2024-06-01T09:00:00Z',
    agent: mockProfiles[7],
  },
]

const flagshipMeetings: Meeting[] = [
  {
    id: 'meet-1', client_id: 'client-1', agent_id: 'agent-1', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.5547, gps_lng: 121.0244, photo_url: 'https://picsum.photos/seed/meet-1/480/360',
    agenda: ['New business opportunity', 'Price negotiation/quotation'],
    remarks: 'Client is interested in expanding the contract.', outcome: 'successful',
    contact_person: 'Bong Aquino', contact_position: 'Procurement Manager',
    meeting_date: daysAgo(0, 10, 0), created_at: daysAgo(0, 10, 0),
    client: mockClients[0], agent: mockProfiles[0],
  },
  {
    id: 'meet-2', client_id: 'client-2', agent_id: 'agent-1', recorded_by: 'mgr-1',
    meeting_type: 'f2f', online_platform: null, location_type: 'other', location_name: 'Starbucks Alabang',
    gps_lat: 14.4221, gps_lng: 121.0348, photo_url: 'https://picsum.photos/seed/meet-2/480/360',
    agenda: ['Product/Company presentation', 'Relationship building'],
    remarks: 'First meeting. Client is receptive.', outcome: 'follow_up',
    contact_person: 'Maricel Torres', contact_position: 'Owner',
    meeting_date: daysAgo(3, 14, 0), created_at: daysAgo(3, 14, 0),
    client: mockClients[1], agent: mockProfiles[0], recorder: mockProfiles[3],
  },
  {
    id: 'meet-3', client_id: 'client-3', agent_id: 'agent-2', recorded_by: null,
    meeting_type: 'online', online_platform: 'zoom', location_type: 'client_office', location_name: null,
    gps_lat: null, gps_lng: null, photo_url: null,
    agenda: ['New business opportunity'],
    remarks: null, outcome: 'no_decision',
    contact_person: 'Ramon Cruz', contact_position: 'CEO',
    meeting_date: daysAgo(2, 9, 0), created_at: daysAgo(2, 9, 0),
    client: mockClients[2], agent: mockProfiles[1],
  },
  {
    id: 'meet-4', client_id: 'client-4', agent_id: 'agent-3', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.6507, gps_lng: 121.0496, photo_url: 'https://picsum.photos/seed/meet-4/480/360',
    agenda: ['Negotiation (other matters)', 'Collection'],
    remarks: 'Client decided to go with a competitor.', outcome: 'lost_opportunity',
    contact_person: 'Lito Fernandez', contact_position: 'VP Sales',
    meeting_date: daysAgo(9, 11, 0), created_at: daysAgo(9, 11, 0),
    client: mockClients[3], agent: mockProfiles[2],
  },
  {
    id: 'meet-5', client_id: 'client-5', agent_id: 'agent-2', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.2291, gps_lng: 121.1613, photo_url: 'https://picsum.photos/seed/meet-5/480/360',
    agenda: ['Closed deal'],
    remarks: 'Contract signed for 6 months.', outcome: 'successful',
    contact_person: 'Susan Ramos', contact_position: 'Director',
    meeting_date: daysAgo(5, 13, 0), created_at: daysAgo(5, 13, 0),
    client: mockClients[4], agent: mockProfiles[1],
  },
  {
    id: 'meet-6', client_id: 'client-6', agent_id: 'agent-3', recorded_by: null,
    meeting_type: 'online', online_platform: 'googlemeet', location_type: 'other', location_name: 'Google Meet',
    gps_lat: null, gps_lng: null, photo_url: null,
    agenda: ['Product/Company presentation', 'New business opportunity'],
    remarks: 'Promising lead. Needs follow up next week.', outcome: 'follow_up',
    contact_person: 'Karen Go', contact_position: 'Area Manager',
    meeting_date: daysAgo(4, 15, 0), created_at: daysAgo(4, 15, 0),
    client: mockClients[5], agent: mockProfiles[2],
  },
  {
    id: 'meet-7', client_id: 'client-10', agent_id: 'agent-4', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.3294, gps_lng: 120.9367, photo_url: 'https://picsum.photos/seed/meet-7/480/360',
    agenda: ['New business opportunity', 'Product/Company presentation'],
    remarks: 'Owner wants a sample delivery before committing.', outcome: 'successful',
    contact_person: 'Jinky Ramirez', contact_position: 'Purchasing Officer',
    meeting_date: daysAgo(6, 10, 0), created_at: daysAgo(6, 10, 0),
    client: mockClients[9], agent: mockProfiles[9],
  },
  {
    id: 'meet-8', client_id: 'client-11', agent_id: 'rsr-1', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.6969, gps_lng: 121.0817, photo_url: 'https://picsum.photos/seed/meet-8/480/360',
    agenda: ['Store visit', 'Stock check'],
    remarks: 'Restocked shelves and confirmed next delivery schedule.', outcome: 'successful',
    contact_person: 'Grace Fernandez', contact_position: 'Branch Supervisor',
    meeting_date: daysAgo(3, 10, 0), created_at: daysAgo(3, 10, 0),
    client: mockClients[10], agent: mockProfiles[6],
  },
  {
    id: 'meet-9', client_id: 'client-12', agent_id: 'rsr-2', recorded_by: null,
    meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
    gps_lat: 14.6197, gps_lng: 121.0529, photo_url: 'https://picsum.photos/seed/meet-9/480/360',
    agenda: ['Store visit', 'Stock check'],
    remarks: 'Store manager requested additional promo materials.', outcome: 'follow_up',
    contact_person: 'Allan Ibarra', contact_position: 'Store Manager',
    meeting_date: daysAgo(1, 14, 0), created_at: daysAgo(1, 14, 0),
    client: mockClients[11], agent: mockProfiles[7],
  },
]

// Synthetic meetings for the 11 months before the current one, purely so the
// Dashboard's 12-month trend chart has real variation to show, not just one
// populated bar. Cycles through every agent (sales_specialist and rsr) who
// actually owns clients — reusing the Meeting concept for RSR activity too,
// since there's no separate store-visit data model yet.
function generateHistoricalMeetings(): Meeting[] {
  const agents = [mockProfiles[0], mockProfiles[1], mockProfiles[2], mockProfiles[9], mockProfiles[6], mockProfiles[7]]
  const outcomes: MeetingOutcome[] = ['successful', 'follow_up', 'no_decision', 'lost_opportunity']
  const meetings: Meeting[] = []

  // Each agent's *own* client roster, so filler meetings rotate across all
  // of their real accounts instead of piling onto whichever one .find()
  // happens to hit first.
  const clientsByAgent = new Map(
    agents.map(agent => [agent.id, mockClients.filter(c => c.assigned_agent_id === agent.id)])
  )
  const nextClientIndex = new Map(agents.map(agent => [agent.id, 0]))

  for (let monthsAgo = 11; monthsAgo >= 1; monthsAgo--) {
    const monthStart = startOfMonth(subMonths(TODAY, monthsAgo))
    const count = 3 + (monthsAgo % 3) // 3-5 meetings per month
    for (let i = 0; i < count; i++) {
      const agent = agents[(monthsAgo + i) % agents.length]
      const agentClients = clientsByAgent.get(agent.id) ?? [mockClients[0]]
      const clientIndex = nextClientIndex.get(agent.id) ?? 0
      const client = agentClients[clientIndex % agentClients.length]
      nextClientIndex.set(agent.id, clientIndex + 1)
      const outcome = outcomes[(monthsAgo + i * 2) % outcomes.length]
      const date = addDays(monthStart, 2 + ((i * 6) % 24))
      date.setHours(9 + (i % 6), 0, 0, 0)
      meetings.push({
        id: `meet-hist-${monthsAgo}-${i}`,
        client_id: client.id, agent_id: agent.id, recorded_by: null,
        meeting_type: 'f2f', online_platform: null, location_type: 'client_office', location_name: null,
        gps_lat: client.office_lat ?? null, gps_lng: client.office_lng ?? null, photo_url: null,
        agenda: ['Relationship building'], remarks: null, outcome,
        contact_person: client.contact_person, contact_position: client.contact_position,
        meeting_date: date.toISOString(), created_at: date.toISOString(),
        client, agent,
      })
    }
  }
  return meetings
}

export const mockMeetings: Meeting[] = [...flagshipMeetings, ...generateHistoricalMeetings()]

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
  {
    id: 'req-4', client_id: 'client-6', requested_by: 'agent-3',
    changes: { contact_number: { old: '09671110000', new: '09671110001' } },
    status: 'pending', reviewed_by: null, reviewed_at: null, created_at: '2024-06-21T16:00:00Z',
    client: mockClients[5], requester: mockProfiles[2],
  },
  {
    id: 'req-5', client_id: 'client-10', requested_by: 'agent-4',
    changes: { customer_type: { old: 'new', new: 'existing' } },
    status: 'approved', reviewed_by: 'mgr-2', reviewed_at: '2024-06-17T09:00:00Z', created_at: '2024-06-16T11:00:00Z',
    client: mockClients[9], requester: mockProfiles[9], reviewer: mockProfiles[4],
  },
]

// One clock-in/out pair per agent per calendar day that they had a meeting —
// derived straight from mockMeetings (flagship + the 11-month historical
// spread), so Clock Records/Reports have the same real coverage as Meetings
// instead of a handful of hand-picked entries.
function generateClockRecordsFromMeetings(): ClockRecord[] {
  const seenAgentDays = new Set<string>()
  const records: ClockRecord[] = []

  for (const mtg of mockMeetings) {
    if (!mtg.agent) continue
    const d = new Date(mtg.meeting_date)
    const agentDayKey = `${mtg.agent_id}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (seenAgentDays.has(agentDayKey)) continue
    seenAgentDays.add(agentDayKey)

    const clockIn = new Date(d)
    clockIn.setHours(8, 0, 0, 0)
    const clockOut = new Date(d)
    clockOut.setHours(17, 30, 0, 0)

    records.push({
      id: `clk-${mtg.id}-in`, agent_id: mtg.agent_id, type: 'office', action: 'in',
      gps_lat: mtg.gps_lat, gps_lng: mtg.gps_lng, photo_url: null, event_name: null,
      timestamp: clockIn.toISOString(), created_at: clockIn.toISOString(), agent: mtg.agent,
    })
    records.push({
      id: `clk-${mtg.id}-out`, agent_id: mtg.agent_id, type: 'office', action: 'out',
      gps_lat: mtg.gps_lat, gps_lng: mtg.gps_lng, photo_url: null, event_name: null,
      timestamp: clockOut.toISOString(), created_at: clockOut.toISOString(), agent: mtg.agent,
    })
  }
  return records
}

export const mockClockRecords: ClockRecord[] = generateClockRecordsFromMeetings()
