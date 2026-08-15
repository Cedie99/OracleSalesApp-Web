'use client'

import { Suspense, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Pagination } from '@/components/ui/pagination'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useMeetings, meetingGpsDriftMeters, meetingDurationMinutes } from '@/lib/hooks/use-meetings'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { useTagAlongs, tagAlongsFor } from '@/lib/hooks/use-tag-alongs'
import { CompanionLine, CompanionList, ManagerGateIcon } from '@/components/tag-along-indicator'
import { MANAGER_GATE_LABEL, MANAGER_GATE_TONE, managerGate } from '@/lib/tag-along'
import type { Meeting, MeetingOutcome } from '@/types'
import {
  Search, CalendarCheck, MapPin, MapPinCheck, Map as MapIcon, Camera, Video, Navigation, Users, CheckCircle2, Loader2,
  Clock, HelpCircle, XCircle, ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, ChevronDown, ArrowLeft, User,
  Building2, Phone, ListChecks, FileText, Tag, X as XIcon,
} from 'lucide-react'
import { format } from 'date-fns'
import {
  CUSTOMER_TYPE_LABEL, meetingStageBadge, OUTCOME_LABEL, OUTCOME_TONE, TONE_CLASS, TONE_TEXT,
} from '@/lib/status-styles'
import { managerForTeam } from '@/lib/teams'
import { formatDistanceMeters, formatDurationMinutes } from '@/lib/utils'

const MeetingRouteMap = dynamic(() => import('@/components/maps/meeting-route-map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground bg-muted/40">
      Loading map…
    </div>
  ),
})

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

/** One field in the Meeting Detail dialog's grid — matches the Clients page's meeting popup exactly. */
function DetailLine({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-muted-foreground">{label}</p>
        <p className="text-foreground font-medium break-words">{value}</p>
      </div>
    </div>
  )
}

/**
 * `useSearchParams` forces the client tree up to the nearest Suspense boundary
 * to render on the client, and Next's docs are explicit that an otherwise
 * statically prerendered page calling it **fails the production build** without
 * one — while working fine in dev. Hence the split, same as the Maps page: the
 * default export below is that boundary, and this is what it wraps.
 */
