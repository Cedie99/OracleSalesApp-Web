'use client'

import { useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useMeetings, meetingDurationMinutes, meetingGpsDriftMeters } from '@/lib/hooks/use-meetings'
import { useClients } from '@/lib/hooks/use-clients'
import { useClockRecords } from '@/lib/hooks/use-clock-records'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { useTagAlongs, tagAlongsFor } from '@/lib/hooks/use-tag-alongs'
import { MANAGER_GATE_LABEL, companionParticipants, managerGate } from '@/lib/tag-along'
import { useTeams } from '@/lib/hooks/use-teams'
import { teamsWithManagers } from '@/lib/teams'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { ReportFilters, ReportGrid, downloadSheet, type ReportDefinition } from '@/components/reports/report-grid'
import { CutoffQuotaReport } from '@/components/reports/cutoff-quota-report'
import { CUSTOMER_TYPE_LABEL } from '@/lib/status-styles'
import { Users, CalendarCheck, Clock, Loader2 } from 'lucide-react'
import { format } from 'date-fns'

const OUTCOME_LABEL: Record<string, string> = {
  successful: 'Successful', follow_up: 'Follow-up Required',
  no_decision: 'No Decision', lost_opportunity: 'Lost Opportunity',
}

/** The Sales lens on Reports — meetings, clients, and clock records. */
export function SalesReports() {
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [teamFilter, setTeamFilter] = useState<string>('all')
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })
  const { inRange } = dateFilter

  const { meetings, loading: meetingsLoading, error: meetingsError } = useMeetings()
  const { clients, loading: clientsLoading, error: clientsError } = useClients()
  const { records: clockRecords, error: clockError } = useClockRecords()
  const {
    byMeeting: tagAlongsByMeetingId,
    byClient: tagAlongsByClientId,
    byInvitee: tagAlongsByInviteeId,
  } = useTagAlongs()
  const { profiles, byRole } = useProfiles()
  const { teams } = useTeams()

  // Memoised because these arrays reach Combobox.Root as `items` via
  // ReportFilters. Rebuilt inline they would carry a new identity on every
  // render and make the picker re-derive its whole collection each time.
  const agents = useMemo(
    () => byRole(['sales_specialist', 'sales_manager', 'rsr']),
    [byRole]
  )
  const agentOptions = useMemo(
    () => agents.map(a => ({ id: a.id, name: a.full_name, teamId: a.team_id })),
    [agents]
  )
  const teamOptions = useMemo(
    () => teamsWithManagers(teams.map(t => ({ id: t.id, name: t.name })), profiles),
    [teams, profiles]
  )

  const loading = meetingsLoading || clientsLoading
  const loadError = meetingsError || clientsError || clockError

  /**
   * Which agents the team filter admits. Resolved from `profiles` rather than
   * from each row's embedded agent, because clock records carry no join and a
   * client's agent may be absent — one membership set keeps the three reports
   * agreeing on what "Sales Team 1" means.
   */
  const teamAgentIds = useMemo(() => {
    if (teamFilter === 'all') return null
    return new Set(agents.filter(a => a.team_id === teamFilter).map(a => a.id))
  }, [agents, teamFilter])

  const inTeam = (agentId: string | null | undefined) =>
    teamAgentIds == null || (agentId != null && teamAgentIds.has(agentId))

  /**
   * The meetings and accounts the filtered agent reached by tagging along.
   *
   * A manager's tag-alongs are part of their own coverage, not a separate
   * category — joining an agent's visit is how a manager works an account.
   * Filtering these reports by ownership alone understated every manager's
   * fortnight, and disagreed with the Meetings page about the same person.
   *
   * Declined and cancelled are left out: nobody attended those.
   */
  const taggedAlong = useMemo(() => {
    const empty = { meetingIds: null as Set<string> | null, clientIds: null as Set<string> | null }
    if (agentFilter === 'all') return empty
    const requests = (tagAlongsByInviteeId.get(agentFilter) ?? []).filter(
      r => r.status === 'accepted' || r.status === 'pending'
    )
    return {
      meetingIds: new Set(requests.map(r => r.related_meeting_id).filter(Boolean) as string[]),
      clientIds: new Set(requests.map(r => r.related_client_id).filter(Boolean) as string[]),
    }
  }, [tagAlongsByInviteeId, agentFilter])

  const filteredMeetings = useMemo(
    () =>
      meetings
        .filter(m => agentFilter === 'all' || m.agent_id === agentFilter || taggedAlong.meetingIds?.has(m.id))
        // A tagged-along meeting belongs to the agent who logged it, so the team
        // test stays on `agent_id` — the row is still that team's work.
        .filter(m => inTeam(m.agent_id) || taggedAlong.meetingIds?.has(m.id))
        .filter(m => inRange(m.meeting_date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meetings, agentFilter, teamAgentIds, inRange, taggedAlong]
  )
  const filteredClients = useMemo(
    () =>
      clients
        .filter(c => agentFilter === 'all' || c.assigned_agent_id === agentFilter || taggedAlong.clientIds?.has(c.id))
        .filter(c => inTeam(c.assigned_agent_id) || taggedAlong.clientIds?.has(c.id))
        .filter(c => inRange(c.created_at)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clients, agentFilter, teamAgentIds, inRange, taggedAlong]
  )
  const filteredClock = useMemo(
    () =>
      clockRecords
        .filter(r => agentFilter === 'all' || r.agent_id === agentFilter)
        .filter(r => inTeam(r.agent_id))
        .filter(r => inRange(r.timestamp)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clockRecords, agentFilter, teamAgentIds, inRange]
  )

  /**
   * One row per person who was at a meeting — the Meetings Report's unit.
   *
   * A meeting used to be one row, which made a manager's tag-along invisible in
   * the file and left the card reporting 555 where the quota panel reported 565
   * for the same cutoff. Those are not a discrepancy — the panel counts CREDITS
   * and a manager who tagged along earns one of their own (076) — but a reader
   * had no way to see that, and a manager could not find their own work in the
   * export at all.
   *
   * Which companions become a row is migration 076's rule, copied exactly —
   * `invitee_kind = 'manager'`, `status = 'accepted'`, and never the meeting's
   * own agent. Anything looser and this card would stop agreeing with the quota
   * panel again, which is the whole point of counting attendances here.
   *
   * So three kinds of companion are deliberately NOT rows: a teammate who came
   * along (no manager quota exists for them to earn), a manager whose request
   * is still pending (076 waits for the answer before crediting anyone), and a
   * declined or cancelled request (nobody attended). The pending case is the
   * one to watch — those visits appear as agent-only here until the manager
   * confirms, and the `Manager Confirmation` column is what flags them.
   */
  const meetingParticipants = useMemo(
    () =>
      filteredMeetings.flatMap(m => {
        const owner = {
          meeting: m,
          participant: m.agent?.full_name ?? '',
          participation: 'Agent' as const,
        }
        const companions = tagAlongsFor(tagAlongsByMeetingId, m.id)
          .filter(
            r =>
              r.invitee_kind === 'manager' &&
              r.status === 'accepted' &&
              r.invitee_id !== m.agent_id
          )
          .map(r => ({
            meeting: m,
            participant: r.invitee_name ?? 'Unknown',
            participation: 'Tagged along' as const,
          }))
        return [owner, ...companions]
      }),
    [filteredMeetings, tagAlongsByMeetingId]
  )

  const reports: ReportDefinition[] = [
    {
      title: 'Meetings Report',
      description:
        'One meeting record per attendee — the agent, and any manager who tagged along — with agenda, outcome, start/end GPS, and photo flags',
      icon: CalendarCheck,
      // RECORDS, one per attendee, so this figure is exactly the number of rows
      // in the file it downloads. A meeting with a manager along is two records
      // because two people worked it, which is the same reading the quota
      // ledger takes (076) and the reason a manager's monthly target is
      // reachable at all.
      count: meetingParticipants.length,
      countLabel: 'meeting records',
      // All four outcomes, so the tiles account for the count above them. Three
      // of them did not: 'no_decision' was absent, and its meetings simply went
      // missing from the card — 561 meetings reading as 381 + 74 + 4 on live
      // data. Counted over RECORDS for the same reason the count is: tiles that
      // sum to something other than the number above them is the original bug.
      stats: [
        {
          label: 'Successful',
          value: meetingParticipants.filter(p => p.meeting.outcome === 'successful').length,
        },
        {
          label: 'Follow-up',
          value: meetingParticipants.filter(p => p.meeting.outcome === 'follow_up').length,
        },
        {
          label: 'No Decision',
          value: meetingParticipants.filter(p => p.meeting.outcome === 'no_decision').length,
        },
        {
          label: 'Lost',
          value: meetingParticipants.filter(p => p.meeting.outcome === 'lost_opportunity').length,
        },
      ],
      onDownload: () =>
        downloadSheet(
          meetingParticipants.map(({ meeting: m, participant, participation }) => {
            // Real duration from mobile's start/end capture pair. Blank rather
            // than 0 when either end is missing — an unrecorded duration is not
            // a zero-length meeting, and most historical rows predate the feature.
            const duration = meetingDurationMinutes(m)
            const gate = managerGate(tagAlongsFor(tagAlongsByMeetingId, m.id))
            return {
              // Who this row is about, before the meeting it belongs to. The
              // file is filtered and pivoted on these two more than on anything
              // else — "show me this manager's fortnight" is one filter now,
              // where before it could not be asked of this sheet at all.
              'Participant': participant,
              'Participation': participation,
              'Date': format(new Date(m.meeting_date), 'MMM d, yyyy h:mm a'),
              'Client': m.client?.company_name ?? '',
              // Kept on tagged-along rows too, so a companion's row still says
              // whose meeting they joined. Equal to Participant on agent rows.
              'Meeting Agent': m.agent?.full_name ?? '',
              'Recorded By': m.recorder?.full_name ?? m.agent?.full_name ?? '',
              'Meeting Type': m.meeting_type === 'f2f' ? 'Face to Face' : m.online_platform === 'zoom' ? 'Zoom' : 'Google Meet',
              'Location': m.location_type === 'client_office' ? 'Client Office' : m.location_name ?? '',
              'Contact Person': m.contact_person,
              'Contact Position': m.contact_position ?? '',
              'Agenda': (m.agenda ?? []).join('; '),
              'Outcome': OUTCOME_LABEL[m.outcome] ?? m.outcome,
              'Duration (mins)': duration ?? '',
              'Remarks': m.remarks ?? '',
              // Both fixes and the gap between them, in adjacent columns: the
              // export is where an admin checks a cutoff's worth of meetings at
              // once, and start-vs-end is the comparison ADR-019 traded the
              // start photo for. Blank, never 0, when the pair is incomplete.
              'Start GPS': m.gps_lat != null ? `${m.gps_lat}, ${m.gps_lng}` : '',
              'End GPS': m.end_gps_lat != null ? `${m.end_gps_lat}, ${m.end_gps_lng}` : '',
              'Start-End Gap (m)': meetingGpsDriftMeters(m) ?? '',
              // The old 'Tagged Along' flag and 'Companions' list are gone: each
              // companion is a row of its own now, so both were restating in
              // prose what the Participation column states as data. The gate
              // stays — it is the only one with a consequence attached, and it
              // is blank when no manager was invited, which is not the same
              // fact as an approval that is missing.
              'Manager Confirmation': gate === 'none' ? '' : MANAGER_GATE_LABEL[gate],
              'Photo': m.photo_url ? 'Yes' : 'No',
            }
          }),
          'Meetings',
          'meetings-report'
        ),
    },
    {
      title: 'Clients Report',
      description: 'Full client list with type, channel, agent assignment, tag-alongs, and status',
      icon: Users,
      count: filteredClients.length,
      countLabel: 'clients',
      stats: [
        { label: 'Active', value: filteredClients.filter(c => c.status === 'active').length },
        { label: 'Lost', value: filteredClients.filter(c => c.status === 'lost').length },
        // The prospect family, in-progress included — same reading as the Clients
        // page filter. The export's per-row Customer Type column stays precise.
        {
          label: 'Prospects',
          value: filteredClients.filter(c => c.customer_type === 'prospect' || c.customer_type === 'in_progress').length,
        },
      ],
      onDownload: () =>
        downloadSheet(
          filteredClients.map(c => ({
            'Company Name': c.company_name,
            'Contact Person': c.contact_person,
            'Position': c.contact_position ?? '',
            'Contact Number': c.contact_number,
            'Office Address': c.office_address,
            // Via the label map, not a charAt-uppercase: the four-stage lifecycle
            // (migration 038) made that produce "In_progress" in the spreadsheet.
            'Customer Type': CUSTOMER_TYPE_LABEL[c.customer_type] ?? c.customer_type,
            'Sales Channel': c.sales_channel.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()),
            'Assigned Agent': c.agent?.full_name ?? '',
            // This sheet lists accounts the filtered agent tagged along on as
            // well as the ones assigned to them, so `Assigned Agent` alone no
            // longer explains why a row is here. Everyone who joined a visit on
            // the account, deduplicated across its whole meeting history.
            'Tag-Along Participants': companionParticipants(tagAlongsFor(tagAlongsByClientId, c.id)),
            'Status': c.status.charAt(0).toUpperCase() + c.status.slice(1),
            'Created': format(new Date(c.created_at), 'MMM d, yyyy'),
          })),
          'Clients',
          'clients-report'
        ),
    },
    {
      title: 'Clock Records Report',
      description: 'All clock in/out events with GPS coordinates and timestamps',
      icon: Clock,
      count: filteredClock.length,
      countLabel: 'records',
      stats: [
        { label: 'Office', value: filteredClock.filter(r => r.type === 'office').length },
        { label: 'Event', value: filteredClock.filter(r => r.type === 'event').length },
        { label: 'Clock In', value: filteredClock.filter(r => r.action === 'in').length },
      ],
      onDownload: () =>
        downloadSheet(
          filteredClock.map(r => ({
            'Agent': r.agent?.full_name ?? '',
            'Type': r.type === 'office' ? 'Office' : 'Event',
            'Action': r.action === 'in' ? 'Clock In' : 'Clock Out',
            'Event Name': r.event_name ?? '',
            'Timestamp': format(new Date(r.timestamp), 'MMM d, yyyy h:mm a'),
            'GPS': r.gps_lat ? `${r.gps_lat}, ${r.gps_lng}` : '',
            'Photo': r.photo_url ? 'Yes' : 'No',
          })),
          'Clock Records',
          'clock-report'
        ),
    },
  ]

  return (
    <>
      {loadError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            Couldn&apos;t load report data: {loadError}
          </AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading live data…
        </div>
      )}

      <ReportFilters
        label="Agent"
        allLabel="All Agents"
        options={agentOptions}
        value={agentFilter}
        onChange={setAgentFilter}
        dateFilter={dateFilter}
        teams={teamOptions}
        teamValue={teamFilter}
        onTeamChange={setTeamFilter}
      />

      <ReportGrid reports={reports} />

      {/* Deliberately outside the grid and below it. It answers a different
          question from the three exports above — those are "what happened",
          this is "what counted" — and it is scoped by cutoff period rather than
          by the toolbar's agent and date filters, which do not apply to it. */}
      <CutoffQuotaReport
        clients={clients}
        agents={agents}
        meetings={meetings}
        tagAlongsByMeeting={tagAlongsByMeetingId}
      />

      <p className="text-xs text-muted-foreground text-center">
        Reports are exported as .xlsx files and include all data across every team.
      </p>
    </>
  )
}
