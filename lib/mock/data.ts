import { startOfMonth, subMonths, addDays, subDays } from 'date-fns'
import type { Profile, Client, Meeting, MeetingOutcome, ClockRecord, ClientEditRequest, CollectionVisit, Remittance, PurchaseOrder, CodRemittance } from '@/types'

// Team ids for the demo profiles below. These used to be the four seeded UUIDs
// imported from lib/teams.ts, back when a demo profile's team_id was expected
// to match a real row. Migration 089 deleted those rows — teams are created
// from the Users page now — so there is nothing to match, and these are plainly
// fake strings like every other id in this file ('agent-1', 'u1', …). Anything
// that renders a team name resolves it from the live `teams` rows via
// useTeams(), which returns '—' for an id it does not know: correct, since
// these teams do not exist.
const MOCK_SALES_TEAM_1 = 'mock-team-sales-1'
const MOCK_SALES_TEAM_2 = 'mock-team-sales-2'
const MOCK_RSR_TEAM_1 = 'mock-team-rsr-1'
const MOCK_RSR_TEAM_2 = 'mock-team-rsr-2'

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

// Placeholder headshots (pravatar.cc) standing in for the photos mobile
// users will upload to the 'avatars' bucket. admin-1 (web-only) and col-1
// are intentionally left without one to exercise the initials fallback.
export const mockProfiles: Profile[] = [
  { id: 'agent-1', user_id: 'u1', full_name: 'Cyril Santos', role: 'sales_specialist', team_id: MOCK_SALES_TEAM_1, avatar_url: 'https://i.pravatar.cc/150?img=12', created_at: '2024-01-10T08:00:00Z' },
  { id: 'agent-2', user_id: 'u2', full_name: 'Jun Reyes', role: 'sales_specialist', team_id: MOCK_SALES_TEAM_1, avatar_url: 'https://i.pravatar.cc/150?img=13', created_at: '2024-01-12T08:00:00Z' },
  { id: 'agent-3', user_id: 'u3', full_name: 'Maria Dela Cruz', role: 'sales_specialist', team_id: MOCK_SALES_TEAM_2, avatar_url: 'https://i.pravatar.cc/150?img=47', created_at: '2024-02-01T08:00:00Z' },
  { id: 'mgr-1', user_id: 'u4', full_name: 'Sir Eric Mendoza', role: 'sales_manager', team_id: MOCK_SALES_TEAM_1, avatar_url: 'https://i.pravatar.cc/150?img=14', created_at: '2024-01-05T08:00:00Z' },
  { id: 'mgr-2', user_id: 'u5', full_name: 'Sir Mike Lim', role: 'sales_manager', team_id: MOCK_SALES_TEAM_2, avatar_url: 'https://i.pravatar.cc/150?img=15', created_at: '2024-01-05T08:00:00Z' },
  { id: 'admin-1', user_id: 'u6', full_name: 'Admin User', role: 'admin', team_id: null, created_at: '2024-01-01T08:00:00Z' },
  { id: 'rsr-1', user_id: 'u7', full_name: 'Reggie Pascual', role: 'rsr', team_id: MOCK_RSR_TEAM_1, avatar_url: 'https://i.pravatar.cc/150?img=53', created_at: '2024-02-10T08:00:00Z' },
  { id: 'rsr-2', user_id: 'u8', full_name: 'JP Villanueva', role: 'rsr', team_id: MOCK_RSR_TEAM_2, avatar_url: 'https://i.pravatar.cc/150?img=59', created_at: '2024-02-15T08:00:00Z' },
  { id: 'col-1', user_id: 'u9', full_name: 'Billy Gabi', role: 'collector', team_id: null, created_at: '2024-03-01T08:00:00Z' },
  { id: 'agent-4', user_id: 'u10', full_name: 'Ana Bautista', role: 'sales_specialist', team_id: MOCK_SALES_TEAM_2, avatar_url: 'https://i.pravatar.cc/150?img=44', created_at: '2024-02-20T08:00:00Z' },
  { id: 'rsr-mgr-1', user_id: 'u11', full_name: 'Nestor Aquino', role: 'sales_manager', team_id: MOCK_RSR_TEAM_1, avatar_url: 'https://i.pravatar.cc/150?img=51', created_at: '2024-01-08T08:00:00Z' },
  { id: 'rsr-mgr-2', user_id: 'u12', full_name: 'Divina Cortez', role: 'sales_manager', team_id: MOCK_RSR_TEAM_2, avatar_url: 'https://i.pravatar.cc/150?img=45', created_at: '2024-01-08T08:00:00Z' },
  // ⚠️ APPEND ONLY. Rows below are referenced positionally elsewhere in this file
  // (`mockProfiles[9]` and friends), so inserting into the middle silently
  // reassigns those references to the wrong person. Add new profiles at the end.
  { id: 'col-2', user_id: 'u13', full_name: 'Lito Tanteo', role: 'collector', team_id: null, avatar_url: 'https://i.pravatar.cc/150?img=68', created_at: '2024-03-05T08:00:00Z' },
  // Delivery personnel. Their own role as of migration 023 — before that, POs had
  // to be assigned to collectors/RSRs because no delivery role existed. No team,
  // same as collectors (see teamIdsForRole).
  { id: 'del-1', user_id: 'u14', full_name: 'Dennis Rivera', role: 'delivery', team_id: null, avatar_url: 'https://i.pravatar.cc/150?img=60', created_at: '2024-03-12T08:00:00Z' },
  { id: 'del-2', user_id: 'u15', full_name: 'Marlon Cruz', role: 'delivery', team_id: null, created_at: '2024-03-12T08:00:00Z' },
]

