'use client'

import { useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { meetingDurationMinutes, meetingGpsDriftMeters } from '@/lib/hooks/use-meetings'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { tagAlongsFor } from '@/lib/hooks/use-tag-alongs'
import {
  useSalesReportCounts,
  REPORT_AGENT_ROLES,
} from '@/lib/hooks/use-report-counts'
import { fetchSalesReportRows } from '@/lib/reports/sales-rows'
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

  // The cards are aggregates, so Postgres computes them (migration 136). The
  // EXPORTS are not — a spreadsheet is every row by definition — so their rows
  // are fetched when the button is pressed rather than on mount. Opening this
  // page used to download meetings, clients, clock records and the whole
  // tag-along ledger whether or not anyone pressed Download.
  const reportFilters = useMemo(
    () => ({ agentId: agentFilter, teamId: teamFilter, range: dateFilter.range }),
    [agentFilter, teamFilter, dateFilter.range],
  )

  const { counts, loading, error: loadError } = useSalesReportCounts(reportFilters)

  const { profiles, byRole } = useProfiles()
  const { teams } = useTeams()

  // Memoised because these arrays reach Combobox.Root as `items` via
  // ReportFilters. Rebuilt inline they would carry a new identity on every
  // render and make the picker re-derive its whole collection each time.
  const agents = useMemo(() => byRole([...REPORT_AGENT_ROLES]), [byRole])
  const agentOptions = useMemo(
    () => agents.map(a => ({ id: a.id, name: a.full_name, teamId: a.team_id })),
    [agents]
  )
  const teamOptions = useMemo(
    () => teamsWithManagers(teams.map(t => ({ id: t.id, name: t.name })), profiles),
    [teams, profiles]
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
      count: counts.meetings.count,
      countLabel: 'meeting records',
      // All four outcomes, so the tiles account for the count above them. Three
      // of them did not: 'no_decision' was absent, and its meetings simply went
      // missing from the card — 561 meetings reading as 381 + 74 + 4 on live
      // data. Counted over RECORDS for the same reason the count is: tiles that
      // sum to something other than the number above them is the original bug.
      stats: [
        { label: 'Successful', value: counts.meetings.successful },
        { label: 'Follow-up',  value: counts.meetings.followUp },
        { label: 'No Decision', value: counts.meetings.noDecision },
        { label: 'Lost',       value: counts.meetings.lost },
      ],
      onDownload: async () => {
        const { meetingParticipants, tagAlongsByMeetingId } = await fetchSalesReportRows(reportFilters)
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
        )
      },
    },
    {
      title: 'Clients Report',
      description: 'Full client list with type, channel, agent assignment, tag-alongs, and status',
      icon: Users,
      count: counts.clients.count,
      countLabel: 'clients',
      stats: [
        { label: 'Active', value: counts.clients.active },
        { label: 'Lost', value: counts.clients.lost },
        // The prospect family, in-progress included — same reading as the Clients
        // page filter. The export's per-row Customer Type column stays precise.
        { label: 'Prospects', value: counts.clients.prospects },
      ],
      onDownload: async () => {
        const { clients: rows, tagAlongsByClientId } = await fetchSalesReportRows(reportFilters)
        downloadSheet(
          rows.map(c => ({
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
        )
      },
    },
    {
      title: 'Clock Records Report',
      description: 'All clock in/out events with GPS coordinates and timestamps',
      icon: Clock,
      count: counts.clock.count,
      countLabel: 'records',
      stats: [
        { label: 'Office', value: counts.clock.office },
        { label: 'Event', value: counts.clock.event },
        { label: 'Clock In', value: counts.clock.clockIn },
      ],
      onDownload: async () => {
        const { clock } = await fetchSalesReportRows(reportFilters)
        downloadSheet(
          clock.map(r => ({
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
        )
      },
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
      <CutoffQuotaReport agents={agents} />

      <p className="text-xs text-muted-foreground text-center">
        Reports are exported as .xlsx files and include all data across every team.
      </p>
    </>
  )
}