function MeetingsPageContent() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [picked, setPicked] = useState<Meeting | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' })
  const [expandedManagerKey, setExpandedManagerKey] = useState<string | null>(null)
  /**
   * Where the admin has driven the hierarchy themselves. Null until they touch
   * it, which is what lets a deep link stand in — see `linkedDrill`.
   */
  const [drill, setDrill] = useState<{ agentId: string | null; managerKey: string | null } | null>(null)
  const { meetings, loading, error } = useMeetings()
  const { byRole } = useProfiles()
  // Companions load alongside meetings rather than per-row: the panel and the
  // table both need them, and a lookup per meeting would be a request per row.
  const { byMeeting: tagAlongsByMeetingId, byInvitee: tagAlongsByInviteeId } = useTagAlongs()
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })

  /**
   * Deep link from the Maps meeting-history panel: `?meeting=<id>` opens that
   * one record's detail dialog.
   *
   * Derived, never copied into state by an effect — the same rule the Maps page
   * follows for its own links. The param is a default the admin's own actions
   * outrank: `picked`/`dismissedLink` win for the dialog, `drill` for the
   * hierarchy. Written the other way round the dialog would spring back open on
   * every render after being closed.
   *
   * Looked up in `meetings` rather than in `filtered`, so a link resolves
   * whatever the filters happen to say — the admin followed a link to one
   * record, not to a search.
   *
   * The param stays in the URL rather than being stripped after use, so a reload
   * or a forwarded link lands on the same record.
   */
  const searchParams = useSearchParams()
  const linkedMeetingId = searchParams.get('meeting')
  const [dismissedLink, setDismissedLink] = useState(false)
  const linkedMeeting = useMemo(
    () => (linkedMeetingId ? meetings.find(m => m.id === linkedMeetingId) ?? null : null),
    [linkedMeetingId, meetings],
  )
  /**
   * A link is only a miss once the records are actually in — before that the id
   * is simply not looked up yet, and `error` means nothing loaded at all, which
   * the page's own alert already explains.
   */
  const linkMissing = !!linkedMeetingId && !linkedMeeting && !loading && !error
  const selected = picked ?? (dismissedLink ? null : linkedMeeting)
  /**
   * A link lands inside the agent's meetings, not on the manager list: the
   * dialog opens over the table the record belongs to, so closing it leaves the
   * admin somewhere that still has the visit they came for, and its neighbours.
   */
  const linkedDrill = linkedMeeting
    ? { agentId: linkedMeeting.agent_id ?? 'unassigned', managerKey: null }
    : null
  const { agentId: selectedAgentId, managerKey: selectedManagerKey } =
    drill ?? linkedDrill ?? { agentId: null, managerKey: null }

  // The actual managers, so the top of the hierarchy lists real people instead
  // of a generic RSR/Sales bucket — same rule as the Clients page.
  const managers = useMemo(
    () => [...byRole(['sales_manager'])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [byRole],
  )

  /**
   * Which meetings each person was genuinely invited along on, from the
   * tag-along ledger.
   *
   * Accepted and pending both count — the manager was asked either way, and a
   * pending invite is precisely the one worth seeing. Declined and cancelled do
   * not: nobody attended those.
   */
  const tagAlongMeetingIds = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const [inviteeId, requests] of tagAlongsByInviteeId) {
      const ids = new Set(
        requests
          .filter(r => r.related_meeting_id && (r.status === 'accepted' || r.status === 'pending'))
          .map(r => r.related_meeting_id as string)
      )
      if (ids.size > 0) map.set(inviteeId, ids)
    }
    return map
  }, [tagAlongsByInviteeId])

  // Every meeting's manager, computed once regardless of this page's own
  // search/outcome/type/date filters — so scoping the stat row to a manager
  // below doesn't inherit those filters either. Same convention as the
  // Clients page's clientsByManagerKey. A meeting also lands in a manager's
  // own bucket when they recorded it or were tagged along on it — otherwise
  // a manager who tagged along on another team's visit shows a stat row of
  // all zeros for a meeting that very much involved them.
  const meetingsByManagerKey = useMemo(() => {
    const byId = new Map(meetings.map(m => [m.id, m]))
    const idsByKey = new Map<string, Set<string>>()
    const add = (key: string, id: string) => {
      let set = idsByKey.get(key)
      if (!set) { set = new Set(); idsByKey.set(key, set) }
      set.add(id)
    }
    for (const m of meetings) {
      add(managerForTeam(m.agent?.team_id, managers)?.id ?? 'unassigned', m.id)
      if (m.agent_id) add(m.agent_id, m.id)
      if (m.recorded_by) add(m.recorded_by, m.id)
    }
    for (const [inviteeId, ids] of tagAlongMeetingIds) {
      for (const id of ids) add(inviteeId, id)
    }
    const result = new Map<string, Meeting[]>()
    for (const [key, ids] of idsByKey) {
      result.set(key, [...ids].map(id => byId.get(id)).filter((m): m is Meeting => !!m))
    }
    return result
  }, [meetings, managers, tagAlongMeetingIds])


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
      // Two separate figures, because they were one number for a while and that
      // number was wrong. `recorded_by` means the manager filled in the form; it
      // was standing in for "tagged along", which it is not — a manager invited
      // along on twenty agent visits records none of them, and read as zero.
      // Real tag-alongs come from the ledger; this stays what it always was.
      const ownMeetings = filtered.filter(mt => mt.agent_id === m.id || mt.recorded_by === m.id)
      const ownMeetingCount = ownMeetings.length
      const invited = tagAlongMeetingIds.get(m.id)
      const tagAlongCount = invited ? filtered.filter(mt => invited.has(mt.id)).length : 0
      // Team total: meetings reached via an agent under this manager, unioned
      // with the manager's own recorded/tagged-along meetings — a manager with
      // no agents (or whose agents logged nothing) still shows their own
      // meetings here, without double-counting one that's both.
      const teamMeetingIds = new Set(managerGroups.flatMap(g => g.meetings.map(mt => mt.id)))
      const ownMeetingIds = new Set(ownMeetings.map(mt => mt.id))
      const meetingCount = filtered.filter(
        mt => teamMeetingIds.has(mt.id) || ownMeetingIds.has(mt.id) || (invited?.has(mt.id) ?? false)
      ).length
      return {
        key: m.id,
        label: m.full_name,
        agentCount: managerGroups.length,
        meetingCount,
        ownMeetingCount,
        tagAlongCount,
      }
    })
    const unassignedGroups = groups.filter(g => g.managerKey === 'unassigned')
    if (unassignedGroups.length > 0) {
      buckets.push({
        key: 'unassigned',
        label: 'Unassigned',
        agentCount: unassignedGroups.length,
        meetingCount: unassignedGroups.reduce((sum, g) => sum + g.meetings.length, 0),
        ownMeetingCount: 0,
        tagAlongCount: 0,
      })
    }
    return buckets
  }, [managers, groups, filtered, tagAlongMeetingIds])

  const selectedGroup = selectedAgentId ? groups.find(g => g.agentId === selectedAgentId) ?? null : null

  // A manager's own records — meetings they personally attended, whether
  // solo (agent_id is them) or tagging along on an agent's visit
  // (recorded_by is them). This is deliberately *not* the whole team's
  // meetings — just the manager's own footprint, matching the mobile app.
  const selectedManagerBucket = selectedManagerKey
    ? managerBuckets.find(b => b.key === selectedManagerKey) ?? null
    : null
  const managerMeetings = useMemo(
    () => {
      if (!selectedManagerKey) return []
      const invited = tagAlongMeetingIds.get(selectedManagerKey)
      return filtered.filter(
        mt =>
          mt.agent_id === selectedManagerKey ||
          mt.recorded_by === selectedManagerKey ||
          invited?.has(mt.id),
      )
    },
    [selectedManagerKey, filtered, tagAlongMeetingIds],
  )
  const activeMeetings = selectedGroup?.meetings ?? (selectedManagerBucket ? managerMeetings : null)

  // The stat row must match whatever the table below it actually shows —
  // a fully selected agent or manager uses their own footprint
  // (activeMeetings, the exact set the table renders), so the two numbers
  // never disagree. A manager who's only expanded in the list (previewing,
  // not yet drilled in) uses the team-wide total instead; otherwise it's the
  // global total.
  const statsMeetings =
    activeMeetings ?? (expandedManagerKey ? meetingsByManagerKey.get(expandedManagerKey) ?? [] : meetings)

  const counts = {
    total: statsMeetings.length,
    f2f: statsMeetings.filter(m => m.meeting_type === 'f2f').length,
    // Mirrors the table row's own fallback (`m.online_platform === 'zoom' ? 'Zoom' : 'Google Meet'`)
    // rather than checking for the literal 'googlemeet' value, since seeded/live rows often leave
    // online_platform null and the rest of this page already treats "online, not Zoom" as Google Meet.
    googleMeet: statsMeetings.filter(m => m.meeting_type === 'online' && m.online_platform !== 'zoom').length,
    successful: statsMeetings.filter(m => m.outcome === 'successful').length,
    followUp: statsMeetings.filter(m => m.outcome === 'follow_up').length,
    noDecision: statsMeetings.filter(m => m.outcome === 'no_decision').length,
    lost: statsMeetings.filter(m => m.outcome === 'lost_opportunity').length,
  }

  // How many of the selected agent's OWN meetings had someone else tag along
  // with them — the reverse direction from the manager bucket's tagAlongCount
  // (meetings the manager was invited to as a guest). An agent group only
  // ever tracks meetings it owns (agent_id), so "tagged along" for an agent
  // means "had a companion," not "was a companion" — tagAlongMeetingIds
  // (keyed by invitee) answers the wrong question here.
  const selectedAgentTagAlongCount = selectedGroup
    ? selectedGroup.meetings.filter(mt => tagAlongsFor(tagAlongsByMeetingId, mt.id).some(r => r.status !== 'cancelled')).length
    : 0

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

        {/* A followed link that resolves to nothing. Said on the page rather
            than as a toast: the admin arrived here to see one specific record,
            and a notice that disappears leaves them looking at an unexplained
            full list wondering which row was theirs. */}
        {linkMissing && (
          <Alert>
            <AlertDescription className="text-xs">
              That meeting is no longer in the records — it may have been deleted since the map was drawn.
            </AlertDescription>
          </Alert>
        )}

        {!loading && !error && !selectedGroup && !selectedManagerBucket && (
          <>
            {/* Teams — click one to drop down their team's agents right below it */}
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Teams
            </p>
            <div className="space-y-3">
              {managerBuckets.map(({ key, label, agentCount, meetingCount, ownMeetingCount, tagAlongCount }) => {
                const isOpen = expandedManagerKey === key
                const bucketGroups = groups.filter(g => g.managerKey === key)
                return (
                  <div
                    key={key}
                    className={`rounded-lg border bg-card overflow-hidden transition-colors ${isOpen ? 'border-primary/50 shadow-sm' : 'border-border'}`}
                  >
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
                              onClick={() => setDrill({ agentId: null, managerKey: key })}
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
                                  {/* Recorded and tagged along are counted apart
                                      on purpose — they answer different
                                      questions, and one manager can be busy on
                                      one and absent on the other. Either segment
                                      is dropped when it's zero, so a manager
                                      who's only tagged along isn't shown "0
                                      recorded" as if that were news. */}
                                  <p className="text-xs text-muted-foreground">
                                    {ownMeetingCount + tagAlongCount} meeting{ownMeetingCount + tagAlongCount === 1 ? '' : 's'}
                                    {ownMeetingCount > 0 && <> · {ownMeetingCount} recorded</>}
                                    {tagAlongCount > 0 && <> · {tagAlongCount} tagged along</>}
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
                          {bucketGroups.map(group => {
                            // Meetings this agent owns that also had a companion
                            // — not tagAlongMeetingIds (that's meetings they were
                            // invited to as a guest, the reverse direction). See
                            // selectedAgentTagAlongCount above for the same fix.
                            const tagAlong = group.meetings.filter(mt => tagAlongsFor(tagAlongsByMeetingId, mt.id).some(r => r.status !== 'cancelled')).length
                            return (
                            <button
                              key={group.agentId}
                              type="button"
                              onClick={() => setDrill({ agentId: group.agentId, managerKey: null })}
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
                                    {tagAlong > 0 && <> · {tagAlong} tagged along</>}
                                  </p>
                                </div>
                              </div>
                              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                            </button>
                            )
                          })}
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
                onClick={() => setDrill({ agentId: null, managerKey: null })}
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
                    {selectedGroup ? 'Agent' : 'Manager · Recorded and tagged along'}
                  </p>
                  <p className="text-base font-semibold text-foreground truncate">
                    {selectedGroup?.agentName ?? selectedManagerBucket?.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedManagerBucket ? (
                      <>
                        {selectedManagerBucket.ownMeetingCount + selectedManagerBucket.tagAlongCount} meeting{selectedManagerBucket.ownMeetingCount + selectedManagerBucket.tagAlongCount === 1 ? '' : 's'}
                        {selectedManagerBucket.ownMeetingCount > 0 && <> · {selectedManagerBucket.ownMeetingCount} recorded</>}
                        {selectedManagerBucket.tagAlongCount > 0 && <> · {selectedManagerBucket.tagAlongCount} tagged along</>}
                      </>
                    ) : (
                      // No separate "recorded" segment here: every one of an
                      // agent's own meetings is already "recorded" by them, so
                      // that count would just repeat the total. tagAlongCount
                      // is a subset of it (meetings that also had a companion),
                      // not an additional bucket — unlike the manager case above.
                      <>
                        {(activeMeetings ?? []).length} meeting{(activeMeetings ?? []).length === 1 ? '' : 's'}
                        {selectedAgentTagAlongCount > 0 && <> · {selectedAgentTagAlongCount} tagged along</>}
                      </>
                    )}
                  </p>
                </div>
                {/* Same deep link for a manager as an agent — SalesMapView's `agent`
                    param already resolves a manager's own tag-along footprint
                    (see the comment on `scopedTagAlongs` there), not just a literal
                    sales agent's assigned clients. 'unassigned' isn't a real person
                    to scope by, so it gets no button. */}
                {selectedGroup && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => router.push(`/maps?module=sales&agent=${encodeURIComponent(selectedGroup.agentId)}`)}
                  >
                    <MapIcon /> View on map
                  </Button>
                )}
                {!selectedGroup && selectedManagerKey && selectedManagerKey !== 'unassigned' && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => router.push(`/maps?module=sales&agent=${encodeURIComponent(selectedManagerKey)}`)}
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
                      {/* Its own column, not a pill under the client name.
                          A bare "Prospect" sitting beneath a company name in a
                          column headed "Client" reads as that client's status
                          today, which is exactly the confusion this exists to
                          undo — the two disagree on most rows. The header says
                          which one this is; nothing shorter can.

                          Unsorted deliberately. Sorting a table of meetings by
                          the stage each was recorded at groups rows that have
                          nothing else in common; the question this answers is
                          always asked of one client's rows, read down. */}
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground whitespace-nowrap">
                        Stage at visit
                      </th>
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
                        onClick={() => setPicked(m)}
                        className="hover:bg-muted/20 cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground truncate max-w-[160px]">{m.client?.company_name}</p>
                          <p className="text-xs text-muted-foreground">{m.contact_person}</p>
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const stage = meetingStageBadge(m.client_status_at_meeting)
                            return (
                              <span className="inline-flex flex-col items-start gap-0.5" title={stage.title}>
                                <Badge
                                  variant="tone"
                                  className={`text-[10px] px-1.5 h-4 whitespace-nowrap ${TONE_CLASS[stage.tone]}`}
                                >
                                  {stage.label}
                                </Badge>
                                {/* Only where the cap did NOT apply. Saying
                                    "capped" on the rest would put a word on every
                                    row to confirm the default a reader already
                                    assumes, and drown the exceptions. */}
                                {!stage.capped && m.client_status_at_meeting && (
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                    not capped
                                  </span>
                                )}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="px-4 py-3">
                          {/* Every size below is an explicit Tailwind class, not
                              inherited from the table's own text-sm — an
                              inherited-only size gets boosted disproportionately
                              by mobile Safari/Chrome's font-boosting heuristic,
                              which is what made the agent name render far larger
                              than the companion line and badge under it. */}
                          <div className="space-y-1">
                            <p className="text-sm text-foreground font-medium leading-tight">{m.agent?.full_name}</p>
                            {m.recorder && (
                              <p className="text-xs text-muted-foreground leading-tight">+ {m.recorder.full_name}</p>
                            )}
                            {/* Who else was there. Sits under the agent because
                                that is where the reader is already asking "whose
                                meeting is this" — not a column of its own, which
                                would be empty on most rows. */}
                            <CompanionLine requests={tagAlongsFor(tagAlongsByMeetingId, m.id)} />
                            {/* A visible label, not just the small Flags-column
                                icon — readable at a glance straight off the list,
                                in every context (agent-scoped, manager-scoped, or
                                unscoped), not only when the scoped manager
                                specifically isn't the owner. */}
                            {tagAlongsFor(tagAlongsByMeetingId, m.id).some(r => r.status !== 'cancelled') && (
                              <Badge variant="tone" className={`${TONE_CLASS.neutral} text-[10px] px-1.5 h-4`}>
                                Tagged along
                              </Badge>
                            )}
                          </div>
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
                          {/* Two different pins, because "has GPS" stopped being
                              one fact once mobile started capturing a closing
                              fix: a meeting with both can be validated by
                              comparing them, one with only a start cannot. The
                              titles carry the distinction for anyone who doesn't
                              read it off the icon. */}
                          <div className="flex gap-1.5">
                            {m.gps_lat &&
                              (m.end_gps_lat != null ? (
                                <MapPinCheck
                                  className="w-3.5 h-3.5 text-primary"
                                  aria-label="Start and end GPS captured"
                                >
                                  <title>Start and end GPS captured</title>
                                </MapPinCheck>
                              ) : (
                                <MapPin
                                  className="w-3.5 h-3.5 text-muted-foreground"
                                  aria-label="Start GPS only"
                                >
                                  <title>Start GPS only — no closing fix</title>
                                </MapPin>
                              ))}
                            {m.photo_url && <Camera className="w-3.5 h-3.5 text-primary" />}
                            {/* General "someone tagged along" flag — any live
                                companion, teammate or manager. Distinct from
                                ManagerGateIcon below it, which only ever fires
                                for a manager companion and carries their
                                accept/decline status specifically. */}
                            {tagAlongsFor(tagAlongsByMeetingId, m.id).some(r => r.status !== 'cancelled') && (
                              <Users
                                className="w-3.5 h-3.5 text-muted-foreground"
                                aria-label="Someone tagged along"
                              >
                                <title>Someone tagged along on this meeting</title>
                              </Users>
                            )}
                            {/* Only ever shown when a manager gate exists —
                                see ManagerGateIcon. */}
                            <ManagerGateIcon requests={tagAlongsFor(tagAlongsByMeetingId, m.id)} />
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
      {/* Closing clears BOTH sources — the deep link is a default, and a default
          the admin has dismissed must stay dismissed. */}
      <Dialog open={!!selected} onOpenChange={() => { setPicked(null); setDismissedLink(true) }}>
        <DialogContent className="bg-card border-border sm:max-w-3xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden" showCloseButton={false}>
          {selected && (() => {
            const hasStart = selected.gps_lat != null && selected.gps_lng != null
            const hasEnd = selected.end_gps_lat != null && selected.end_gps_lng != null
            const mapStart = hasStart ? { lat: selected.gps_lat as number, lng: selected.gps_lng as number, label: 'Start' } : null
            const mapEnd = hasEnd ? { lat: selected.end_gps_lat as number, lng: selected.end_gps_lng as number, label: 'End' } : null
            const drift = formatDistanceMeters(meetingGpsDriftMeters(selected))
            const duration = formatDurationMinutes(meetingDurationMinutes(selected))
            const submittedBy = selected.recorder?.full_name ?? selected.agent?.full_name ?? 'Unknown'
            const stage = meetingStageBadge(selected.client_status_at_meeting)
            const nowType = selected.client?.customer_type
            const stageMoved = nowType && selected.client_status_at_meeting !== nowType
            const companions = tagAlongsFor(tagAlongsByMeetingId, selected.id)
            const gate = managerGate(companions)
            return (
            <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-3 flex-row items-center justify-between space-y-0">
              <div className="min-w-0">
                <DialogTitle className="text-base truncate">{selected.client?.company_name}</DialogTitle>
                <p className="text-xs text-muted-foreground truncate">
                  {selected.contact_person}{selected.contact_position ? ` · ${selected.contact_position}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* A clear text badge, not just a Flags-column icon — readable
                    at a glance the same way the outcome badge next to it is. */}
                {companions.some(r => r.status !== 'cancelled') && (
                  <Badge variant="tone" className={TONE_CLASS.amber}>
                    Tagged Along
                  </Badge>
                )}
                <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[selected.outcome]]}>
                  {OUTCOME_LABEL[selected.outcome]}
                </Badge>
                <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
                  <XIcon className="w-4 h-4" />
                  <span className="sr-only">Close</span>
                </DialogClose>
              </div>
            </DialogHeader>

            <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5 text-sm">
              <div className="h-64 bg-muted/40 rounded-lg border border-border overflow-hidden">
                {mapStart || mapEnd ? (
                  <MeetingRouteMap start={mapStart} end={mapEnd} distanceLabel={drift} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                    No location captured for this meeting
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-0 sm:[&>*:nth-child(odd)]:pr-6 sm:[&>*:nth-child(even)]:pl-6 sm:[&>*:nth-child(even)]:border-l sm:[&>*:nth-child(even)]:border-border">
                <DetailLine icon={User} label="Submitted by" value={submittedBy} />
                <DetailLine
                  icon={Clock}
                  label="Time"
                  value={format(new Date(selected.meeting_date), 'h:mm a')}
                />
                <DetailLine icon={Navigation} label="Duration" value={duration ?? 'Not captured'} />
                <DetailLine icon={MapPin} label="Distance start → end" value={drift ?? 'Not captured'} />
                <DetailLine
                  icon={Building2}
                  label="Meeting type"
                  value={
                    selected.meeting_type === 'f2f'
                      ? 'Face to face'
                      : `Online${selected.online_platform ? ` · ${selected.online_platform === 'zoom' ? 'Zoom' : 'Google Meet'}` : ''}`
                  }
                />
                <DetailLine
                  icon={MapPin}
                  label="Location"
                  value={selected.location_type === 'client_office' ? "Client's office" : (selected.location_name || 'Other location')}
                />
                <DetailLine icon={User} label="Contact person" value={selected.contact_person || 'Not recorded'} />
                <DetailLine icon={Phone} label="Contact position" value={selected.contact_position || 'Not recorded'} />
              </div>

              <div className="space-y-4">
                <div className="flex items-start gap-2 text-xs">
                  <ListChecks className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-muted-foreground mb-1.5">Agenda</p>
                    {selected.agenda.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {selected.agenda.map(a => (
                          <Badge key={a} variant="tone" className={TONE_CLASS.neutral}>{a}</Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-foreground">Not recorded</p>
                    )}
                  </div>
                </div>

                {selected.remarks && (
                  <div className="flex items-start gap-2 text-xs">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground mb-1">Remarks</p>
                      <p className="text-foreground break-words">{selected.remarks}</p>
                    </div>
                  </div>
                )}

                {/* Stage at the visit — the one row on this dialog that is
                    allowed to disagree with the client's live status, since
                    the schema never records when a promotion happened. Always
                    shown, unlike Tagged along below: its absence would be
                    indistinguishable from a client that never moved stage. */}
                <div className="flex items-start gap-2 text-xs bg-muted/40 rounded-lg border border-border p-3">
                  <Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-muted-foreground">Client stage at this visit</p>
                      <Badge variant="tone" className={`text-[10px] px-1.5 h-4 shrink-0 ${TONE_CLASS[stage.tone]}`}>{stage.label}</Badge>
                    </div>
                    <p className="text-foreground">{stage.title}</p>
                    {stageMoved && (
                      <p className="text-muted-foreground mt-1">
                        The account is <span className="text-foreground font-medium">{CUSTOMER_TYPE_LABEL[nowType]}</span> today.
                        A stage change does not restate a past visit — this one keeps whatever the cutoff decided at the time.
                      </p>
                    )}
                  </div>
                </div>

                {companions.length > 0 && (
                  <div className="flex items-start gap-2 text-xs bg-muted/40 rounded-lg border border-border p-3">
                    <Camera className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-muted-foreground">Tagged along</p>
                        {gate !== 'none' && (
                          <Badge variant="tone" className={`text-[10px] px-1.5 h-4 shrink-0 ${TONE_CLASS[MANAGER_GATE_TONE[gate]]}`}>
                            {MANAGER_GATE_LABEL[gate]}
                          </Badge>
                        )}
                      </div>
                      <CompanionList requests={companions} />
                      {gate === 'pending' && (
                        <p className="text-muted-foreground mt-2">
                          Until the manager answers, this meeting reserves no slot against the client&apos;s cutoff limit and counts toward no one&apos;s target.
                        </p>
                      )}
                      {gate === 'declined' && (
                        <p className="text-muted-foreground mt-2">
                          A declined tag-along excludes this meeting from the cutoff permanently. The record stays; it will never count.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2.5 pt-3 border-t border-border">
                {/* Names which fixes are on file rather than a flat "GPS
                    captured" — a meeting with only a start fix can't be
                    validated the way ADR-019 assumes, and the chip is where
                    that shows before the admin goes looking for the pair. */}
                {selected.gps_lat && (
                  <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted/40 rounded-full px-3 py-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                    {selected.end_gps_lat != null ? 'Start & end GPS' : 'Start GPS only'}
                  </div>
                )}
                {selected.photo_url && (
                  <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted/40 rounded-full px-3 py-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" /> Photo taken
                  </div>
                )}
              </div>
            </div>
            </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * The Suspense boundary `useSearchParams` requires — see MeetingsPageContent.
 * The fallback mirrors that component's own loading state so following a deep
 * link doesn't flash a different shape on the way in.
 */
export default function MeetingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col flex-1">
          <Header title="Meetings" />
          <div className="flex-1 p-6 text-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
            <p className="text-sm">Loading meetings…</p>
          </div>
        </div>
      }
    >
      <MeetingsPageContent />
    </Suspense>
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