/** Look a profile up by id instead of array position. Throws loudly on a typo. */
function profile(id: string): Profile {
  const found = mockProfiles.find(p => p.id === id)
  if (!found) throw new Error(`mock data: no profile with id "${id}"`)
  return found
}

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
  // Looked up by id, not array position: this used to be `mockProfiles[9]` etc.,
  // which meant adding a profile mid-array silently repointed these at whoever
  // shifted into that slot. That actually happened — a collector landed on index
  // 9, and since collectors own no clients the roster below came back empty and
  // `agentClients[i % 0]` blew up with `undefined.id`.
  const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'rsr-1', 'rsr-2'].map(profile)
  const outcomes: MeetingOutcome[] = ['successful', 'follow_up', 'no_decision', 'lost_opportunity']
  const meetings: Meeting[] = []

  // Each agent's *own* client roster, so filler meetings rotate across all
  // of their real accounts instead of piling onto whichever one .find()
  // happens to hit first. Agents with no clients are dropped rather than
  // falling through to an empty array — `?? []` does not catch a length of 0.
  const clientsByAgent = new Map(
    agents
      .map(agent => [agent.id, mockClients.filter(c => c.assigned_agent_id === agent.id)] as const)
      .filter(([, clients]) => clients.length > 0)
  )
  const agentsWithClients = agents.filter(a => clientsByAgent.has(a.id))
  const nextClientIndex = new Map(agentsWithClients.map(agent => [agent.id, 0]))

  for (let monthsAgo = 11; monthsAgo >= 1; monthsAgo--) {
    const monthStart = startOfMonth(subMonths(TODAY, monthsAgo))
    const count = 3 + (monthsAgo % 3) // 3-5 meetings per month
    for (let i = 0; i < count; i++) {
      const agent = agentsWithClients[(monthsAgo + i) % agentsWithClients.length]
      const agentClients = clientsByAgent.get(agent.id)!
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
    status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null, created_at: '2024-06-25T11:00:00Z',
    client: mockClients[0], requester: mockProfiles[0],
  },
  {
    id: 'req-2', client_id: 'client-5', requested_by: 'agent-2',
    changes: { customer_type: { old: 'new', new: 'existing' }, contact_number: { old: '09561237890', new: '09561237891' } },
    status: 'approved', reviewed_by: 'mgr-1', reviewed_at: '2024-06-24T10:00:00Z', review_note: null, created_at: '2024-06-23T09:00:00Z',
    client: mockClients[4], requester: mockProfiles[1], reviewer: mockProfiles[3],
  },
  {
    id: 'req-3', client_id: 'client-3', requested_by: 'agent-2',
    changes: { contact_person: { old: 'Ramon Cruz', new: 'Ramon C. Cruz Jr.' } },
    status: 'rejected', reviewed_by: 'mgr-1', reviewed_at: '2024-06-22T14:00:00Z',
    review_note: 'Confirm the spelling on the signed PO first — this does not match the contract.',
    created_at: '2024-06-22T08:00:00Z',
    client: mockClients[2], requester: mockProfiles[1], reviewer: mockProfiles[3],
  },
  {
    id: 'req-4', client_id: 'client-6', requested_by: 'agent-3',
    changes: { contact_number: { old: '09671110000', new: '09671110001' } },
    status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null, created_at: '2024-06-21T16:00:00Z',
    client: mockClients[5], requester: mockProfiles[2],
  },
  {
    id: 'req-5', client_id: 'client-10', requested_by: 'agent-4',
    changes: { customer_type: { old: 'new', new: 'existing' } },
    status: 'approved', reviewed_by: 'mgr-2', reviewed_at: '2024-06-17T09:00:00Z', review_note: null, created_at: '2024-06-16T11:00:00Z',
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

// ---------------------------------------------------------------------------
// Collection module (F-007) — mock only.
//
// No collection tables exist in the database (latest migration is 024) and the
// mobile collector screens are still first-draft mock UI, so nothing here is
// wired to anything real. Shapes follow the July 3 client spec in Features.md
// F-007 plus the 2026-07-25 revisions, so swapping in Supabase later should be a
// query change, not a redesign.
//
// The data is arranged to exercise the cases an admin actually cares about:
// a clean reconciled remittance, one with a shortfall, cash/check/GCash spread,
// a rescheduled visit that collected nothing, an open list for today with
// stores nobody has picked up yet, and one collected visit whose delivery
// receipt never arrived.
// ---------------------------------------------------------------------------

/** Optional profile lookup — the collector, driver, or receiver on a row. */
const staffById = (id: string | null) => (id ? mockProfiles.find(p => p.id === id) : undefined)
const clientById = (id: string) => mockClients.find(c => c.id === id)

/** Every store below was put on a day's list by the same admin (admin-1). */
const listedBy = { listed_by: 'admin-1' }

/** The delivery-receipt proof, present — the normal case for a closed visit. */
function receiptProof(seed: string) {
  return { delivery_receipt_photo_url: `https://picsum.photos/seed/${seed}dr/400/300` }
}

/** Nothing captured yet — pending and rescheduled stops have no proofs at all. */
const noProofs = {
  payment_photo_url: null,
  delivery_receipt_photo_url: null,
}

/**
 * Who is currently EN ROUTE (migration 046), keyed by row id. Kept out of the
 * seed literals so the claim state reads as one list you can scan, rather than
 * three fields buried in thirty rows — and because the claimer's NAME is
 * denormalized onto the row in production, so it's derived here too.
 *
 * Exercises both cases the board renders: a live claim on today's list, and a
 * stale one left on yesterday's unworked store.
 *
 * Every claimer here is distinct, because they must be: the partial unique
 * index in 046 permits one ACTIVE (pending) claim per person, and every row
 * below is pending. Reusing a collector would encode a state the database
 * rejects.
 */
const CLAIMS: Record<string, { by: string; at: string }> = {
  'cv-12': { by: 'col-2', at: daysAgo(0, 10, 5) },
  'cv-14': { by: 'col-1', at: daysAgo(1, 15, 50) },
  'po-14': { by: 'del-1', at: daysAgo(0, 8, 40) },
  'po-15': { by: 'del-2', at: daysAgo(0, 9, 30) },
}

/** The claim triplet for a row — all three columns or all three null. */
function claimFor(id: string) {
  const claim = CLAIMS[id]
  if (!claim) return { claimed_by: null, claimed_at: null, claimed_by_name: null }
  return {
    claimed_by: claim.by,
    claimed_at: claim.at,
    claimed_by_name: staffById(claim.by)?.full_name ?? null,
  }
}

// `client_name`/`area` are omitted from the seed and derived at map time below,
// which is exactly what the real insert does — they are a copy of the client
// taken when the admin publishes the row (migration 045), not hand-authored.
// The claim fields are omitted for the same reason — see CLAIMS above.
// `customer_signature_url` is omitted too, and always null at map time: mobile
// requires the signature but does not upload it yet (migration 061 created the
// column; mobile's queuePhoto call is unwritten). Seeding one would show a
// capture that cannot exist in the live database.
// The three "additional" fields (migration 068) are omitted and defaulted at map
// time too: the mock has no additional stores, and their ack timestamps only
// exist once mobile stamps them (migration 069). Seeding them would show a
// delivery/seen state the live database can't produce yet.
const collectionVisitSeed: Omit<
  CollectionVisit,
  'client' | 'collector' | 'client_name' | 'area'
  | 'claimed_by' | 'claimed_at' | 'claimed_by_name' | 'customer_signature_url'
  | 'is_additional' | 'additional_received_at' | 'additional_seen_at'
>[] = [
  {
    id: 'cv-1', collector_id: 'col-1', client_id: 'client-1', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    amount_due: 9800, amount_collected: 9800, payment_method: 'cash',
    payment_photo_url: 'https://picsum.photos/seed/cv1/400/300', ...receiptProof('cv1'),
    gps_lat: 14.8006, gps_lng: 120.5372,
    remarks: null, rescheduled_to: null, visited_at: daysAgo(1, 9, 41), created_at: daysAgo(2, 16, 30),
  },
  {
    // Same day's list as cv-1/cv-3 but a different collector — the point of a
    // shared pool is that two people can work one list.
    id: 'cv-2', collector_id: 'col-2', client_id: 'client-2', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    amount_due: 18000, amount_collected: 18000, payment_method: 'check',
    payment_photo_url: 'https://picsum.photos/seed/cv2/400/300', ...receiptProof('cv2'),
    gps_lat: 14.4198, gps_lng: 121.0409,
    remarks: 'Check dated next week', rescheduled_to: null, visited_at: daysAgo(1, 11, 15), created_at: daysAgo(2, 16, 30),
  },
  {
    // Delivery receipt never came through. It is required before the phone will
    // accept "✓ Collected", so this row is the one the admin has to chase.
    id: 'cv-3', collector_id: 'col-1', client_id: 'client-3', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    amount_due: 12000, amount_collected: 12000, payment_method: 'gcash',
    payment_photo_url: 'https://picsum.photos/seed/cv3/400/300',
    delivery_receipt_photo_url: null,
    gps_lat: 14.6760, gps_lng: 120.5401,
    remarks: null, rescheduled_to: null, visited_at: daysAgo(1, 14, 5), created_at: daysAgo(2, 16, 30),
  },
  {
    // Store paid less than the office expected. The collector never saw the due
    // amount (2026-07-25 rule), so this is a store-side partial, not a miscount.
    id: 'cv-4', collector_id: 'col-2', client_id: 'client-4', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(2, 8), listed_at: daysAgo(3, 16, 0),
    amount_due: 15000, amount_collected: 13500, payment_method: 'cash',
    payment_photo_url: 'https://picsum.photos/seed/cv4/400/300', ...receiptProof('cv4'),
    gps_lat: 14.6507, gps_lng: 121.1029,
    remarks: 'Partial — balance next visit', rescheduled_to: null, visited_at: daysAgo(2, 10, 20), created_at: daysAgo(3, 16, 0),
  },
  {
    // Paid over the counter — 'counter' became a payment method on 2026-07-26,
    // and the shared payment photo is the counter receipt.
    id: 'cv-5', collector_id: 'col-2', client_id: 'client-5', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(2, 8), listed_at: daysAgo(3, 16, 0),
    amount_due: 7400, amount_collected: 7400, payment_method: 'counter',
    payment_photo_url: 'https://picsum.photos/seed/cv5/400/300', ...receiptProof('cv5'),
    gps_lat: 14.2117, gps_lng: 121.1644,
    remarks: null, rescheduled_to: null, visited_at: daysAgo(2, 13, 30), created_at: daysAgo(3, 16, 0),
  },
  {
    // Collection-day reschedule — nothing collected, no proofs, no amount.
    id: 'cv-6', collector_id: 'col-2', client_id: 'client-6', status: 'rescheduled',
    ...listedBy, scheduled_for: daysAgo(2, 8), listed_at: daysAgo(3, 16, 0),
    amount_due: 22000, amount_collected: null, payment_method: null, ...noProofs,
    gps_lat: 14.4126, gps_lng: 121.0410,
    remarks: 'Owner out of town', rescheduled_to: daysAgo(-3, 9, 0), visited_at: daysAgo(2, 15, 45), created_at: daysAgo(3, 16, 0),
  },
  {
    // Collected today and not yet remitted — this is what "Still held" reports.
    id: 'cv-7', collector_id: 'col-1', client_id: 'client-7', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 45),
    amount_due: 5600, amount_collected: 5600, payment_method: 'cash',
    payment_photo_url: 'https://picsum.photos/seed/cv7/400/300', ...receiptProof('cv7'),
    gps_lat: 14.2786, gps_lng: 121.1257,
    remarks: null, rescheduled_to: null, visited_at: daysAgo(0, 10, 5), created_at: daysAgo(1, 16, 45),
  },
  // Earlier cycle, both handed over at a bayad center (rm-3).
  {
    id: 'cv-9', collector_id: 'col-1', client_id: 'client-9', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(4, 8), listed_at: daysAgo(5, 15, 30),
    amount_due: 8200, amount_collected: 8200, payment_method: 'cash',
    payment_photo_url: 'https://picsum.photos/seed/cv9/400/300', ...receiptProof('cv9'),
    gps_lat: 14.5764, gps_lng: 121.0851,
    remarks: null, rescheduled_to: null, visited_at: daysAgo(4, 9, 30), created_at: daysAgo(5, 15, 30),
  },
  {
    id: 'cv-10', collector_id: 'col-1', client_id: 'client-1', status: 'collected',
    ...listedBy, scheduled_for: daysAgo(4, 8), listed_at: daysAgo(5, 15, 30),
    amount_due: 6000, amount_collected: 6000, payment_method: 'check',
    payment_photo_url: 'https://picsum.photos/seed/cv10/400/300', ...receiptProof('cv10'),
    gps_lat: 14.5547, gps_lng: 121.0244,
    remarks: null, rescheduled_to: null, visited_at: daysAgo(4, 13, 15), created_at: daysAgo(5, 15, 30),
  },
  // --- Today's list: published this morning, still being worked ------------
  // No collector on these: they are on the shared list and belong to nobody
  // until someone actually collects them.
  {
    id: 'cv-8', collector_id: null, client_id: 'client-8', status: 'pending',
    ...listedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 45),
    amount_due: 11200, amount_collected: null, payment_method: null, ...noProofs,
    gps_lat: null, gps_lng: null,
    remarks: null, rescheduled_to: null, visited_at: null, created_at: daysAgo(1, 16, 45),
  },
  {
    id: 'cv-11', collector_id: null, client_id: 'client-10', status: 'pending',
    ...listedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 45),
    amount_due: 4300, amount_collected: null, payment_method: null, ...noProofs,
    gps_lat: null, gps_lng: null,
    remarks: null, rescheduled_to: null, visited_at: null, created_at: daysAgo(1, 16, 45),
  },
  {
    id: 'cv-12', collector_id: null, client_id: 'client-11', status: 'pending',
    ...listedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 45),
    amount_due: 15700, amount_collected: null, payment_method: null, ...noProofs,
    gps_lat: null, gps_lng: null,
    remarks: null, rescheduled_to: null, visited_at: null, created_at: daysAgo(1, 16, 45),
  },
  // --- Tomorrow's list: published ahead, nothing started -------------------
  {
    id: 'cv-13', collector_id: null, client_id: 'client-12', status: 'pending',
    ...listedBy, scheduled_for: daysAgo(-1, 8), listed_at: daysAgo(0, 9, 15),
    amount_due: 7250, amount_collected: null, payment_method: null, ...noProofs,
    gps_lat: null, gps_lng: null,
    remarks: null, rescheduled_to: null, visited_at: null, created_at: daysAgo(0, 9, 15),
  },
  // Yesterday's list, never closed out — and still claimed (see CLAIMS below).
  // The whole-day rule says this shouldn't exist; nothing enforces it, so the
  // admin board has to surface it. Exercises the stale-claim path.
  {
    id: 'cv-14', collector_id: null, client_id: 'client-6', status: 'pending',
    ...listedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    amount_due: 6400, amount_collected: null, payment_method: null, ...noProofs,
    gps_lat: null, gps_lng: null,
    remarks: null, rescheduled_to: null, visited_at: null, created_at: daysAgo(2, 16, 30),
  },
]

