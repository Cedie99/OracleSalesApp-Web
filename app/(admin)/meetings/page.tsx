'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { useProfiles } from '@/lib/hooks/use-profiles'
import type { Meeting, MeetingOutcome } from '@/types'
import {
  Search, CalendarCheck, MapPin, Map as MapIcon, Camera, Video, Navigation, Users, CheckCircle2, Loader2,
  Clock, HelpCircle, XCircle, ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, ChevronDown, ArrowLeft, User, ExternalLink,
} from 'lucide-react'
import { format } from 'date-fns'
import { OUTCOME_LABEL, OUTCOME_TONE, TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import { managerForTeam } from '@/lib/teams'

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
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [selected, setSelected] = useState<Meeting | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' })
  const [expandedManagerKey, setExpandedManagerKey] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedManagerKey, setSelectedManagerKey] = useState<string | null>(null)
  const { meetings, loading, error } = useMeetings()
  const { byRole } = useProfiles()
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })

  // The actual managers, so the top of the hierarchy lists real people instead
  // of a generic RSR/Sales bucket — same rule as the Clients page.
  const managers = useMemo(
    () => [...byRole(['sales_manager'])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [byRole],
  )

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
  // once — same manager -> agents -> records drill-down as the Clients page.
  interface AgentGroup { agentId: string; agentName: string; managerKey: string; meetings: Meeting[] }
  const groups = useMemo(() => {
    const map = new Map<string, AgentGroup>()
    for (const m of filtered) {
      const agentId = m.agent_id ?? 'unassigned'
      const agentName = m.agent?.full_name ?? 'Unassigned'
      let group = map.get(agentId)
      if (!group) {
        const managerKey = managerForTeam(m.agent?.team_id, managers)?.id ?? 'unassigned'
        group = { agentId, agentName, managerKey, meetings: [] }
        map.set(agentId, group)
      }
      group.meetings.push(m)
    }
    return Array.from(map.values()).sort((a, b) => a.agentName.localeCompare(b.agentName))
  }, [filtered, managers])

  const managerBuckets = useMemo(() => {
    const buckets = managers.map(m => {
      const managerGroups = groups.filter(g => g.managerKey === m.id)
      const meetingCount = managerGroups.reduce((sum, g) => sum + g.meetings.length, 0)
      // The manager's own footprint — meetings they personally recorded solo
      // (agent_id is them) or tagged along on with one of their agents
      // (recorded_by is them) — distinct from meetingCount, which is the
      // whole team's total.
      const ownMeetingCount = filtered.filter(mt => mt.agent_id === m.id || mt.recorded_by === m.id).length
      return { key: m.id, label: m.full_name, agentCount: managerGroups.length, meetingCount, ownMeetingCount }
    })
    const unassignedGroups = groups.filter(g => g.managerKey === 'unassigned')
    if (unassignedGroups.length > 0) {
      buckets.push({
        key: 'unassigned',
        label: 'Unassigned',
        agentCount: unassignedGroups.length,
        meetingCount: unassignedGroups.reduce((sum, g) => sum + g.meetings.length, 0),
        ownMeetingCount: 0,
      })
    }
    return buckets
  }, [managers, groups, filtered])

  const selectedGroup = selectedAgentId ? groups.find(g => g.agentId === selectedAgentId) ?? null : null

  // A manager's own records — meetings they personally attended, whether
  // solo (agent_id is them) or tagging along on an agent's visit
  // (recorded_by is them). This is deliberately *not* the whole team's
  // meetings — just the manager's own footprint, matching the mobile app.
  const selectedManagerBucket = selectedManagerKey
    ? managerBuckets.find(b => b.key === selectedManagerKey) ?? null
    : null
  const managerMeetings = useMemo(
    () => (selectedManagerKey
      ? filtered.filter(mt => mt.agent_id === selectedManagerKey || mt.recorded_by === selectedManagerKey)
      : []),
    [selectedManagerKey, filtered],
  )
  const activeMeetings = selectedGroup?.meetings ?? (selectedManagerBucket ? managerMeetings : null)

  function toggleSort(key: SortKey) {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: DEFAULT_SORT_DIR[key] }
    )
  }

  const sorted = [...(activeMeetings ?? [])].sort((a, b) => {
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
    sorted, 10, `${selectedAgentId}|${selectedManagerKey}|${search}|${outcomeFilter}|${typeFilter}|${dateFilter.key}|${sort.key}|${sort.dir}`,
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

        {!loading && !error && !selectedGroup && !selectedManagerBucket && (
          <>
            {/* Managers — click one to drop down their team's agents right below it */}
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Managers
            </p>
            <div className="space-y-3">
              {managerBuckets.map(({ key, label, agentCount, meetingCount, ownMeetingCount }) => {
                const isOpen = expandedManagerKey === key
                const bucketGroups = groups.filter(g => g.managerKey === key)
                return (
                  <div key={key} className="rounded-lg border border-border bg-card overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedManagerKey(isOpen ? null : key)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Users className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{label}</p>
                          <p className="text-xs text-muted-foreground">
                            {agentCount} agent{agentCount === 1 ? '' : 's'} · {meetingCount} meeting{meetingCount === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="bg-muted/40 border-t border-border p-4 pl-6 space-y-4">
                        {key !== 'unassigned' && (
                          <div className="space-y-2.5">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                              Manager
                            </p>
                            <button
                              type="button"
                              onClick={() => { setSelectedManagerKey(key); setSelectedAgentId(null) }}
                              className="w-full flex items-center justify-between gap-3 p-3 rounded-lg bg-card border border-primary/50 shadow-sm text-left hover:border-primary hover:bg-primary/5 transition-colors"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                                  <span className="text-xs font-bold text-primary">
                                    {label.charAt(0)}
                                  </span>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-foreground truncate">{label}</p>
                                  <p className="text-xs text-muted-foreground">
                                    Tag-along: {ownMeetingCount} record{ownMeetingCount === 1 ? '' : 's'}
                                  </p>
                                </div>
                              </div>
                              <ChevronRight className="w-4 h-4 text-primary shrink-0" />
                            </button>
                          </div>
                        )}

                        <div className="space-y-2.5">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                            Agents under {label}
                          </p>
                          {bucketGroups.map(group => (
                            <button
                              key={group.agentId}
                              type="button"
                              onClick={() => { setSelectedAgentId(group.agentId); setSelectedManagerKey(null) }}
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
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {!loading && !error && (selectedGroup || selectedManagerBucket) && (
          <>
            {/* Selected agent's or manager's meetings */}
            <div className="space-y-3">
              <Button
                variant="outline" size="sm" className="h-9 gap-2"
                onClick={() => { setSelectedAgentId(null); setSelectedManagerKey(null) }}
              >
                <ArrowLeft className="w-4 h-4" />
                Back to agents
              </Button>

              <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-primary">
                    {(selectedGroup?.agentName ?? selectedManagerBucket?.label ?? '').charAt(0)}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    {selectedGroup ? 'Agent' : 'Manager · Tag-along records'}
                  </p>
                  <p className="text-base font-semibold text-foreground truncate">
                    {selectedGroup?.agentName ?? selectedManagerBucket?.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(activeMeetings ?? []).length} meeting{(activeMeetings ?? []).length === 1 ? '' : 's'}
                  </p>
                </div>
                {selectedGroup && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => router.push(`/maps?module=sales&agent=${encodeURIComponent(selectedGroup.agentId)}`)}
                  >
                    <MapIcon /> View on map
                  </Button>
                )}
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
        <DialogContent className="bg-card border-border sm:max-w-2xl p-6">
          <DialogHeader className="sr-only">
            <DialogTitle>Meeting Details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-5 text-sm pt-1">
              <div className="min-w-0">
                <p className="font-semibold text-foreground text-lg truncate">{selected.client?.company_name}</p>
                <p className="text-sm text-muted-foreground truncate">{selected.contact_person}{selected.contact_position ? ` · ${selected.contact_position}` : ''}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-muted/40 rounded-xl p-4 shadow-[0_1px_2px_rgba(18,39,28,0.05)]">
                  <div className="flex items-center gap-2 text-muted-foreground mb-2.5">
                    <div className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <User className="w-3.5 h-3.5" />
                    </div>
                    <p className="text-xs">Agent</p>
                  </div>
                  <p className="text-foreground font-semibold">{selected.agent?.full_name}</p>
                  {selected.recorder && <p className="text-xs text-muted-foreground mt-1">Assisted by {selected.recorder.full_name}</p>}
                </div>
                <div className="bg-muted/40 rounded-xl p-4 shadow-[0_1px_2px_rgba(18,39,28,0.05)]">
                  <div className="flex items-center gap-2 text-muted-foreground mb-2.5">
                    <div className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <CalendarCheck className="w-3.5 h-3.5" />
                    </div>
                    <p className="text-xs">Date & Time</p>
                  </div>
                  <p className="text-foreground font-semibold">{format(new Date(selected.meeting_date), 'MMM d, yyyy')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{format(new Date(selected.meeting_date), 'h:mm a')}</p>
                </div>
                <div className="bg-muted/40 rounded-xl p-4 shadow-[0_1px_2px_rgba(18,39,28,0.05)]">
                  <div className="flex items-center gap-2 text-muted-foreground mb-2.5">
                    <div className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      {selected.meeting_type === 'f2f' ? <Navigation className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                    </div>
                    <p className="text-xs">Type</p>
                  </div>
                  <p className="text-foreground font-semibold capitalize">
                    {selected.meeting_type === 'f2f' ? 'Face to Face' : selected.online_platform === 'zoom' ? 'Zoom' : 'Google Meet'}
                  </p>
                </div>
                {selected.gps_lat ? (
                  <a
                    href={`https://www.google.com/maps?q=${selected.gps_lat},${selected.gps_lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block rounded-xl bg-muted/40 p-4 shadow-[0_1px_2px_rgba(18,39,28,0.05)] transition-colors hover:bg-muted/70"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <div className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                          <MapPin className="w-3.5 h-3.5" />
                        </div>
                        <p className="text-xs">Location</p>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-primary shrink-0" />
                    </div>
                    <p className="text-foreground font-semibold group-hover:text-primary transition-colors">
                      {selected.location_type === 'client_office' ? 'Client Office' : selected.location_name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{selected.gps_lat.toFixed(4)}, {selected.gps_lng?.toFixed(4)}</p>
                  </a>
                ) : (
                  <div className="bg-muted/40 rounded-xl p-4 shadow-[0_1px_2px_rgba(18,39,28,0.05)]">
                    <div className="flex items-center gap-2 text-muted-foreground mb-2.5">
                      <div className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <MapPin className="w-3.5 h-3.5" />
                      </div>
                      <p className="text-xs">Location</p>
                    </div>
                    <p className="text-foreground font-semibold">
                      {selected.location_type === 'client_office' ? 'Client Office' : selected.location_name}
                    </p>
                  </div>
                )}
              </div>

              {selected.remarks && (
                <div className="bg-muted/40 rounded-xl p-4 shadow-[0_1px_2px_rgba(18,39,28,0.05)]">
                  <p className="text-xs text-muted-foreground mb-1.5 font-medium">Remarks</p>
                  <p className="text-sm text-foreground leading-relaxed">{selected.remarks}</p>
                </div>
              )}

              <div>
                <p className="text-xs text-muted-foreground mb-2.5 font-medium">Agenda</p>
                <div className="flex flex-wrap gap-2">
                  {selected.agenda.map(a => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      {a}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2.5 pt-3 border-t border-border">
                <div className="flex gap-2.5">
                  {selected.gps_lat && (
                    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted/40 rounded-full px-3 py-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" /> GPS captured
                    </div>
                  )}
                  {selected.photo_url && (
                    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted/40 rounded-full px-3 py-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" /> Photo taken
                    </div>
                  )}
                </div>
                <Badge variant="tone" className={`shrink-0 text-sm px-3 py-1 ${TONE_CLASS[OUTCOME_TONE[selected.outcome]]}`}>
                  {OUTCOME_LABEL[selected.outcome]}
                </Badge>
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
