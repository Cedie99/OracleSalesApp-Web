'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useClients } from '@/lib/hooks/use-clients'
import { useMeetings, meetingDurationMinutes } from '@/lib/hooks/use-meetings'
import { useTeams } from '@/lib/hooks/use-teams'
import {
  getMapStatus,
  isAvailableForReassignment,
  isPlottableMeeting,
  parseLatLng,
  OUTCOME_META,
  STATUS_META,
  TILE_LAYERS,
  type MapStatus,
  type MapTileType,
} from '@/components/maps/map-constants'
import type { MapPin, FocusTarget, HighlightMarker } from '@/components/maps/field-map'
import type { Client, Meeting, MeetingOutcome } from '@/types'
import {
  Search, Building2, Phone, User, History, ShieldCheck, MapPin as MapPinIcon, Layers,
  LockOpen, ChevronDown, Check, Info, PanelLeftClose,
  PanelLeftOpen, X, Crosshair, Video, Navigation,
} from 'lucide-react'
import { format } from 'date-fns'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { DateRangeFilter } from '@/components/ui/date-range-filter'

const FieldMap = dynamic(() => import('@/components/maps/field-map'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 h-full flex items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
})

const OUTCOME_LABEL: Record<string, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost',
}

const STATUS_KEYS = Object.keys(STATUS_META) as MapStatus[]
const OUTCOME_KEYS = Object.keys(OUTCOME_META) as MeetingOutcome[]
const TILE_KEYS = Object.keys(TILE_LAYERS) as MapTileType[]

type TypeFilter = 'all' | 'f2f' | 'online'

/** How a meeting's location reads in the list / detail. */
function meetingWhere(m: Meeting): string {
  if (m.meeting_type === 'online') {
    return m.online_platform === 'zoom'
      ? 'Zoom'
      : m.online_platform === 'googlemeet'
        ? 'Google Meet'
        : 'Online'
  }
  return m.location_type === 'client_office' ? 'Client office' : m.location_name || 'Other location'
}

interface SalesMapViewProps {
  /** The module switcher, when this admin has more than one lens. */
  headerAction?: React.ReactNode
}

/**
 * The Sales lens on the Maps page — a client plotted at their most recent
 * located visit.
 *
 * Deliberately NOT trip-shaped, unlike Collection and Delivery. A sales agent's
 * day is a set of appointments, not a published run worked in order, so joining
 * one agent's meetings into a line would assert a route nobody drove. The
 * question here is "when was this account last seen, and by whom" — which is why
 * the list partitions into visited / not-visited rather than into routes.
 */