export const mockCollectionVisits: CollectionVisit[] = collectionVisitSeed.map(v => {
  const client = clientById(v.client_id)
  return {
    ...v,
    client_name: client?.company_name ?? null,
    area: client?.city ?? null,
    customer_signature_url: null,
    is_additional: false,
    additional_received_at: null,
    additional_seen_at: null,
    ...claimFor(v.id),
    client,
    collector: staffById(v.collector_id),
  }
})

const remittanceSeed: Omit<Remittance, 'collector'>[] = [
  {
    // Office remittance: receiver signature present, as the spec requires.
    id: 'rm-1', collector_id: 'col-1', destination: 'office',
    amount_remitted: 39800, amount_collected: 39800, status: 'reconciled',
    receiver_name: 'Grace Villanueva', signed_proof_url: 'https://picsum.photos/seed/rm1/400/300',
    receiver_signature_url: 'https://picsum.photos/seed/sig1/400/160',
    visit_ids: ['cv-1', 'cv-2', 'cv-3'], submitted_at: daysAgo(1, 17, 20), created_at: daysAgo(1, 17, 20),
  },
  {
    // Shortfall: collector handed over less than the visits total. This is the
    // row an admin needs to see first, so the UI sorts variance to the top.
    id: 'rm-2', collector_id: 'col-2', destination: 'office',
    amount_remitted: 20000, amount_collected: 20900, status: 'variance',
    receiver_name: 'Grace Villanueva', signed_proof_url: 'https://picsum.photos/seed/rm2/400/300',
    receiver_signature_url: 'https://picsum.photos/seed/sig2/400/160',
    visit_ids: ['cv-4', 'cv-5'], submitted_at: daysAgo(2, 17, 45), created_at: daysAgo(2, 17, 45),
  },
  {
    // Bayad-center drop: no in-app signature — that requirement is office-only.
    id: 'rm-3', collector_id: 'col-1', destination: 'bayad_center',
    amount_remitted: 14200, amount_collected: 14200, status: 'submitted',
    receiver_name: null, signed_proof_url: 'https://picsum.photos/seed/rm3/400/300',
    receiver_signature_url: null,
    visit_ids: ['cv-9', 'cv-10'], submitted_at: daysAgo(4, 16, 10), created_at: daysAgo(4, 16, 10),
  },
]

