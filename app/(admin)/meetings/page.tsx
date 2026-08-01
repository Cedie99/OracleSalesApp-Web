'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Pagination } from '@/components/ui/pagination'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useMeetings } from '@/lib/hooks/use-meetings'
import type { Meeting, MeetingOutcome } from '@/types'
import {
  Search, CalendarCheck, MapPin, Camera, Video, Navigation, Users, CheckCircle2, Loader2,
  Clock, HelpCircle, XCircle, ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, ChevronDown, ArrowLeft,
} from 'lucide-react'
import { format } from 'date-fns'
import { OUTCOME_LABEL, OUTCOME_TONE, TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import { CATEGORY_LABEL, categoryForAgent, type TeamCategory } from '@/lib/teams'

/**
 * Keys are normalised (see `agendaIcon`) rather than written as the mobile app
 * spells them, because the two had already drifted: this map was keyed
 * 'Product/Company presentation' and 'Terms and Limit negotiation' while the
 * database actually holds "Product / company presentation" and "Terms & limit
 * negotiation", so three of the nine live agenda values silently rendered
 * without an icon.
 */
const AGENDA_ICONS: Record<string, string> = {
  'new business opportunity': '💼',
  'product company presentation': '📊',
  'price negotiation quotation': '💰',
  'terms limit negotiation': '📋',
  'negotiation other matters': '🤝',
  'collection': '💳',
  'technical support': '🔧',
  'marketing support': '📣',
  'complaint resolution': '⚠️',
  'relationship building': '🫱',
  'closed deal': '✅',
}

/** Lowercase, drop punctuation/connectives, collapse whitespace. */
function normalizeAgenda(agenda: string): string {
  return agenda
    .toLowerCase()
    .replace(/[/&,()]/g, ' ')
    .replace(/\b(and|or)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function agendaIcon(agenda: string): string {
  return AGENDA_ICONS[normalizeAgenda(agenda)] ?? '•'
}

type TypeFilter = 'all' | 'f2f' | 'online'

type SortKey = 'client' | 'agent' | 'type' | 'location' | 'date' | 'outcome'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** Which direction a column opens on first click — dates read newest-first everywhere else, the rest A-Z. */
const DEFAULT_SORT_DIR: Record<SortKey, SortState['dir']> = {
  client: 'asc',
  agent: 'asc',
  type: 'asc',
  location: 'asc',
  date: 'desc',
  outcome: 'asc',
}

/** Severity order for the Outcome column — not alphabetical, so sorting groups worst-to-best (or reverse). */
const OUTCOME_ORDER: MeetingOutcome[] = ['successful', 'follow_up', 'no_decision', 'lost_opportunity']

export default function MeetingsPage() {
  const [search, setSearch] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [selected, setSelected] = useState<Meeting | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' })
  const [expandedCategory, setExpandedCategory] = useState<TeamCategory | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const { meetings, loading, error } = useMeetings()
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })

  const counts = {
    total: meetings.length,
    f2f: meetings.filter(m => m.meeting_type === 'f2f').length,
    // Mirrors the table row's own fallback (`m.online_platform === 'zoom' ? 'Zoom' : 'Google Meet'`)
    // rather than checking for the literal 'googlemeet' value, since seeded/live rows often leave
    // online_platform null and the rest of this page already treats "online, not Zoom" as Google Meet.
    googleMeet: meetings.filter(m => m.meeting_type === 'online' && m.online_platform !== 'zoom').length,
    successful: meetings.filter(m => m.outcome === 'successful').length,
    followUp: meetings.filter(m => m.outcome === 'follow_up').length,
    noDecision: meetings.filter(m => m.outcome === 'no_decision').length,
    lost: meetings.filter(m => m.outcome === 'lost_opportunity').length,
  }

  const filtered = meetings.filter(m => {
    const matchSearch =
      (m.client?.company_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (m.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      m.contact_person.toLowerCase().includes(search.toLowerCase())
    const matchOutcome = outcomeFilter === 'all' || m.outcome === outcomeFilter
    const matchType = typeFilter === 'all' || m.meeting_type === typeFilter
    return matchSearch && matchOutcome && matchType && dateFilter.inRange(m.meeting_date)
  })

  // Group meetings by agent so the table isn't a wall of every agent's rows at
  // once — same Teams -> agents -> records drill-down as the Clients page.
  interface AgentGroup { agentId: string; agentName: string; category: TeamCategory; meetings: Meeting[] }
  const groups = useMemo(() => {
    const map = new Map<string, AgentGroup>()
    for (const m of filtered) {
      const agentId = m.agent_id ?? 'unassigned'
      const agentName = m.agent?.full_name ?? 'Unassigned'
      let group = map.get(agentId)
      if (!group) {
        group = { agentId, agentName, category: categoryForAgent(m.agent), meetings: [] }
        map.set(agentId, group)
      }
      group.meetings.push(m)
    }
    return Array.from(map.values()).sort((a, b) => a.agentName.localeCompare(b.agentName))
  }, [filtered])

  const categories = useMemo(() => {
    return (['rsr', 'sales', 'other'] as const)
      .map(category => {
        const catGroups = groups.filter(g => g.category === category)
        const meetingCount = catGroups.reduce((sum, g) => sum + g.meetings.length, 0)
        return { category, agentCount: catGroups.length, meetingCount }
      })
      .filter(c => c.category !== 'other' || c.agentCount > 0)
  }, [groups])

  const selectedGroup = selectedAgentId ? groups.find(g => g.agentId === selectedAgentId) ?? null : null

  function toggleSort(key: SortKey) {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: DEFAULT_SORT_DIR[key] }
    )
  }

  const sorted = [...(selectedGroup?.meetings ?? [])].sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1
    // Every column falls back to client name so equal rows keep a stable order.
    const byClient = (a.client?.company_name ?? '').localeCompare(b.client?.company_name ?? '', undefined, { sensitivity: 'base' })

    switch (sort.key) {
      case 'client':
        return dir * byClient

      case 'agent': {
        const agent = (a.agent?.full_name ?? '').localeCompare(b.agent?.full_name ?? '', undefined, { sensitivity: 'base' })
        return agent ? dir * agent : byClient
      }

      case 'type': {
        const type = a.meeting_type.localeCompare(b.meeting_type)
        return type ? dir * type : byClient
      }

      case 'location': {
        const aLoc = a.location_type === 'client_office' ? 'Client Office' : (a.location_name ?? '')
        const bLoc = b.location_type === 'client_office' ? 'Client Office' : (b.location_name ?? '')
        const loc = aLoc.localeCompare(bLoc, undefined, { sensitivity: 'base' })
        return loc ? dir * loc : byClient
      }

      case 'date': {
        const date = new Date(a.meeting_date).getTime() - new Date(b.meeting_date).getTime()
        return date ? dir * date : byClient
      }

      case 'outcome': {
        const rank = OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome)
        return rank ? dir * rank : byClient
      }
    }
  })

  const { pageItems, page, pageCount, from, to, total, setPage } = usePagination(
    sorted, 10, `${selectedAgentId}|${search}|${outcomeFilter}|${typeFilter}|${dateFilter.key}|${sort.key}|${sort.dir}`,
  )

  return (
    <div className="flex flex-col flex-1">
      <Header title="Meetings" subtitle={`${filtered.length} of ${meetings.length} records`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {([
            { label: 'Total Meetings', value: counts.total, icon: CalendarCheck, color: 'text-foreground' },
            { label: 'Face to Face', value: counts.f2f, icon: Navigation, color: 'text-primary' },
            { label: 'Google Meet', value: counts.googleMeet, icon: Video, color: 'text-primary' },
            { label: 'Successful', value: counts.successful, icon: CheckCircle2, color: TONE_TEXT[OUTCOME_TONE.successful] },
            { label: 'Follow-up', value: counts.followUp, icon: Clock, color: TONE_TEXT[OUTCOME_TONE.follow_up] },
            { label: 'No Decision', value: counts.noDecision, icon: HelpCircle, color: TONE_TEXT[OUTCOME_TONE.no_decision] },
            { label: 'Lost', value: counts.lost, icon: XCircle, color: TONE_TEXT[OUTCOME_TONE.lost_opportunity] },
          ] as const).map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="bg-card border-border last:col-span-2 sm:last:col-span-1">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Icon className={`w-4 h-4 ${color}`} />
                </div>
                <div>
                  <p className={`text-xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

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
          <Tabs value={typeFilter} onValueChange={v => setTypeFilter(v as TypeFilter)}>
            <TabsList className="h-9">
              <TabsTrigger value="all" className="px-3">All</TabsTrigger>
              <TabsTrigger value="f2f" className="px-3">
                <Navigation className="w-3.5 h-3.5" /> F2F
              </TabsTrigger>
              <TabsTrigger value="online" className="px-3">
                <Video className="w-3.5 h-3.5" /> Online
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <DateRangeFilter filter={dateFilter} />
        </div>

        {loading && (
          <div className="text-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
            <p className="text-sm">Loading meetings…</p>
          </div>
        )}

        {!loading && error && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              Couldn&apos;t load meetings: {error}
            </AlertDescription>
          </Alert>
        )}

        {!loading && !error && !selectedGroup && (
          <>
            {/* Teams — click a manager to drop down its agents right below it */}
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Teams
            </p>
            <div className="space-y-3">
              {categories.map(({ category, agentCount, meetingCount }) => {
                const isOpen = expandedCategory === category
                const catGroups = groups.filter(g => g.category === category)
                return (
                  <div key={category} className="rounded-lg border border-border bg-card overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedCategory(isOpen ? null : category)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Users className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{CATEGORY_LABEL[category]}</p>
                          <p className="text-xs text-muted-foreground">
                            {agentCount} agent{agentCount === 1 ? '' : 's'} · {meetingCount} meeting{meetingCount === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="bg-muted/40 border-t border-border p-4 pl-6 space-y-2.5">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                          Agents under {CATEGORY_LABEL[category]}
                        </p>
                        {catGroups.map(group => (
                          <button
                            key={group.agentId}
                            type="button"
                            onClick={() => setSelectedAgentId(group.agentId)}
                            className="w-full flex items-center justify-between gap-3 p-3 rounded-lg bg-card border border-border shadow-sm text-left hover:border-primary/40 hover:bg-accent/30 transition-colors"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                                <span className="text-xs font-bold text-primary">
                                  {group.agentName.charAt(0)}
                                </span>
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground truncate">{group.agentName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {group.meetings.length} meeting{group.meetings.length === 1 ? '' : 's'}
                                </p>
                              </div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {!loading && !error && selectedGroup && (
          <>
            {/* Selected agent's meetings */}
            <div className="space-y-3">
              <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => setSelectedAgentId(null)}>
                <ArrowLeft className="w-4 h-4" />
                Back to agents
              </Button>

              <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-primary">
                    {selectedGroup.agentName.charAt(0)}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Agent</p>
                  <p className="text-base font-semibold text-foreground truncate">{selectedGroup.agentName}</p>
                  <p className="text-xs text-muted-foreground">
                    {selectedGroup.meetings.length} meeting{selectedGroup.meetings.length === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
            </div>

            {/* Table */}
            <Card className="bg-card border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <SortHeader label="Client" sortKey="client" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Agent" sortKey="agent" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Type" sortKey="type" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Location" sortKey="location" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Outcome" sortKey="outcome" sort={sort} onSort={toggleSort} />
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pageItems.map(m => (
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
                          <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[m.outcome]]}>
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

                {sorted.length === 0 && (
                  <div className="text-center py-16 text-muted-foreground">
                    <CalendarCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No meetings match these filters</p>
                  </div>
                )}
              </div>
            </Card>

            <Pagination
              page={page} pageCount={pageCount} onPageChange={setPage}
              from={from} to={to} total={total} itemLabel="meetings"
            />
          </>
        )}
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
                <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[selected.outcome]]}>
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
                      {agendaIcon(a)} {a}
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

function SortHeader({
  label, sortKey, sort, onSort, className,
}: {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sort.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown

  return (
    <th
      className={`text-left px-4 py-3 text-xs font-medium text-muted-foreground ${className ?? ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1.5 transition-colors hover:text-foreground ${
          active ? 'text-foreground' : ''
        }`}
      >
        {label}
        <Icon className={`w-3.5 h-3.5 ${active ? '' : 'opacity-40'}`} />
      </button>
    </th>
  )
}
