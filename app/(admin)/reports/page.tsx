'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { mockMeetings, mockClients, mockClockRecords, mockProfiles } from '@/lib/mock/data'
import { FileBarChart2, Download, FileSpreadsheet, Users, CalendarCheck, Clock } from 'lucide-react'
import { format } from 'date-fns'
import * as XLSX from 'xlsx'

const OUTCOME_LABEL: Record<string, string> = {
  successful: 'Successful', follow_up: 'Follow-up Required',
  no_decision: 'No Decision', lost_opportunity: 'Lost Opportunity',
}

function inRange(dateStr: string, from: string, to: string): boolean {
  const d = new Date(dateStr)
  if (from && d < new Date(from)) return false
  if (to && d > new Date(`${to}T23:59:59`)) return false
  return true
}

export default function ReportsPage() {
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')

  const agents = mockProfiles.filter(p =>
    p.role === 'sales_specialist' || p.role === 'sales_manager' || p.role === 'rsr'
  )
  const scopedMeetingsBase = mockMeetings
  const scopedClientsBase = mockClients
  const scopedClockBase = mockClockRecords

  function downloadMeetingsReport() {
    const data = scopedMeetingsBase
      .filter(m => agentFilter === 'all' || m.agent_id === agentFilter)
      .filter(m => inRange(m.meeting_date, dateFrom, dateTo))
      .map(m => ({
        'Date': format(new Date(m.meeting_date), 'MMM d, yyyy h:mm a'),
        'Client': m.client?.company_name ?? '',
        'Agent': m.agent?.full_name ?? '',
        'Recorded By': m.recorder?.full_name ?? m.agent?.full_name ?? '',
        'Meeting Type': m.meeting_type === 'f2f' ? 'Face to Face' : m.online_platform === 'zoom' ? 'Zoom' : 'Google Meet',
        'Location': m.location_type === 'client_office' ? 'Client Office' : m.location_name ?? '',
        'Contact Person': m.contact_person,
        'Contact Position': m.contact_position ?? '',
        'Agenda': m.agenda.join('; '),
        'Outcome': OUTCOME_LABEL[m.outcome] ?? m.outcome,
        'Remarks': m.remarks ?? '',
        'GPS': m.gps_lat ? `${m.gps_lat}, ${m.gps_lng}` : '',
      }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Meetings')
    XLSX.writeFile(wb, `meetings-report-${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
  }

  function downloadClientsReport() {
    const data = scopedClientsBase
      .filter(c => agentFilter === 'all' || c.assigned_agent_id === agentFilter)
      .filter(c => inRange(c.created_at, dateFrom, dateTo))
      .map(c => ({
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
      }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Clients')
    XLSX.writeFile(wb, `clients-report-${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
  }

  function downloadClockReport() {
    const data = scopedClockBase
      .filter(r => agentFilter === 'all' || r.agent_id === agentFilter)
      .filter(r => inRange(r.timestamp, dateFrom, dateTo))
      .map(r => ({
        'Agent': r.agent?.full_name ?? '',
        'Type': r.type === 'office' ? 'Office' : 'Event',
        'Action': r.action === 'in' ? 'Clock In' : 'Clock Out',
        'Event Name': r.event_name ?? '',
        'Timestamp': format(new Date(r.timestamp), 'MMM d, yyyy h:mm a'),
        'GPS': r.gps_lat ? `${r.gps_lat}, ${r.gps_lng}` : '',
        'Photo': r.photo_url ? 'Yes' : 'No',
      }))

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Clock Records')
    XLSX.writeFile(wb, `clock-report-${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
  }

  const filteredMeetings = scopedMeetingsBase
    .filter(m => agentFilter === 'all' || m.agent_id === agentFilter)
    .filter(m => inRange(m.meeting_date, dateFrom, dateTo))
  const filteredClients = scopedClientsBase
    .filter(c => agentFilter === 'all' || c.assigned_agent_id === agentFilter)
    .filter(c => inRange(c.created_at, dateFrom, dateTo))
  const filteredClock = scopedClockBase
    .filter(r => agentFilter === 'all' || r.agent_id === agentFilter)
    .filter(r => inRange(r.timestamp, dateFrom, dateTo))

  const reportTypes = [
    {
      title: 'Meetings Report',
      description: 'All client meetings with agenda, outcome, GPS, and photo flags',
      icon: CalendarCheck,
      count: filteredMeetings.length,
      countLabel: 'meetings',
      onDownload: downloadMeetingsReport,
      stats: [
        { label: 'Successful', value: filteredMeetings.filter(m => m.outcome === 'successful').length },
        { label: 'Follow-up', value: filteredMeetings.filter(m => m.outcome === 'follow_up').length },
        { label: 'Lost', value: filteredMeetings.filter(m => m.outcome === 'lost_opportunity').length },
      ],
    },
    {
      title: 'Clients Report',
      description: 'Full client list with type, channel, agent assignment, and status',
      icon: Users,
      count: filteredClients.length,
      countLabel: 'clients',
      onDownload: downloadClientsReport,
      stats: [
        { label: 'Active', value: filteredClients.filter(c => c.status === 'active').length },
        { label: 'Lost', value: filteredClients.filter(c => c.status === 'lost').length },
        { label: 'Prospects', value: filteredClients.filter(c => c.customer_type === 'prospect').length },
      ],
    },
    {
      title: 'Clock Records Report',
      description: 'All clock in/out events with GPS coordinates and timestamps',
      icon: Clock,
      count: filteredClock.length,
      countLabel: 'records',
      onDownload: downloadClockReport,
      stats: [
        { label: 'Office', value: filteredClock.filter(r => r.type === 'office').length },
        { label: 'Event', value: filteredClock.filter(r => r.type === 'event').length },
        { label: 'Clock In', value: filteredClock.filter(r => r.action === 'in').length },
      ],
    },
  ]

  return (
    <div className="flex flex-col flex-1">
      <Header title="Reports" subtitle="Export data as Excel files" />

      <div className="flex-1 p-6 space-y-5">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          <FileBarChart2 className="w-4 h-4 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Filter by agent:</p>
          <Select value={agentFilter} onValueChange={v => setAgentFilter(v ?? 'all')}>
            <SelectTrigger className="w-48 h-9 bg-card border-border">
              <SelectValue placeholder="All Agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {agents.map(a => (
                <SelectItem key={a.id} value={a.id}>{a.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <p className="text-sm text-muted-foreground">Date range:</p>
          <Input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="w-40 h-9 bg-card border-border"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="w-40 h-9 bg-card border-border"
          />

          {(agentFilter !== 'all' || dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-muted-foreground"
              onClick={() => { setAgentFilter('all'); setDateFrom(''); setDateTo('') }}
            >
              Clear filters
            </Button>
          )}

          {agentFilter !== 'all' && (
            <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
              Agent: {agents.find(a => a.id === agentFilter)?.full_name}
            </Badge>
          )}
          {(dateFrom || dateTo) && (
            <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
              {dateFrom || '…'} → {dateTo || '…'}
            </Badge>
          )}
        </div>

        {/* Report cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {reportTypes.map(({ title, description, icon: Icon, count, countLabel, onDownload, stats }) => (
            <Card key={title} className="bg-card border-border">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-foreground">{count}</p>
                    <p className="text-xs text-muted-foreground">{countLabel}</p>
                  </div>
                </div>
                <CardTitle className="text-sm font-semibold text-foreground mt-2">{title}</CardTitle>
                <p className="text-xs text-muted-foreground">{description}</p>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex gap-2 mb-4">
                  {stats.map(s => (
                    <div key={s.label} className="flex-1 bg-muted/30 rounded-lg p-2 text-center">
                      <p className="text-sm font-semibold text-foreground">{s.value}</p>
                      <p className="text-[10px] text-muted-foreground">{s.label}</p>
                    </div>
                  ))}
                </div>
                <Button
                  onClick={onDownload}
                  className="w-full h-9 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 text-xs font-medium"
                  variant="outline"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Download Excel
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Export note */}
        <p className="text-xs text-muted-foreground text-center">
          Reports are exported as .xlsx files and include all data across every team.
        </p>
      </div>
    </div>
  )
}