export const mockRemittances: Remittance[] = remittanceSeed.map(r => ({
  ...r, collector: staffById(r.collector_id),
}))

// ---------------------------------------------------------------------------
// Delivery module (F-007) — mock only.
//
// No delivery tables exist in the database (latest migration is 024) and the
// driver screens on mobile are a read-only first draft (`app/(delivery)/pos.tsx`,
// commit f294b79 — the Deliver-PO flow itself is explicitly not built there yet).
//
// Shapes follow the paper "TRIP REPORT" the office runs today (photo, 2026-07-27)
// plus that day's corrections: SEQ / COMPANY NAME / LOCATION / TIME-IN /
// TIME-OUT / COMPANY REPRESENTATIVE'S SIGNATURE, 20 pre-printed rows with ~15
// used, no items column and no PO column on the sheet at all. A PO lives for one
// delivery day — delivered, or failed with the goods riding back. The 3-day
// follow-up in the wireframes and in mobile's first draft is not a delivery rule;
// see the note on DeliveryStatus.
//
// Dwell times below mirror the real sheet: 5–13 minutes at most stops. Arranged
// to exercise what an admin opens this page for — a trip list half-run with the
// driver's own sequence numbers, a failed delivery that came back yesterday and
// was re-listed by hand for today, COD still in a driver's hands, a reconciled
// remittance and one short, a delivered PO whose proof photo never arrived, and
// stops signed and unsigned.
//
// Coordinates sit in the Bataan municipality each stop's `area` names, so a
// day's run reads as a real route across the province rather than a cloud of
// points. Only worked stops carry them — the fix rides along with the stop's
// photo, so a stop nobody reached has no photo and no location (2026-07-27; see
// the GPS-reversal note on PurchaseOrder).
// ---------------------------------------------------------------------------

