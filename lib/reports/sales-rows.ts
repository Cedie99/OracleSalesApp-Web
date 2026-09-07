'use client'

import { createClient } from '@/lib/supabase/client'
import { fetchAllPages } from '@/lib/supabase/paginate'
import { MEETING_COLUMNS } from '@/lib/hooks/use-meetings'
import { CLIENT_COLUMNS } from '@/lib/hooks/use-clients'
import { CLOCK_RECORD_COLUMNS } from '@/lib/hooks/use-clock-records'
import { fetchTagAlongs } from '@/lib/tag-along/actions'
import { tagAlongsByClient, tagAlongsByMeeting } from '@/lib/tag-along'
import type { Client, ClockRecord, Meeting, Profile, TagAlongRequest } from '@/types'

/**
 * The rows behind the Sales exports, fetched ON DEMAND.
 *
 * These used to arrive through the page's mounted hooks, which meant opening
 * Reports downloaded meetings, clients, clock records and the whole tag-along
 * ledger whether or not anyone pressed Download. The cards are served by
 * `get_sales_report_counts()` (migration 136) now, and this runs only from a
 * click.
 *
 * The filtering below is the component's own logic moved rather than rewritten,
 * so an export contains exactly the rows it always did. It is duplicated in SQL
 * for the CARD COUNTS in 136 — the two must agree, and the card disagreeing
 * with its own file is the failure mode to watch for.
 */

const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

export interface SalesReportFilters {
  /** 'all', or a profile id. A named agent also picks up their tag-alongs. */
  agentId: string
  /** 'all', or a team id. */
  teamId: string
  /** Resolved window; null means all time. */
  range: { start: Date; end: Date } | null
}

export interface SalesReportRows {
  /** One entry per person who was at a meeting — see meetingParticipants. */
  meetingParticipants: {
    meeting: Meeting
    participant: string
    participation: 'Agent' | 'Tagged along'
  }[]
  clients: Client[]
  clock: ClockRecord[]
  tagAlongsByMeetingId: Map<string, TagAlongRequest[]>
  tagAlongsByClientId: Map<string, TagAlongRequest[]>
}

function inRange(value: string | null | undefined, range: SalesReportFilters['range']) {
  if (!range || !value) return !range
  const t = new Date(value).getTime()
  return t >= range.start.getTime() && t <= range.end.getTime()
}

