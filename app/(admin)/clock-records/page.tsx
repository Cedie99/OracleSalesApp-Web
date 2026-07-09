'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { mockClockRecords } from '@/lib/mock/data'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { ROLE_LABEL } from '@/lib/permissions'
import type { ClockRecord, ClockType, Profile } from '@/types'
import { Search, Clock, MapPin, Calendar } from 'lucide-react'
import { format, differenceInMinutes } from 'date-fns'

const TYPE_STYLE: Record<ClockType, string> = {
  office: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  event: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

interface AttendanceRow {
  key: string
  agent: Profile | undefined
  day: string
  type: ClockType
  eventName: string | null
  clockIn: ClockRecord | null
  clockOut: ClockRecord | null
}

function pairIntoAttendanceRows(records: ClockRecord[]): AttendanceRow[] {
  const rows = new Map<string, AttendanceRow>()
  records.forEach(r => {
    const day = format(new Date(r.timestamp), 'yyyy-MM-dd')
    const key = `${r.agent_id}|${day}`
    if (!rows.has(key)) {
      rows.set(key, { key, agent: r.agent, day, type: r.type, eventName: r.event_name, clockIn: null, clockOut: null })
    }
    const row = rows.get(key)!
    if (r.action === 'in') row.clockIn = r
    else row.clockOut = r
  })
  return Array.from(rows.values())
}

function formatDuration(row: AttendanceRow): string {
  if (!row.clockIn || !row.clockOut) return '—'
  const mins = differenceInMinutes(new Date(row.clockOut.timestamp), new Date(row.clockIn.timestamp))
  if (mins < 0) return '—'
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// Shared by every day's table so column widths stay identical across all
// of them, even though each day renders as its own separate <table>.
function ClockTableColgroup() {
  return (
    <colgroup>
      <col className="w-[26%]" />
      <col className="w-[14%]" />
      <col className="w-[13%]" />
      <col className="w-[13%]" />
      <col className="w-[12%]" />
      <col className="w-[22%]" />
    </colgroup>
  )
}

function locationLabel(row: AttendanceRow): string {
  if (row.eventName) return row.eventName
  const lat = row.clockIn?.gps_lat ?? row.clockOut?.gps_lat
  const lng = row.clockIn?.gps_lng ?? row.clockOut?.gps_lng
  return lat != null && lng != null ? `${lat.toFixed(3)}, ${lng.toFixed(3)}` : '—'
}

export default function ClockRecordsPage() {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const { profile } = useCurrentProfile()
  const isAdmin = profile?.role === 'admin'

  const scopedClockRecords = isAdmin
    ? mockClockRecords
    : mockClockRecords.filter(r => r.agent?.team_id === profile?.team_id)

  const agentOptions = useMemo(() => {
    const byId = new Map<string, string>()
    scopedClockRecords.forEach(r => {
      if (r.agent) byId.set(r.agent.id, r.agent.full_name)
    })
    return Array.from(byId, ([id, full_name]) => ({ id, full_name }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, [scopedClockRecords])

  const rows = useMemo(() => pairIntoAttendanceRows(scopedClockRecords), [scopedClockRecords])

  const filtered = rows.filter(row => {
    const matchSearch = (row.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (row.eventName ?? '').toLowerCase().includes(search.toLowerCase())
    const matchType = typeFilter === 'all' || row.type === typeFilter
    const matchAgent = agentFilter === 'all' || row.agent?.id === agentFilter
    const d = new Date(row.day)
    const afterFrom = !dateFrom || d >= new Date(dateFrom)
    const beforeTo = !dateTo || d <= new Date(`${dateTo}T23:59:59`)
    return matchSearch && matchType && matchAgent && afterFrom && beforeTo
  })

  const grouped = filtered.reduce<Record<string, AttendanceRow[]>>((acc, row) => {
    if (!acc[row.day]) acc[row.day] = []
    acc[row.day].push(row)
    return acc
  }, {})

  return (
    <div className="flex flex-col flex-1">
      <Header title="Clock Records" subtitle={`${filtered.length} attendance records`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search agent or event..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-card border-border h-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={v => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="w-32 h-9 bg-card border-border">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="office">Office</SelectItem>
              <SelectItem value="event">Event</SelectItem>
            </SelectContent>
          </Select>
          <Select value={agentFilter} onValueChange={v => setAgentFilter(v ?? 'all')}>
            <SelectTrigger className="w-44 h-9 bg-card border-border">
              <SelectValue placeholder="All Agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {agentOptions.map(agent => (
                <SelectItem key={agent.id} value={agent.id}>{agent.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="w-40 h-9 bg-card border-border"
          />
          <span className="text-sm text-muted-foreground self-center">to</span>
          <Input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="w-40 h-9 bg-card border-border"
          />
        </div>

        {/* Separate table per day, but every table shares the exact same
            table-fixed + colgroup widths so columns still align vertically
            down the page without merging everything into one giant table. */}
        {Object.entries(grouped)
          .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
          .map(([day, dayRows]) => (
            <div key={day}>
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">
                  {format(new Date(day), 'EEEE, MMMM d, yyyy')}
                </p>
              </div>

              <Card className="bg-card border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm table-fixed min-w-[720px]">
                    <ClockTableColgroup />
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="text-left px-4 py-2.5 font-medium">User</th>
                        <th className="text-left px-4 py-2.5 font-medium">Role</th>
                        <th className="text-left px-4 py-2.5 font-medium">Clock In</th>
                        <th className="text-left px-4 py-2.5 font-medium">Clock Out</th>
                        <th className="text-left px-4 py-2.5 font-medium">Duration</th>
                        <th className="text-left px-4 py-2.5 font-medium">Location</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {dayRows
                        .sort((a, b) => (a.agent?.full_name ?? '').localeCompare(b.agent?.full_name ?? ''))
                        .map(row => (
                          <tr key={row.key} className="hover:bg-muted/20 transition-colors">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <p className="font-medium text-foreground truncate">{row.agent?.full_name ?? '—'}</p>
                                <Badge variant="outline" className={`text-[10px] px-1.5 h-4 shrink-0 ${TYPE_STYLE[row.type]}`}>
                                  {row.type === 'office' ? 'Office' : 'Event'}
                                </Badge>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                              {row.agent ? ROLE_LABEL[row.agent.role] : '—'}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {row.clockIn ? format(new Date(row.clockIn.timestamp), 'h:mm a') : '—'}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {row.clockOut ? format(new Date(row.clockOut.timestamp), 'h:mm a') : '—'}
                            </td>
                            <td className="px-4 py-3 font-medium text-foreground">
                              {formatDuration(row)}
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                              <div className="flex items-center gap-1 min-w-0">
                                {!row.eventName && (row.clockIn?.gps_lat ?? row.clockOut?.gps_lat) != null && (
                                  <MapPin className="w-3 h-3 text-primary shrink-0" />
                                )}
                                <span className="truncate">{locationLabel(row)}</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ))}

        {filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No clock records found</p>
          </div>
        )}
      </div>
    </div>
  )
}