/** Every PO below was put on a delivery day's list by the same admin (admin-1). */
const poListedBy = { listed_by: 'admin-1' }

/** A PO with no money on it: the plain proof-of-delivery flow. */
const noCod = {
  cod: false,
  cod_due: null,
  cod_amount: null,
  cod_method: null,
  cod_photo_url: null,
  cod_remitted: false,
} as const

/** Nobody has reached this stop yet, so no driver-side field exists on it. */
const unrun = {
  driver_id: null,
  truck_plate: null,
  sequence_no: null,
  time_in: null,
  time_out: null,
  receiver_name: null,
  receiver_signature_url: null,
  proof_url: null,
  backload_photo_url: null,
  // No photo taken yet, so no fix — an unrun stop is absent from the trip line
  // rather than sitting on it at the wrong place.
  gps_lat: null,
  gps_lng: null,
} as const

/** The representative's signature, the way every row on the paper sheet carries one. */
const signed = (seed: string) => `https://picsum.photos/seed/${seed}/400/160`

// `client_name` and the claim fields are derived at map time — see the notes on
// collectionVisitSeed and CLAIMS. `area` stays hand-authored here: on delivery
// the admin types it on the form.
const purchaseOrderSeed: Omit<
  PurchaseOrder,
  'client' | 'driver' | 'client_name' | 'claimed_by' | 'claimed_at' | 'claimed_by_name'