export async function fetchSalesReportRows(
  filters: SalesReportFilters,
): Promise<SalesReportRows> {
  const supabase = createClient()

  // Issued together rather than in sequence: four independent reads, and this
  // now runs while someone watches a spinner.
  const [meetingRows, clientRows, clockRows, tagAlongResult, profileResult] =
    await Promise.all([
      fetchAllPages<Record<string, unknown>>((from, to) =>
        supabase.from('meetings').select(MEETING_COLUMNS)
          .order('meeting_date', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
      fetchAllPages<Record<string, unknown>>((from, to) =>
        supabase.from('clients').select(CLIENT_COLUMNS)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
      fetchAllPages<Record<string, unknown>>((from, to) =>
        supabase.from('clock_records').select(CLOCK_RECORD_COLUMNS)
          .order('timestamp', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
      // Through a Server Function because RLS hides this table from admins
      // entirely — see the header of lib/tag-along/actions.ts.
      fetchTagAlongs(),
      supabase.from('profiles')
        .select('id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at'),
    ])

  if (tagAlongResult.error) throw new Error(tagAlongResult.error)
  if (profileResult.error) throw new Error(profileResult.error.message)

  const requests = tagAlongResult.requests
  const profiles = (profileResult.data ?? []) as Profile[]

  const meetings = meetingRows.map(row => ({
    ...(row as unknown as Meeting),
    contact_person: (row.contact_person as string | null) ?? '',
    agenda: (row.agenda as string[] | null) ?? [],
    client: one<Client>(row.client),
    agent: one<Profile>(row.agent),
    recorder: one<Profile>(row.recorder),
  }))

  const clients = clientRows.map(row => ({
    ...(row as unknown as Client),
    contact_person: (row.contact_person as string | null) ?? '',
    contact_number: (row.contact_number as string | null) ?? '',
    office_address: (row.office_address as string | null) ?? '',
    customer_type: (row.customer_type as Client['customer_type'] | null) ?? 'prospect',
    agent: one<Profile>(row.agent),
  }))

  const clock = clockRows.map(row => ({
    ...(row as unknown as ClockRecord),
    agent: one<Profile>(row.agent),
  }))

  // Team membership resolved from `profiles`, not from each row's embedded
  // agent: clock records carry no join and a client's agent may be absent, so
  // one membership set keeps the three reports agreeing on what a team means.
  const teamAgentIds =
    filters.teamId === 'all'
      ? null
      : new Set(profiles.filter(p => p.team_id === filters.teamId).map(p => p.id))

  const inTeam = (agentId: string | null | undefined) =>
    teamAgentIds == null || (agentId != null && teamAgentIds.has(agentId))

  // What the selected agent reached by tagging along. A manager's tag-alongs
  // are part of their own coverage, not a separate category — joining an
  // agent's visit is how a manager works an account, and filtering by ownership
  // alone understated every manager's fortnight. Declined and cancelled are
  // left out: nobody attended those.
  const forAgent =
    filters.agentId === 'all'
      ? []
      : requests.filter(
          r =>
            r.invitee_id === filters.agentId &&
            (r.status === 'accepted' || r.status === 'pending'),
        )
  const taggedMeetingIds = new Set(
    forAgent.map(r => r.related_meeting_id).filter(Boolean) as string[],
  )
  const taggedClientIds = new Set(
    forAgent.map(r => r.related_client_id).filter(Boolean) as string[],
  )

  const filteredMeetings = meetings
    .filter(m => filters.agentId === 'all' || m.agent_id === filters.agentId || taggedMeetingIds.has(m.id))
    // A tagged-along meeting belongs to the agent who logged it, so the team
    // test stays on `agent_id` — the row is still that team's work.
    .filter(m => inTeam(m.agent_id) || taggedMeetingIds.has(m.id))
    .filter(m => inRange(m.meeting_date, filters.range))

  const filteredClients = clients
    .filter(c => filters.agentId === 'all' || c.assigned_agent_id === filters.agentId || taggedClientIds.has(c.id))
    .filter(c => inTeam(c.assigned_agent_id) || taggedClientIds.has(c.id))
    .filter(c => inRange(c.created_at, filters.range))

  const filteredClock = clock
    .filter(r => filters.agentId === 'all' || r.agent_id === filters.agentId)
    .filter(r => inTeam(r.agent_id))
    .filter(r => inRange(r.timestamp, filters.range))

  const byMeeting = tagAlongsByMeeting(requests)
  const byClient = tagAlongsByClient(requests)

  /**
   * One row per person who was at a meeting.
   *
   * Which companions become a row is migration 076's rule, copied exactly —
   * `invitee_kind = 'manager'`, `status = 'accepted'`, and never the meeting's
   * own agent. Anything looser and this file stops agreeing with the quota
   * panel, which is the whole point of counting attendances. So three kinds of
   * companion are deliberately not rows: a teammate (no manager quota exists
   * for them to earn), a manager whose request is still pending (076 waits for
   * the answer before crediting anyone), and a declined or cancelled request.
   */
  const meetingParticipants = filteredMeetings.flatMap(m => {
    const owner = {
      meeting: m,
      participant: m.agent?.full_name ?? '',
      participation: 'Agent' as const,
    }
    const companions = (byMeeting.get(m.id) ?? [])
      .filter(
        r =>
          r.invitee_kind === 'manager' &&
          r.status === 'accepted' &&
          r.invitee_id !== m.agent_id,
      )
      .map(r => ({
        meeting: m,
        participant: r.invitee_name ?? 'Unknown',
        participation: 'Tagged along' as const,
      }))
    return [owner, ...companions]
  })

  return {
    meetingParticipants,
    clients: filteredClients,
    clock: filteredClock,
    tagAlongsByMeetingId: byMeeting,
    tagAlongsByClientId: byClient,
  }
}
