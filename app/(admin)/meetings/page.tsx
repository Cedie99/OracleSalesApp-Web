'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mockMeetings } from '@/lib/mock/data'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import type { MeetingOutcome } from '@/types'
import { Search, CalendarCheck, MapPin, Camera, Video, Users, CheckCircle2 } from 'lucide-react'
import { format } from 'date-fns'

const OUTCOME_STYLE: Record<MeetingOutcome, string> = {
  successful: 'bg-primary/15 text-primary border-primary/30',
  follow_up: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  no_decision: 'bg-muted text-muted-foreground border-border',
  lost_opportunity: 'bg-destructive/15 text-destructive border-destructive/30',
}

const OUTCOME_LABEL: Record<MeetingOutcome, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up Required',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost Opportunity',
}

const AGENDA_ICONS: Record<string, string> = {
  'New business opportunity': '💼',
  'Product/Company presentation': '📊',
  'Price negotiation/quotation': '💰',
  'Terms and Limit negotiation': '📋',
  'Negotiation (other matters)': '🤝',
  'Collection': '💳',
  'Technical support': '🔧',
  'Marketing support': '📣',
  'Complaint resolution': '⚠️',
  'Relationship building': '🫱',
  'Closed deal': '✅',
}

export default function MeetingsPage() {
  const [search, setSearch] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [selected, setSelected] = useState<(typeof mockMeetings)[0] | null>(null)
  const { profile } = useCurrentProfile()
  const isAdmin = profile?.role === 'admin'

  const scopedMeetings = isAdmin
    ? mockMeetings
    : mockMeetings.filter(m => m.agent?.team_id === profile?.team_id)

  const filtered = scopedMeetings.filter(m => {
    const matchSearch =
      (m.client?.company_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (m.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      m.contact_person.toLowerCase().includes(search.toLowerCase())
    const matchOutcome = outcomeFilter === 'all' || m.outcome === outcomeFilter
    const matchType = typeFilter === 'all' || m.meeting_type === typeFilter
    return matchSearch && matchOutcome && matchType
  })

  return (
    <div className="flex flex-col flex-1">
      <Header title="Meetings" subtitle={`${filtered.length} records`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search client, agent, or contact..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-card border-border h-9"
            />
          </div>
          <Select value={outcomeFilter} onValueChange={v => setOutcomeFilter(v ?? 'all')}>
            <SelectTrigger className="w-40 h-9 bg-card border-border">
              <SelectValue placeholder="Outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Outcomes</SelectItem>
              <SelectItem value="successful">Successful</SelectItem>
              <SelectItem value="follow_up">Follow-up</SelectItem>
              <SelectItem value="no_decision">No Decision</SelectItem>
              <SelectItem value="lost_opportunity">Lost</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={v => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="w-32 h-9 bg-card border-border">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="f2f">F2F</SelectItem>
              <SelectItem value="online">Online</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card className="bg-card border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Client</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Agent</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Location</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Outcome</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(m => (
                  <tr
                    key={m.id}
                    onClick={() => setSelected(m)}
                    className="hover:bg-muted/20 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground truncate max-w-[160px]">{m.client?.company_name}</p>
                      <p className="text-xs text-muted-foreground">{m.contact_person}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-foreground">{m.agent?.full_name}</p>
                      {m.recorder && (
                        <p className="text-xs text-muted-foreground">+ {m.recorder.full_name}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {m.meeting_type === 'f2f'
                          ? <Users className="w-3.5 h-3.5 text-muted-foreground" />
                          : <Video className="w-3.5 h-3.5 text-muted-foreground" />
                        }
                        <span className="text-xs text-muted-foreground">
                          {m.meeting_type === 'f2f' ? 'F2F' : m.online_platform === 'zoom' ? 'Zoom' : 'Google Meet'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                          {m.location_type === 'client_office' ? 'Client Office' : m.location_name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(m.meeting_date), 'MMM d, yyyy')}<br/>
                      {format(new Date(m.meeting_date), 'h:mm a')}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${OUTCOME_STYLE[m.outcome]}`}>
                        {OUTCOME_LABEL[m.outcome]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        {m.gps_lat && <MapPin className="w-3.5 h-3.5 text-primary" />}
                        {m.photo_url && <Camera className="w-3.5 h-3.5 text-primary" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <CalendarCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No meetings found</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Meeting Detail Dialog */}
      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        <DialogContent className="bg-card border-border max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Meeting Details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-foreground">{selected.client?.company_name}</p>
                  <p className="text-xs text-muted-foreground">{selected.contact_person}{selected.contact_position ? ` · ${selected.contact_position}` : ''}</p>
                </div>
                <Badge variant="outline" className={`${OUTCOME_STYLE[selected.outcome]}`}>
                  {OUTCOME_LABEL[selected.outcome]}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-muted-foreground mb-1">Agent</p>
                  <p className="text-foreground font-medium">{selected.agent?.full_name}</p>
                  {selected.recorder && <p className="text-muted-foreground">Assisted by {selected.recorder.full_name}</p>}
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-muted-foreground mb-1">Date & Time</p>
                  <p className="text-foreground font-medium">{format(new Date(selected.meeting_date), 'MMM d, yyyy')}</p>
                  <p className="text-muted-foreground">{format(new Date(selected.meeting_date), 'h:mm a')}</p>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-muted-foreground mb-1">Type</p>
                  <p className="text-foreground font-medium capitalize">
                    {selected.meeting_type === 'f2f' ? 'Face to Face' : selected.online_platform === 'zoom' ? 'Zoom' : 'Google Meet'}
                  </p>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-muted-foreground mb-1">Location</p>
                  <p className="text-foreground font-medium">
                    {selected.location_type === 'client_office' ? 'Client Office' : selected.location_name}
                  </p>
                  {selected.gps_lat && (
                    <p className="text-muted-foreground">{selected.gps_lat.toFixed(4)}, {selected.gps_lng?.toFixed(4)}</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-2">Agenda</p>
                <div className="flex flex-wrap gap-1.5">
                  {selected.agenda.map(a => (
                    <Badge key={a} variant="outline" className="text-[10px] bg-primary/5 border-primary/20 text-primary">
                      {AGENDA_ICONS[a] ?? '•'} {a}
                    </Badge>
                  ))}
                </div>
              </div>

              {selected.remarks && (
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Remarks</p>
                  <p className="text-sm text-foreground">{selected.remarks}</p>
                </div>
              )}

              <div className="flex gap-2 text-xs text-muted-foreground pt-1 border-t border-border">
                {selected.gps_lat && (
                  <div className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-primary" /> GPS captured
                  </div>
                )}
                {selected.photo_url && (
                  <div className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-primary" /> Photo taken
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