>[] = [
  // --- Today's trip list: published last night, half run ---------------------
  {
    // Stop 1 of Dennis's run. The sequence came from the order he actually
    // drove, not from anything the office set in advance.
    id: 'po-1', po_number: 'PO-2085', client_id: 'client-9', area: 'Mariveles',
    status: 'delivered',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    driver_id: 'del-1', truck_plate: 'NGP 4021', sequence_no: 1,
    time_in: daysAgo(0, 8, 32), time_out: daysAgo(0, 8, 40),
    receiver_name: 'J. Ramos', receiver_signature_url: signed('posig1'),
    proof_url: 'https://picsum.photos/seed/po1/400/300', backload_photo_url: null,
    gps_lat: 14.4361, gps_lng: 120.4879,
    remarks: 'Delivered', ...noCod,
    created_at: daysAgo(1, 16, 40),
  },
  {
    // COD stop, money still in Dennis's hands — this is what "Held by drivers"
    // reports. Nobody signed for it either, which the proof grid says plainly.
    id: 'po-2', po_number: 'PO-2082', client_id: 'client-2', area: 'Hermosa',
    status: 'delivered',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    driver_id: 'del-1', truck_plate: 'NGP 4021', sequence_no: 2,
    time_in: daysAgo(0, 9, 2), time_out: daysAgo(0, 9, 10),
    receiver_name: 'M. dela Cruz', receiver_signature_url: null,
    proof_url: 'https://picsum.photos/seed/po2/400/300', backload_photo_url: null,
    gps_lat: 14.8302, gps_lng: 120.5044,
    remarks: 'Delivered',
    cod: true, cod_due: 9700, cod_amount: 9700, cod_method: 'cash',
    cod_photo_url: 'https://picsum.photos/seed/po2cod/400/300', cod_remitted: false,
    created_at: daysAgo(1, 16, 40),
  },
  {
    // Failed today: the customer wouldn't take the load, so it rode back on
    // Marlon's truck. Their rep still signed the sheet for the refusal.
    id: 'po-3', po_number: 'PO-2096', client_id: 'client-11', area: 'Balanga',
    status: 'failed',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    driver_id: 'del-2', truck_plate: 'TXR 8890', sequence_no: 1,
    time_in: daysAgo(0, 10, 14), time_out: daysAgo(0, 10, 25),
    receiver_name: null, receiver_signature_url: signed('posig3'), proof_url: null,
    backload_photo_url: 'https://picsum.photos/seed/po3bl/400/300',
    // Failed stops carry a fix too — it comes off the backload photo, so the map
    // still shows where the truck was turned away.
    gps_lat: 14.6788, gps_lng: 120.5402,
    remarks: 'Wrong pack size — whole load refused, backloaded', ...noCod,
    created_at: daysAgo(1, 16, 40),
  },
  {
    // Re-listed by hand after failing yesterday (po-13). Same PO number, new
    // day, fresh attempt — nothing rolled it forward automatically.
    id: 'po-4', po_number: 'PO-2087', client_id: 'client-3', area: 'Dinalupihan',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(0, 7, 15),
    ...unrun, remarks: 'Re-listed after Jul 26 backload',
    cod: true, cod_due: 15400, cod_amount: null, cod_method: null,
    cod_photo_url: null, cod_remitted: false,
    created_at: daysAgo(0, 7, 15),
  },
  {
    id: 'po-5', po_number: 'PO-2088', client_id: 'client-5', area: 'Hermosa',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    ...unrun, remarks: null, ...noCod,
    created_at: daysAgo(1, 16, 40),
  },
  {
    id: 'po-6', po_number: 'PO-2091', client_id: 'client-7', area: 'Balanga',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    ...unrun, remarks: null,
    cod: true, cod_due: 8200, cod_amount: null, cod_method: null,
    cod_photo_url: null, cod_remitted: false,
    created_at: daysAgo(1, 16, 40),
  },
  {
    id: 'po-7', po_number: 'PO-2093', client_id: 'client-1', area: 'Orani',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    ...unrun, remarks: null, ...noCod,
    created_at: daysAgo(1, 16, 40),
  },
  {
    id: 'po-8', po_number: 'PO-2094', client_id: 'client-8', area: 'Abucay',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(0, 8), listed_at: daysAgo(1, 16, 40),
    ...unrun, remarks: null,
    cod: true, cod_due: 3100, cod_amount: null, cod_method: null,
    cod_photo_url: null, cod_remitted: false,
    created_at: daysAgo(1, 16, 40),
  },

  // --- Yesterday's list: fully run, COD already handed over ------------------
  {
    id: 'po-9', po_number: 'PO-2079', client_id: 'client-6', area: 'Orani',
    status: 'delivered',
    ...poListedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    driver_id: 'del-1', truck_plate: 'NGP 4021', sequence_no: 1,
    time_in: daysAgo(1, 8, 57), time_out: daysAgo(1, 9, 5),
    receiver_name: 'A. Santiago', receiver_signature_url: signed('posig9'),
    proof_url: 'https://picsum.photos/seed/po9/400/300', backload_photo_url: null,
    gps_lat: 14.7975, gps_lng: 120.5368,
    remarks: 'Delivered', ...noCod,
    created_at: daysAgo(2, 16, 30),
  },
  {
    id: 'po-10', po_number: 'PO-2081', client_id: 'client-4', area: 'Hermosa',
    status: 'delivered',
    ...poListedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    driver_id: 'del-1', truck_plate: 'NGP 4021', sequence_no: 2,
    time_in: daysAgo(1, 13, 27), time_out: daysAgo(1, 13, 40),
    receiver_name: 'R. Ilagan', receiver_signature_url: signed('posig10'),
    proof_url: 'https://picsum.photos/seed/po10/400/300', backload_photo_url: null,
    gps_lat: 14.8357, gps_lng: 120.4971,
    remarks: 'Delivered',
    cod: true, cod_due: 12500, cod_amount: 12500, cod_method: 'check',
    cod_photo_url: 'https://picsum.photos/seed/po10cod/400/300', cod_remitted: true,
    created_at: daysAgo(2, 16, 30),
  },
  {
    // Signed for, but the rep wouldn't give a name — the exact case the paper
    // sheet shows, and why the signature carries the proof rather than the name.
    id: 'po-11', po_number: 'PO-2083', client_id: 'client-5', area: 'Abucay',
    status: 'delivered',
    ...poListedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    driver_id: 'del-2', truck_plate: 'TXR 8890', sequence_no: 1,
    time_in: daysAgo(1, 10, 42), time_out: daysAgo(1, 10, 50),
    receiver_name: null, receiver_signature_url: signed('posig11'),
    proof_url: 'https://picsum.photos/seed/po11/400/300', backload_photo_url: null,
    gps_lat: 14.7233, gps_lng: 120.5341,
    remarks: 'Delivered — receiver declined to give a name',
    cod: true, cod_due: 6800, cod_amount: 6800, cod_method: 'gcash',
    cod_photo_url: 'https://picsum.photos/seed/po11cod/400/300', cod_remitted: true,
    created_at: daysAgo(2, 16, 30),
  },
  {
    // The proof photo never came through. The driver's app blocks "Delivered"
    // without one, so this row is the hole an admin has to chase.
    id: 'po-12', po_number: 'PO-2084', client_id: 'client-10', area: 'Orani',
    status: 'delivered',
    ...poListedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    driver_id: 'del-2', truck_plate: 'TXR 8890', sequence_no: 2,
    time_in: daysAgo(1, 15, 4), time_out: daysAgo(1, 15, 15),
    receiver_name: 'L. Domingo', receiver_signature_url: signed('posig12'),
    proof_url: null, backload_photo_url: null,
    // No photo means no fix, so this stop is missing from the trip line as well
    // as from the proof grid — one missing capture, both consequences.
    gps_lat: null, gps_lng: null,
    remarks: 'Delivered', ...noCod,
    created_at: daysAgo(2, 16, 30),
  },
  {
    // Failed yesterday and re-listed for today as po-4 — the same PO number on
    // two trip tickets, which is what a second attempt looks like. Shop was shut,
    // so there was nobody to sign.
    id: 'po-13', po_number: 'PO-2087', client_id: 'client-3', area: 'Dinalupihan',
    status: 'failed',
    ...poListedBy, scheduled_for: daysAgo(1, 8), listed_at: daysAgo(2, 16, 30),
    driver_id: 'del-2', truck_plate: 'TXR 8890', sequence_no: 3,
    time_in: daysAgo(1, 15, 52), time_out: daysAgo(1, 16, 5),
    receiver_name: null, receiver_signature_url: null, proof_url: null,
    backload_photo_url: 'https://picsum.photos/seed/po13bl/400/300',
    gps_lat: 14.8821, gps_lng: 120.4688,
    remarks: 'Consignee closed — full load came back',
    // COD, but nothing was handed over so nothing was collected — the amount
    // rides along to the re-listed attempt (po-4) untouched.
    cod: true, cod_due: 15400, cod_amount: null, cod_method: null,
    cod_photo_url: null, cod_remitted: false,
    created_at: daysAgo(2, 16, 30),
  },

  // --- Tomorrow's list: published ahead, nothing run yet ---------------------
  {
    id: 'po-14', po_number: 'PO-2098', client_id: 'client-12', area: 'Balanga',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(-1, 8), listed_at: daysAgo(0, 9, 20),
    ...unrun, remarks: null,
    cod: true, cod_due: 5400, cod_amount: null, cod_method: null,
    cod_photo_url: null, cod_remitted: false,
    created_at: daysAgo(0, 9, 20),
  },
  {
    id: 'po-15', po_number: 'PO-2099', client_id: 'client-3', area: 'Dinalupihan',
    status: 'pending',
    ...poListedBy, scheduled_for: daysAgo(-1, 8), listed_at: daysAgo(0, 9, 20),
    ...unrun, remarks: null, ...noCod,
    created_at: daysAgo(0, 9, 20),
  },
]