export function SalesMapView({ headerAction }: SalesMapViewProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | MapStatus>('all')
  const [agentFilter, setAgentFilter] = useState<'all' | 'unassigned' | string>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const dateFilter = useDateRangeFilter({ defaultPreset: 'day' })
  const [teamFilter, setTeamFilter] = useState<'all' | string>('all')
  const [colorBy, setColorBy] = useState<'status' | 'outcome'>('status')
  const [listMode, setListMode] = useState<'visited' | 'unvisited'>('visited')

  const [mapType, setMapType] = useState<MapTileType>('satellite')
  const [mapTypeMenuOpen, setMapTypeMenuOpen] = useState(false)
  const mapTypeMenuRef = useRef<HTMLDivElement>(null)

  const [listOpen, setListOpen] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focus, setFocus] = useState<FocusTarget | null>(null)
  const [highlight, setHighlight] = useState<HighlightMarker | null>(null)
  const focusNonce = useRef(0)

  const { clients } = useClients()
  const { meetings } = useMeetings()
  const { teams } = useTeams()

  useEffect(() => {
    if (!mapTypeMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (mapTypeMenuRef.current && !mapTypeMenuRef.current.contains(e.target as Node)) {
        setMapTypeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [mapTypeMenuOpen])

  const { range, label: rangeLabel } = dateFilter

  // --- Close the detail panel whenever the filters rebuild the list ----------
  // Changing a filter replaces the set of clients on screen, so a panel left
  // open is describing a row that may not even be in the new list. Reset during
  // render (React's "adjusting state when a prop changes" pattern) rather than
  // in an effect, so the panel never paints for a frame against the new list.
  //
  // `search` is deliberately NOT in this key: onSearchChange also *sets* a
  // highlight marker for coordinate entry, and a render-time reset would wipe
  // that marker the moment it was placed. It clears the selection itself.
  //
  // colorBy / mapType are excluded too — they restyle the same pins rather than
  // changing which clients are listed, so there's nothing stale to close.
  const filterKey = [
    statusFilter, teamFilter, agentFilter, typeFilter, dateFilter.key, listMode,
  ].join('|')
  const [lastFilterKey, setLastFilterKey] = useState(filterKey)
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey)
    setSelectedId(null)
    setHighlight(null)
  }

  // --- Meetings grouped per client, newest first ------------------------------
  const meetingsByClient = useMemo(() => {
    const map = new Map<string, Meeting[]>()
    for (const m of meetings) {
      const list = map.get(m.client_id)
      if (list) list.push(m)
      else map.set(m.client_id, [m])
    }
    // The hook already orders meeting_date desc, so groups inherit that order.
    return map
  }, [meetings])

  // Agent options cascade from the team filter: pick a team and the list narrows
  // to that team's agents. A team has no "unassigned" bucket (those clients have
  // no agent and therefore no team).
  const agentOptions = useMemo(() => {
    const byId = new Map<string, string>()
    let hasUnassigned = false
    clients.forEach(c => {
      if (teamFilter !== 'all' && c.agent?.team_id !== teamFilter) return
      if (c.agent) byId.set(c.agent.id, c.agent.full_name)
      else hasUnassigned = true
    })
    return {
      hasUnassigned,
      agents: Array.from(byId, ([id, full_name]) => ({ id, full_name })).sort((a, b) =>
        a.full_name.localeCompare(b.full_name)
      ),
    }
  }, [clients, teamFilter])

  const coord = useMemo(() => parseLatLng(search), [search])

  // A raw lat/lng in the search box is a "go here" command, not a list filter —
  // fly there and drop a search marker, mirroring Google Maps. Handled on change
  // rather than in an effect so it doesn't cascade renders.
  function onSearchChange(value: string) {
    setSearch(value)
    // Same reasoning as the filterKey reset above — searching rebuilds the list,
    // so the open panel goes with it. Done here rather than via filterKey so the
    // coordinate branch below can re-set the highlight in the same batch; both
    // writes land in one render and the marker survives.
    setSelectedId(null)
    setHighlight(null)
    const c = parseLatLng(value)
    if (c) {
      focusNonce.current += 1
      setHighlight({ lat: c.lat, lng: c.lng, kind: 'search', label: `${c.lat}, ${c.lng}` })
      setFocus({ lat: c.lat, lng: c.lng, zoom: 16, nonce: focusNonce.current })
    }
  }

  // --- Partition the filtered clients into visited / not-visited for the range -
  const { visited, unvisited } = useMemo(() => {
    const q = coord ? '' : search.toLowerCase().trim()
    const vis: {
      client: Client
      inRange: Meeting[]
      plotMeeting: Meeting | null
      lastVisit: string
    }[] = []
    const unvis: { client: Client; lastEver: string | null }[] = []

    for (const client of clients) {
      // Client-level filters apply to both buckets.
      if (teamFilter !== 'all' && client.agent?.team_id !== teamFilter) continue
      if (statusFilter !== 'all' && getMapStatus(client) !== statusFilter) continue
      if (agentFilter === 'unassigned' && client.agent) continue
      if (agentFilter !== 'all' && agentFilter !== 'unassigned' && client.agent?.id !== agentFilter) continue
      if (
        q &&
        !client.company_name.toLowerCase().includes(q) &&
        !client.office_address.toLowerCase().includes(q)
      ) {
        continue
      }

      const all = meetingsByClient.get(client.id) ?? []
      const inRange = all.filter(m => {
        if (typeFilter !== 'all' && m.meeting_type !== typeFilter) return false
        if (!range) return true
        const t = new Date(m.meeting_date).getTime()
        return t >= range.start.getTime() && t <= range.end.getTime()
      })

      if (inRange.length === 0) {
        // Neglected in this window — carry the most recent visit ever for context.
        unvis.push({ client, lastEver: all[0]?.meeting_date ?? null })
        continue
      }

      // Pin sits at the most recent plottable f2f visit in range.
      const plotMeeting = inRange.find(isPlottableMeeting) ?? null
      vis.push({ client, inRange, plotMeeting, lastVisit: inRange[0].meeting_date })
    }

    vis.sort((a, b) => new Date(b.lastVisit).getTime() - new Date(a.lastVisit).getTime())
    unvis.sort((a, b) => a.client.company_name.localeCompare(b.client.company_name))
    return { visited: vis, unvisited: unvis }
  }, [clients, meetingsByClient, teamFilter, statusFilter, agentFilter, typeFilter, range, search, coord])

  const pins = useMemo<MapPin[]>(
    () =>
      // Not-visited accounts have no in-range location, so the map clears.
      listMode === 'unvisited'
        ? []
        : visited
            .filter(v => v.plotMeeting)
            .map(v => ({
              id: v.client.id,
              lat: v.plotMeeting!.gps_lat!,
              lng: v.plotMeeting!.gps_lng!,
              color:
                colorBy === 'outcome'
                  ? OUTCOME_META[v.plotMeeting!.outcome].color
                  : STATUS_META[getMapStatus(v.client)].color,
              active: v.client.id === selectedId,
              label: v.client.company_name,
              sublabel: `${meetingWhere(v.plotMeeting!)} · ${format(new Date(v.plotMeeting!.meeting_date), 'MMM d')}`,
              avatarUrl: v.client.agent?.avatar_url,
            })),
    [visited, selectedId, colorBy, listMode]
  )

  const statusCounts = useMemo(() => {
    const acc = { existing: 0, new: 0, prospect: 0, lost: 0 } as Record<MapStatus, number>
    for (const v of visited) acc[getMapStatus(v.client)] += 1
    return acc
  }, [visited])

  const outcomeCounts = useMemo(() => {
    const acc = { successful: 0, follow_up: 0, no_decision: 0, lost_opportunity: 0 } as Record<MeetingOutcome, number>
    for (const v of visited) if (v.plotMeeting) acc[v.plotMeeting.outcome] += 1
    return acc
  }, [visited])

  // Derived from `visited`, NOT from `pins` — the header describes the visited
  // set, which doesn't change when you flip to the not-visited lens, whereas
  // `pins` is deliberately emptied there. Reading pins.length made the subtitle
  // claim "0 mapped · N no location" about clients that are in fact all mapped.
  const mappedCount = visited.filter(v => v.plotMeeting).length
  // Visited clients we still can't plot. Since online meetings now carry the
  // agent's GPS like f2f does, this is no longer "the online ones" — it's rows
  // with no coordinates at all, i.e. meetings that predate GPS capture.
  const unlocatedCount = visited.length - mappedCount

  const selected = clients.find(c => c.id === selectedId) ?? null
  // Keyed on selectedId (a string), not the client object — depending on the
  // object trips the React Compiler's mutation analysis (see git history).
  const selectedHistory = useMemo(
    () => (selectedId ? meetingsByClient.get(selectedId) ?? [] : []),
    [selectedId, meetingsByClient]
  )

  function selectClient(id: string) {
    setSelectedId(id)
    const row = visited.find(v => v.client.id === id)
    if (row?.plotMeeting) {
      focusNonce.current += 1
      setHighlight(null)
      setFocus({
        lat: row.plotMeeting.gps_lat!,
        lng: row.plotMeeting.gps_lng!,
        zoom: 15,
        nonce: focusNonce.current,
      })
    }
  }

  // Clicking a meeting in the history pins it and flies there. The marker mirrors
  // the status pins — status colour + the agent's face — rather than a bare dot.
  function locateMeeting(m: Meeting) {
    if (!isPlottableMeeting(m)) return
    const client = clients.find(c => c.id === m.client_id)
    focusNonce.current += 1
    setHighlight({
      lat: m.gps_lat!,
      lng: m.gps_lng!,
      kind: 'meeting',
      label: `${format(new Date(m.meeting_date), 'MMM d, yyyy')} · ${meetingWhere(m)}`,
      color: client ? STATUS_META[getMapStatus(client)].color : undefined,
      avatarUrl: m.agent?.avatar_url ?? client?.agent?.avatar_url ?? null,
    })
    setFocus({ lat: m.gps_lat!, lng: m.gps_lng!, zoom: 16, nonce: focusNonce.current })
  }

  return (
    <>
      <Header
        title="Meetings Map"
        subtitle={`${rangeLabel} · ${visited.length} ${visited.length === 1 ? 'client' : 'clients'} visited · ${mappedCount} mapped · ${unlocatedCount} no location`}
        action={headerAction}
      />

      {/* ---- Filter toolbar --------------------------------------------------- */}
      <div className="shrink-0 border-b border-border bg-card/50 px-4 py-2.5 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          {coord ? (
            <Crosshair className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary" />
          ) : (
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          )}
          <Input
            placeholder="Search client, address, or paste lat, lng…"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="pl-9 h-9 bg-card border-border"
          />
          {coord && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-primary bg-primary/10 rounded px-1.5 py-0.5">
              Coordinates
            </span>
          )}
        </div>

        <Select value={statusFilter} onValueChange={v => setStatusFilter((v as MapStatus | null) ?? 'all')}>
          <SelectTrigger className="w-[8.5rem] h-9 bg-card border-border">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_KEYS.map(key => (
              <SelectItem key={key} value={key}>{STATUS_META[key].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={teamFilter}
          onValueChange={v => {
            const t = v ?? 'all'
            setTeamFilter(t)
            // Drop an agent selection that isn't in the newly chosen team.
            if (t !== 'all' && agentFilter !== 'all' && agentFilter !== 'unassigned') {
              const stillValid = clients.some(c => c.agent?.id === agentFilter && c.agent?.team_id === t)
              if (!stillValid) setAgentFilter('all')
            }
          }}
        >
          <SelectTrigger className="w-[8.5rem] h-9 bg-card border-border">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teams.map(team => (
              <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={agentFilter} onValueChange={v => setAgentFilter(v ?? 'all')}>
          <SelectTrigger className="w-[8.5rem] h-9 bg-card border-border">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agentOptions.agents.map(agent => (
              <SelectItem key={agent.id} value={agent.id}>{agent.full_name}</SelectItem>
            ))}
            {agentOptions.hasUnassigned && <SelectItem value="unassigned">Unassigned</SelectItem>}
          </SelectContent>
        </Select>

        {/* Date window: per-day stepper by default, with wider presets. */}
        <DateRangeFilter filter={dateFilter} />

        {/* Meeting-type tabs — strong active indicator. */}
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
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ---- Left: collapsible visited-client list -------------------------- */}
        {listOpen ? (
          <div className="w-80 shrink-0 border-r border-border flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <Tabs value={listMode} onValueChange={v => setListMode(v as 'visited' | 'unvisited')} className="flex-1">
                <TabsList className="h-8 w-full">
                  <TabsTrigger value="visited" className="px-2 text-xs">
                    Visited <span className="ml-1 opacity-60">{visited.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="unvisited" className="px-2 text-xs">
                    Not visited <span className="ml-1 opacity-60">{unvisited.length}</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                aria-label="Collapse list"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
              {listMode === 'visited' ? (
                <>
                  {visited.map(({ client, inRange, plotMeeting, lastVisit }) => {
                    const status = getMapStatus(client)
                    const active = client.id === selectedId
                    return (
                      <button
                        key={client.id}
                        onClick={() => selectClient(client.id)}
                        className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: STATUS_META[status].color }}
                          />
                          <p className="text-sm font-medium text-foreground truncate flex-1">{client.company_name}</p>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {format(new Date(lastVisit), 'MMM d')}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate pl-4">
                          {client.office_address || [client.city, client.province].filter(Boolean).join(', ') || 'No address on file'}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1 pl-4">
                          {client.agent && (
                            <Avatar className="size-4 after:border-0">
                              {client.agent.avatar_url && <AvatarImage src={client.agent.avatar_url} alt="" />}
                              <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                                {client.agent.full_name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <p className="text-[11px] text-muted-foreground truncate">
                            {client.agent?.full_name ?? 'Unassigned'}
                          </p>
                          <span className="ml-auto flex items-center gap-1 shrink-0">
                            <Badge variant="outline" className="text-[9px] px-1 h-3.5">
                              {inRange.length} {inRange.length === 1 ? 'visit' : 'visits'}
                            </Badge>
                            {!plotMeeting && (
                              <Badge variant="outline" className="text-[9px] px-1 h-3.5 text-muted-foreground">
                                No pin
                              </Badge>
                            )}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                  {visited.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground text-sm px-6 space-y-3">
                      <p>No visits recorded for {rangeLabel.toLowerCase()}.</p>
                      {dateFilter.preset !== 'all' && (
                        <button
                          type="button"
                          onClick={() => dateFilter.setPreset('all')}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          Show all time
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {unvisited.map(({ client, lastEver }) => {
                    const status = getMapStatus(client)
                    const active = client.id === selectedId
                    return (
                      <button
                        key={client.id}
                        onClick={() => selectClient(client.id)}
                        className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: STATUS_META[status].color }}
                          />
                          <p className="text-sm font-medium text-foreground truncate flex-1">{client.company_name}</p>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {lastEver ? `Last ${format(new Date(lastEver), 'MMM d')}` : 'Never'}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate pl-4">
                          {client.office_address || [client.city, client.province].filter(Boolean).join(', ') || 'No address on file'}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1 pl-4">
                          {client.agent && (
                            <Avatar className="size-4 after:border-0">
                              {client.agent.avatar_url && <AvatarImage src={client.agent.avatar_url} alt="" />}
                              <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                                {client.agent.full_name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <p className="text-[11px] text-muted-foreground truncate">
                            {client.agent?.full_name ?? 'Unassigned'}
                          </p>
                          <Badge variant="outline" className="ml-auto text-[9px] px-1 h-3.5 text-muted-foreground shrink-0">
                            {lastEver ? 'No recent visit' : 'Never visited'}
                          </Badge>
                        </div>
                      </button>
                    )
                  })}
                  {unvisited.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground text-sm px-6">
                      No neglected accounts for {rangeLabel.toLowerCase()} — everyone in view was visited.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setListOpen(true)}
            className="w-10 shrink-0 border-r border-border flex flex-col items-center gap-2 pt-3 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            aria-label="Expand list"
          >
            <PanelLeftOpen className="w-4 h-4" />
            <span className="text-[10px] font-semibold [writing-mode:vertical-rl]">
              {listMode === 'visited' ? `${visited.length} visited` : `${unvisited.length} not visited`}
            </span>
          </button>
        )}

        {/* ---- Map ------------------------------------------------------------ */}
        <div className="flex-1 relative min-h-0">
          <FieldMap
            pins={pins}
            onSelect={selectClient}
            mapType={mapType}
            focus={focus}
            highlight={highlight}
          />

          {/* Explains a bare map so it doesn't read as a bug. Keyed on `pins`,
              the thing actually being rendered — mappedCount describes the
              visited set and stays non-zero on the deliberately-empty
              not-visited lens. */}
          {pins.length === 0 && (
            <Card className="absolute top-4 left-1/2 -translate-x-1/2 bg-card/95 border-border backdrop-blur-sm z-10 py-0 gap-0 max-w-md">
              <CardContent className="p-3 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground leading-relaxed">
                  {listMode === 'unvisited' ? (
                    <>
                      <p className="font-medium text-foreground mb-0.5">Not-visited accounts</p>
                      These clients have no visit recorded for {rangeLabel.toLowerCase()}, so there&apos;s nothing to plot — they&apos;re listed on the left.
                    </>
                  ) : visited.length === 0 ? (
                    <>
                      <p className="font-medium text-foreground mb-0.5">Nothing to plot for {rangeLabel.toLowerCase()}</p>
                      No meetings fall in this window. Widen the date range or clear the filters to see field visits.
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-foreground mb-0.5">Visits recorded, but no location captured</p>
                      These meetings predate GPS capture, so they can&apos;t be pinned. They&apos;re listed on the left.
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Legend — top-left, clear of the detail overlay on the right. Hidden
              in the not-visited lens, which has no pins to describe. */}
          {listMode === 'visited' && (
            <Card className="absolute top-4 left-4 w-48 bg-card/95 border-border backdrop-blur-sm z-10 pt-0 gap-0">
              <CardContent className="p-3 space-y-1.5">
                {/* Colour-by toggle: what kind of client vs. how the visit went. */}
                <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-muted mb-2">
                  {(['status', 'outcome'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setColorBy(mode)}
                      className={`flex-1 text-[10px] font-medium rounded-md px-2 py-1 transition-colors ${
                        colorBy === mode
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {mode === 'status' ? 'Status' : 'Outcome'}
                    </button>
                  ))}
                </div>
                {colorBy === 'status'
                  ? STATUS_KEYS.map(key => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_META[key].color }} />
                        <span className="text-xs text-muted-foreground">{STATUS_META[key].label}</span>
                        <span className="text-xs text-foreground ml-auto font-medium pl-4">{statusCounts[key]}</span>
                      </div>
                    ))
                  : OUTCOME_KEYS.map(key => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: OUTCOME_META[key].color }} />
                        <span className="text-xs text-muted-foreground">{OUTCOME_META[key].label}</span>
                        <span className="text-xs text-foreground ml-auto font-medium pl-4">{outcomeCounts[key]}</span>
                      </div>
                    ))}
              </CardContent>
            </Card>
          )}

          {/* Map type switcher */}
          <div ref={mapTypeMenuRef} className="absolute bottom-4 left-4 z-10">
            <button
              type="button"
              onClick={() => setMapTypeMenuOpen(o => !o)}
              aria-expanded={mapTypeMenuOpen}
              className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-full bg-card/95 border border-border backdrop-blur-sm shadow-sm text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              <Layers className="w-3.5 h-3.5 text-muted-foreground" />
              {TILE_LAYERS[mapType].label}
              <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${mapTypeMenuOpen ? '' : 'rotate-180'}`} />
            </button>

            {mapTypeMenuOpen && (
              <Card className="absolute bottom-full left-0 mb-2 w-[15.5rem] bg-card/95 border-border backdrop-blur-sm py-0 gap-0">
                <CardContent className="p-2">
                  <div className="flex items-center gap-1.5 px-1 pt-0.5 pb-1.5">
                    <Layers className="w-3 h-3 text-muted-foreground" />
                    <span className="text-[11px] font-semibold text-foreground">Map Type</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {TILE_KEYS.map(key => {
                      const active = mapType === key
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setMapType(key)
                            setMapTypeMenuOpen(false)
                          }}
                          className="flex flex-col items-stretch gap-1 p-1 rounded-lg hover:bg-muted/50 transition-colors"
                        >
                          <div
                            className={`relative w-full aspect-square rounded-md overflow-hidden ring-2 ${
                              active ? 'ring-primary' : 'ring-transparent'
                            }`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={TILE_LAYERS[key].preview} alt="" className="w-full h-full object-cover" />
                            {active && (
                              <div className="absolute top-1 right-1 bg-primary rounded-full p-0.5">
                                <Check className="w-2 h-2 text-primary-foreground" />
                              </div>
                            )}
                          </div>
                          <span className={`text-[11px] text-center ${active ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                            {TILE_LAYERS[key].label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ---- Detail overlay ---------------------------------------------- */}
          {selected && (
            <div className="absolute top-4 right-4 bottom-4 w-80 z-10 flex flex-col rounded-xl border border-border bg-card/95 backdrop-blur-sm shadow-lg overflow-hidden">
              <div className="flex items-start justify-between gap-2 p-4 border-b border-border">
                <div className="min-w-0">
                  <Badge
                    variant="outline"
                    style={{
                      borderColor: `${STATUS_META[getMapStatus(selected)].color}55`,
                      color: STATUS_META[getMapStatus(selected)].color,
                    }}
                    className="text-[10px] px-1.5 h-5 mb-1.5"
                  >
                    {STATUS_META[getMapStatus(selected)].label}
                  </Badge>
                  <h2 className="text-base font-semibold text-foreground leading-tight truncate">{selected.company_name}</h2>
                  <div className="flex items-start gap-1.5 mt-1">
                    <MapPinIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground">
                      {selected.office_address || [selected.city, selected.province].filter(Boolean).join(', ') || 'No address on file'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {selected.agent && (
                  <div className="flex items-center gap-2.5 p-2 rounded-lg bg-muted/30 border border-border">
                    <Avatar size="default">
                      {selected.agent.avatar_url && <AvatarImage src={selected.agent.avatar_url} alt={selected.agent.full_name} />}
                      <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
                        {selected.agent.full_name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{selected.agent.full_name}</p>
                      <p className="text-[10px] text-muted-foreground">Assigned Agent</p>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <User className="w-3.5 h-3.5 shrink-0" />
                    {selected.contact_person || '—'}
                    {selected.contact_position ? ` · ${selected.contact_position}` : ''}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Phone className="w-3.5 h-3.5 shrink-0" />
                    {selected.contact_number || '—'}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Building2 className="w-3.5 h-3.5 shrink-0" />
                    {selected.sales_channel.replace('_', ' ')}
                  </div>
                </div>

                <div className="pt-3 border-t border-border">
                  <div className="flex items-center gap-2 mb-2">
                    {isAvailableForReassignment(selected) ? (
                      <LockOpen className="w-3.5 h-3.5 text-primary" />
                    ) : (
                      <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                    )}
                    <p className="text-xs font-medium text-foreground">Account Reservation</p>
                  </div>
                  {isAvailableForReassignment(selected) ? (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Lost Opportunity, past its 14-day cooldown{selected.reassignable_at ? ` (since ${format(new Date(selected.reassignable_at), 'MMM d, yyyy')})` : ''}.
                      Last handled by <span className="text-foreground font-medium">{selected.agent?.full_name ?? 'Unassigned'}</span>, now{' '}
                      <span className="text-primary font-medium">available for reassignment</span>.
                    </p>
                  ) : selected.status === 'lost' ? (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Lost Opportunity — still reserved to <span className="text-foreground font-medium">{selected.agent?.full_name ?? 'Unassigned'}</span> during
                      its 14-day cooldown{selected.reassignable_at ? `, reassignable from ${format(new Date(selected.reassignable_at), 'MMM d, yyyy')}` : ''}.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Reserved to <span className="text-foreground font-medium">{selected.agent?.full_name ?? 'Unassigned'}</span> so other agents know not to approach it.
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-border">
                  <div className="flex items-center gap-2 mb-2.5">
                    <History className="w-3.5 h-3.5 text-primary" />
                    <p className="text-xs font-medium text-foreground">Meeting History</p>
                    <span className="text-[10px] text-muted-foreground ml-auto">Tap a visit to locate</span>
                  </div>
                  <div className="space-y-1.5">
                    {selectedHistory.length === 0 && (
                      <p className="text-xs text-muted-foreground">No meetings logged yet.</p>
                    )}
                    {selectedHistory.map(m => {
                      const plottable = isPlottableMeeting(m)
                      const duration = meetingDurationMinutes(m)
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => locateMeeting(m)}
                          disabled={!plottable}
                          className={`w-full text-left rounded-lg border border-border p-2.5 transition-colors ${
                            plottable ? 'hover:bg-primary/5 hover:border-primary/40 cursor-pointer' : 'opacity-70 cursor-default'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-foreground">
                              {format(new Date(m.meeting_date), 'MMM d, yyyy')}
                            </span>
                            <Badge variant="outline" className="text-[10px] px-1.5 h-4">
                              {OUTCOME_LABEL[m.outcome] ?? m.outcome}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
                            {m.meeting_type === 'online' ? (
                              <Video className="w-3 h-3 shrink-0" />
                            ) : (
                              <Navigation className="w-3 h-3 shrink-0" />
                            )}
                            <span className="truncate">{meetingWhere(m)}</span>
                            {duration != null && <span className="shrink-0">· {duration}m</span>}
                            {plottable ? (
                              <MapPinIcon className="w-3 h-3 ml-auto shrink-0 text-primary" />
                            ) : (
                              <span className="ml-auto shrink-0 text-[10px]">no location</span>
                            )}
                          </div>
                          {(m.agent?.full_name || m.contact_person) && (
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              {[m.agent?.full_name, m.contact_person].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
