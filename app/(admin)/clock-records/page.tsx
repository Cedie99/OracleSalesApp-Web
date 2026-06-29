'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { mockClockRecords } from '@/lib/mock/data'
import type { ClockType, ClockAction } from '@/types'
import { Search, Clock, MapPin, Camera, LogIn, LogOut, Calendar } from 'lucide-react'
import { format } from 'date-fns'

const TYPE_STYLE: Record<ClockType, string> = {
  office: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  event: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

const ACTION_STYLE: Record<ClockAction, string> = {
  in: 'bg-primary/15 text-primary border-primary/30',
  out: 'bg-muted text-muted-foreground border-border',
}

export default function ClockRecordsPage() {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [actionFilter, setActionFilter] = useState<string>('all')

  const filtered = mockClockRecords.filter(r => {
    const matchSearch = (r.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (r.event_name ?? '').toLowerCase().includes(search.toLowerCase())
    const matchType = typeFilter === 'all' || r.type === typeFilter
    const matchAction = actionFilter === 'all' || r.action === actionFilter
    return matchSearch && matchType && matchAction
  })

  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, r) => {
    const day = format(new Date(r.timestamp), 'yyyy-MM-dd')
    if (!acc[day]) acc[day] = []
    acc[day].push(r)
    return acc
  }, {})

  return (
    <div className="flex flex-col flex-1">
      <Header title="Clock Records" subtitle={`${filtered.length} records`} />

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
          <Select value={actionFilter} onValueChange={v => setActionFilter(v ?? 'all')}>
            <SelectTrigger className="w-32 h-9 bg-card border-border">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="in">Clock In</SelectItem>
              <SelectItem value="out">Clock Out</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Grouped by date */}
        {Object.entries(grouped)
          .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
          .map(([day, records]) => (
            <div key={day}>
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">
                  {format(new Date(day), 'EEEE, MMMM d, yyyy')}
                </p>
              </div>

              <Card className="bg-card border-border overflow-hidden">
                <div className="divide-y divide-border">
                  {records
                    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                    .map(record => (
                      <div key={record.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/20 transition-colors">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${record.action === 'in' ? 'bg-primary/10' : 'bg-muted'}`}>
                          {record.action === 'in'
                            ? <LogIn className="w-4 h-4 text-primary" />
                            : <LogOut className="w-4 h-4 text-muted-foreground" />
                          }
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{record.agent?.full_name}</p>
                            <Badge variant="outline" className={`text-[10px] px-1.5 h-4 ${ACTION_STYLE[record.action]}`}>
                              Clock {record.action.toUpperCase()}
                            </Badge>
                            <Badge variant="outline" className={`text-[10px] px-1.5 h-4 ${TYPE_STYLE[record.type]}`}>
                              {record.type === 'office' ? 'Office' : 'Event'}
                            </Badge>
                          </div>
                          {record.event_name && (
                            <p className="text-xs text-muted-foreground mt-0.5">{record.event_name}</p>
                          )}
                        </div>

                        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                          {record.gps_lat && (
                            <div className="flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-primary" />
                              <span>{record.gps_lat.toFixed(3)}, {record.gps_lng?.toFixed(3)}</span>
                            </div>
                          )}
                          {record.photo_url && <Camera className="w-3.5 h-3.5 text-primary" />}
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{format(new Date(record.timestamp), 'h:mm a')}</span>
                          </div>
                        </div>
                      </div>
                    ))}
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