export const mockPurchaseOrders: PurchaseOrder[] = purchaseOrderSeed.map(po => {
  const client = clientById(po.client_id)
  return {
    ...po,
    client_name: client?.company_name ?? null,
    ...claimFor(po.id),
    client,
    driver: staffById(po.driver_id),
  }
})

// COD remittances. Office-only by design (2026-07-25, Addendum 4) — the driver's
// Remit screen dropped the 7-11 and bank-deposit destinations, so there is no
// destination to record and the receiver's signature is always required.
const codRemittanceSeed: Omit<CodRemittance, 'driver'>[] = [
  {
    id: 'cd-1', driver_id: 'del-1',
    amount_remitted: 12500, amount_collected: 12500, status: 'reconciled',
    receiver_name: 'Grace Villanueva',
    receiver_signature_url: signed('cdsig1'),
    po_ids: ['po-10'], submitted_at: daysAgo(1, 17, 20), created_at: daysAgo(1, 17, 20),
  },
  {
    // Short by ₱500 — the one row an admin must not miss, so variance sorts first.
    id: 'cd-2', driver_id: 'del-2',
    amount_remitted: 6300, amount_collected: 6800, status: 'variance',
    receiver_name: 'Grace Villanueva',
    receiver_signature_url: signed('cdsig2'),
    po_ids: ['po-11'], submitted_at: daysAgo(1, 17, 45), created_at: daysAgo(1, 17, 45),
  },
]

export const mockCodRemittances: CodRemittance[] = codRemittanceSeed.map(r => ({
  ...r, driver: staffById(r.driver_id),
}))
