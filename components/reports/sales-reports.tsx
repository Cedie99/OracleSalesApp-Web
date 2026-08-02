'use client'

import { useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useMeetings, meetingDurationMinutes } from '@/lib/hooks/use-meetings'
import { useClients } from '@/lib/hooks/use-clients'
import { useClockRecords } from '@/lib/hooks/use-clock-records'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { ReportFilters, ReportGrid, downloadSheet, type ReportDefinition } from '@/components/reports/report-grid'
import { Users, CalendarCheck, Clock, Loader2 } from 'lucide-react'
import { format } from 'date-fns'

const OUTCOME_LABEL: Record<string, string> = {
  successful: 'Successful', follow_up: 'Follow-up Required',
  no_decision: 'No Decision', lost_opportunity: 'Lost Opportunity',
}

/** The Sales lens on Reports — meetings, clients, and clock records. */
export function SalesReports() {
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })
  const { inRange } = dateFilter

  const { meetings, loading: meetingsLoading, error: meetingsError } = useMeetings()
  const { clients, loading: clientsLoading, error: clientsError } = useClients()
  const { records: clockRecords, error: clockError } = useClockRecords()
  const { byRole } = useProfiles()

  const agents = byRole(['sales_specialist', 'sales_manager', 'rsr'])

  const loading = meetingsLoading || clientsLoading
  const loadError = meetingsError || clientsError || clockError

  const filteredMeetings = useMemo(
    () =>
      meetings
        .filter(m => agentFilter === 'all' || m.agent_id === agentFilter)
        .filter(m => inRange(m.meeting_date)),
    [meetings, agentFilter, inRange]
  )
  const filteredClients = useMemo(
    () =>
      clients
        .filter(c => agentFilter === 'all' || c.assigned_agent_id === agentFilter)
        .filter(c => inRange(c.created_at)),
    [clients, agentFilter, inRange]
  )
  const filteredClock = useMemo(
    () =>
      clockRecords
        .filter(r => agentFilter === 'all' || r.agent_id === agentFilter)
        .filter(r => inRange(r.timestamp)),
    [clockRecords, agentFilter, inRange]
  )

  const reports: ReportDefinition[] = [
    {
      title: 'Meetings Report',
      description: 'All client meetings with agenda, outcome, GPS, and photo flags',
      icon: CalendarCheck,
      count: filteredMeetings.length,
      countLabel: 'meetings',
      stats: [
        { label: 'Successful', value: filteredMeetings.filter(m => m.outcome === 'successful').length },
        { label: 'Follow-up', value: filteredMeetings.filter(m => m.outcome === 'follow_up').length },
        { label: 'Lost', value: filteredMeetings.filter(m => m.outcome === 'lost_opportunity').length },
      ],
      onDownload: () =>
        downloadSheet(
          filteredMeetings.map(m => {
            // Real duration from mobile's start/end capture pair. Blank rather
            // than 0 when either end is missing — an unrecorded duration is not
            // a zero-length meeting, and most historical rows predate the feature.
            const duration = meetingDurationMinutes(m)
            return {
              'Date': format(new Date(m.meeting_date), 'MMM d, yyyy h:mm a'),
              'Client': m.client?.company_name ?? '',
              'Agent': m.agent?.full_name ?? '',
              'Recorded By': m.recorder?.full_name ?? m.agent?.full_name ?? '',
              'Meeting Type': m.meeting_type === 'f2f' ? 'Face to Face' : m.online_platform === 'zoom' ? 'Zoom' : 'Google Meet',
              'Location': m.location_type === 'client_office' ? 'Client Office' : m.location_name ?? '',
              'Contact Person': m.contact_person,
              'Contact Position': m.contact_position ?? '',
              'Agenda': (m.agenda ?? []).join('; '),
              'Outcome': OUTCOME_LABEL[m.outcome] ?? m.outcome,
              'Duration (mins)': duration ?? '',
              'Remarks': m.remarks ?? '',
              'GPS': m.gps_lat != null ? `${m.gps_lat}, ${m.gps_lng}` : '',
              'Photo': m.photo_url ? 'Yes' : 'No',
            }
          }),
          'Meetings',
          'meetings-report'
        ),
    },
    {
      title: 'Clients Report',
      description: 'Full client list with type, channel, agent assignment, and status',
      icon: Users,
      count: filteredClients.length,
      countLabel: 'clients',
      stats: [
        { label: 'Active', value: filteredClients.filter(c => c.status === 'active').length },
        { label: 'Lost', value: filteredClients.filter(c => c.status === 'lost').length },
        { label: 'Prospects', value: filteredClients.filter(c => c.customer_type === 'prospect').length },
      ],
      onDownload: () =>
        downloadSheet(
          filteredClients.map(c => ({
            'Company Name': c.company_name,
            'Contact Person': c.contact_person,
            'Position': c.contact_position ?? '',
            'Contact Number': c.contact_number,
            'Office Address': c.office_address,
            'Customer Type': c.customer_type.charAt(0).toUpperCase() + c.customer_type.slice(1),
            'Sales Channel': c.sales_channel.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()),
            'Assigned Agent': c.agent?.full_name ?? '',
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
        label="Filter by agent"
        allLabel="All Agents"
        options={agents.map(a => ({ id: a.id, name: a.full_name }))}
        value={agentFilter}
        onChange={setAgentFilter}
        dateFilter={dateFilter}
      />

      <ReportGrid reports={reports} />

      <p className="text-xs text-muted-foreground text-center">
        Reports are exported as .xlsx files and include all data across every team.
      </p>
    </>
  )
}
