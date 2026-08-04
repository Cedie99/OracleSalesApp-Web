'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PersonSelect } from '@/components/ui/person-select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useClients } from '@/lib/hooks/use-clients'
import { useMeetings, meetingDurationMinutes } from '@/lib/hooks/use-meetings'
import { useTeams } from '@/lib/hooks/use-teams'
import {
  getMapStatus,
  isAvailableForReassignment,
  isInProgress,
  isPlottableMeeting,
  mapStatusMeta,
  parseLatLng,
  ATTENTION_META,
  OUTCOME_META,
  STATUS_META,
  TILE_LAYERS,
  type MapStatus,
  type MapTileType,
} from '@/components/maps/map-constants'
import {
  clientQuotaUsage,
  emptyUsage,
  periodDateLabel,
  reviewablePeriods,
  type ClientQuotaUsage,
} from '@/lib/cutoff'
import {
  clientAttention,
  compareAttention,
  MAX_LIFESPAN_MONTHS,
  type AttentionFlag,
  type AttentionKind,
} from '@/lib/attention'
import { useCutoffAttributions, useCutoffPeriods } from '@/lib/hooks/use-cutoff'
import { formatCoords, useReverseGeocode } from '@/lib/hooks/use-reverse-geocode'
import { formatDurationMinutes } from '@/lib/utils'
import type { MapPin, FocusTarget, HighlightMarker } from '@/components/maps/field-map'
import type { Client, Meeting, MeetingOutcome } from '@/types'
import {
  Search, Building2, Phone, User, History, ShieldCheck, MapPin as MapPinIcon, Layers,
  LockOpen, ChevronDown, ChevronLeft, ChevronRight, CalendarDays, Check, Info, PanelLeftClose,
  PanelLeftOpen, X, Crosshair, Video, Navigation, Clock, Tag,
  type LucideIcon,
} from 'lucide-react'
import { CHANNEL_LABEL } from '@/lib/status-styles'
import { clientAddress, clientInfoGaps } from '@/lib/client-info'
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
const ATTENTION_KEYS = Object.keys(ATTENTION_META) as AttentionKind[]
const TILE_KEYS = Object.keys(TILE_LAYERS) as MapTileType[]

type TypeFilter = 'all' | 'f2f' | 'online'

/** A client with at least one thing wrong with it. */
interface AttentionRow {
  client: Client
  /** Worst first, per compareAttention. Never empty — a clean client has no row. */
  flags: AttentionFlag[]
  /**
   * Server-decided usage from the attribution ledger, never counted here.
   * Null when no cutoff is configured — the lifecycle signals still stand.
   */
  usage: ClientQuotaUsage | null
  /** A locatable meeting for the pin. */
  plotMeeting: Meeting | null
}

/**
 * What the AGENT TAGGED the meeting as — a venue kind, never a place.
 *
 * Read on its own it looks like an answer to "where was this?", and it isn't:
 * "Client office" says the agent picked that option in the app, not which office
 * or which town. Every caller therefore pairs it with the resolved GPS place and
 * prefixes it, so the claim and the measurement can't be mistaken for each other.
 */
function meetingTag(m: Meeting): string {
  if (m.meeting_type === 'online') {
    return m.online_platform === 'zoom'
      ? 'Zoom'
      : m.online_platform === 'googlemeet'
        ? 'Google Meet'
        : 'Online'
  }
  return m.location_type === 'client_office' ? 'Client office' : m.location_name || 'Other location'
}

/**
 * The clock facts of one meeting, pre-formatted.
 *
 * `meeting_date` stays the headline timestamp because it is what every other
 * surface shows — the Meetings table, the Excel export, the cutoff ledger — so a
 * row here can be matched against the same row elsewhere. The start/end capture
 * pair mobile added (live 2026-07-24) is a finer, separate fact and is reported
 * as its own window rather than replacing the headline; it is also the only
 * source of a real duration, which is why `duration` is null on the many rows
 * that predate it.
 */
function meetingClock(m: Meeting) {
  const at = new Date(m.meeting_date)
  return {
    date: format(at, 'MMM d, yyyy'),
    time: format(at, 'h:mm a'),
    dateTime: format(at, 'MMM d, yyyy · h:mm a'),
    window:
      m.start_captured_at && m.end_captured_at
        ? `${format(new Date(m.start_captured_at), 'h:mm')} – ${format(new Date(m.end_captured_at), 'h:mm a')}`
        : null,
    duration: formatDurationMinutes(meetingDurationMinutes(m)),
  }
}

/**
 * The address on the CLIENT RECORD — never where a meeting was captured.
 *
 * Named for what it is because the two were being confused: printed bare next to
 * a pin, it reads as a caption for that pin. Every caller labels it. Composition
 * lives in `clientAddress` so this surface and the Clients page agree on what a
 * client's address is, down to the fragment-plus-locality join.
 */
function officeAddressLine(client: Client): string {
  return clientAddress(client).full ?? 'No address on file'
}

/**
 * One labelled fact from the client record.
 *
 * Labelled because unlabelled it wasn't readable: the panel used to print
 * "Raham · Purchasing", "09478243642" and "distributor" as three bare icon rows,
 * where the first duplicated the company name with no hint it was a person, and
 * the last was a raw enum under the same building icon as the address — so it
 * read as a second address line. A missing value says so rather than showing an
 * em-dash that could equally mean "none" or "not asked".
 */
function ClientFact({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: string | null
  hint?: string | null
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground/70">{label}</p>
        <p className={`text-xs ${value ? 'text-foreground' : 'text-muted-foreground/60 italic'}`}>
          {value || 'Not recorded'}
        </p>
        {hint && <p className="text-[11px] text-muted-foreground truncate">{hint}</p>}
      </div>
    </div>
  )
}

/**
 * How many history rows resolve their GPS into a place name.
 *
 * A deliberate widening of the "only the selected pin gets geocoded" rule in
 * useReverseGeocode, which exists because the VISITED LIST can run to hundreds
 * of clients. One client's history is a handful of rows, and repeat visits to
 * the same account land on the same coordinates, which the shared cache folds
 * into a single request — so the real cost is usually one lookup, not ten. The
 * cap is only here so a client with fifty logged visits can't queue fifty.
 */
const HISTORY_GEOCODE_LIMIT = 10

/**
 * One visit in the selected client's history.
 *
 * Its own component so each row can resolve its own coordinates — a hook can't
 * be called in a loop. It answers three questions the old row left open: WHEN
 * (the time, not just the date — a supervisor checking a day's coverage needs
 * to know 9am from 6pm), HOW LONG (from mobile's start/end capture pair, and
 * explicitly "not recorded" where that pair is missing rather than silently
 * absent), and WHERE — the resolved GPS place, with the venue tag demoted to a
 * labelled second line because "Client office" was the only location text on
 * screen and reads as an address it isn't.
 */
function MeetingHistoryRow({
  meeting: m,
  onLocate,
  resolvePlace,
  pinned,
}: {
  meeting: Meeting
  onLocate: (m: Meeting, place?: string | null) => void
  /** False past HISTORY_GEOCODE_LIMIT — the row then shows raw coordinates. */
  resolvePlace: boolean
  /**
   * This is the visit the map pin is standing on.
   *
   * Marked because the panel header no longer names the pinned coordinate — it
   * describes the client. Without this the map could show a pin in one town
   * while the only address on screen names another, with nothing joining them,
   * which is precisely how the original "the map is broken" report happened.
   */
  pinned: boolean
}) {
  const plottable = isPlottableMeeting(m)
  const clock = meetingClock(m)
  const shouldResolve = plottable && resolvePlace
  const place = useReverseGeocode(
    shouldResolve ? m.gps_lat : null,
    shouldResolve ? m.gps_lng : null
  )

  // Online meetings carry the AGENT's coordinates, not the client's premises
  // (see isPlottableMeeting), so the place name is framed as where the agent
  // dialled in from rather than where the meeting was.
  const online = m.meeting_type === 'online'
  const placeText = !plottable
    ? 'No GPS captured'
    : place.loading
      ? 'Locating…'
      : (shouldResolve ? place.label : formatCoords(m.gps_lat!, m.gps_lng!)) ?? '—'

  return (
    <button
      type="button"
      onClick={() => onLocate(m, shouldResolve ? place.label : null)}
      disabled={!plottable}
      className={`w-full text-left rounded-lg border p-2.5 transition-colors ${
        pinned ? 'border-primary/40 bg-primary/5' : 'border-border'
      } ${
        plottable ? 'hover:bg-primary/5 hover:border-primary/40 cursor-pointer' : 'opacity-70 cursor-default'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {clock.date} <span className="text-muted-foreground font-normal">· {clock.time}</span>
        </span>
        <Badge variant="outline" className="text-[10px] px-1.5 h-4 shrink-0">
          {OUTCOME_LABEL[m.outcome] ?? m.outcome}
        </Badge>
      </div>

      {/* Duration, and what it was measured from. Stated as unrecorded rather
          than omitted: a blank row can't be told apart from a short meeting,
          and most rows predating 2026-07-24 have no capture pair at all. */}
      <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
        <Clock className="w-3 h-3 shrink-0" />
        {clock.duration ? (
          <>
            {clock.window && <span className="truncate">{clock.window} ·</span>}
            <span className="shrink-0 font-medium text-foreground">{clock.duration}</span>
          </>
        ) : (
          <span className="text-muted-foreground/70">Duration not recorded</span>
        )}
      </div>

      {/* Where, measured. The tag underneath is the agent's claim about the
          venue — see meetingTag. */}
      <div className="flex items-start gap-1.5 mt-1 text-[11px]">
        {online ? (
          <Video className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground" />
        ) : (
          <Navigation className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className={`truncate ${plottable ? 'text-foreground' : 'text-muted-foreground/70'}`}>
            {online && plottable ? `Agent at ${placeText}` : placeText}
          </p>
          <p className="text-[10px] text-muted-foreground/70 truncate">Tagged {meetingTag(m)}</p>
        </div>
        {pinned ? (
          <span className="shrink-0 flex items-center gap-1 text-[10px] font-medium text-primary">
            <MapPinIcon className="w-3 h-3" />
            On map
          </span>
        ) : plottable ? (
          <MapPinIcon className="w-3 h-3 shrink-0 mt-0.5 text-primary" />
        ) : (
          <span className="shrink-0 text-[10px] text-muted-foreground">no pin</span>
        )}
      </div>

      {(m.agent?.full_name || m.contact_person) && (
        <p className="text-[11px] text-muted-foreground mt-1 truncate">
          {[m.agent?.full_name, m.contact_person].filter(Boolean).join(' · ')}
        </p>
      )}
    </button>
  )
}

interface SalesMapViewProps {
  /** The module switcher, when this admin has more than one lens. */
  headerAction?: React.ReactNode
  /**
   * Deep link from the Clients page's agent drill-down ("View on map"):
   * pre-filters the list to this agent's clients, matching the Collection and
   * Delivery "View on map" links. `null`/omitted leaves the lens unfiltered.
   */
  initialAgentId?: string | null
}

/**
 * The Sales lens on the Maps page — a client plotted at their most recent
 * located visit.
 *
 * Deliberately NOT trip-shaped, unlike Collection and Delivery. A sales agent's
 * day is a set of appointments, not a published run worked in order, so joining
 * one agent's meetings into a line would assert a route nobody drove. The
 * question here is "when was this account last seen, and by whom" — which is why
 * the list partitions by coverage rather than into routes.
 *
 * The second lens has been through two rewrites, each fixing the last one's
 * problem. It began as "Not visited", partitioned against the toolbar date
 * range — which defaults to a single day, so it really meant "had no meeting
 * today", i.e. almost every client in the database, listed alphabetically,
 * every day, with nothing actionable in it and a blank map beside it. It then
 * became a VISIT QUOTA lens against the 2026-08-02 cap. That was honest but
 * thin: one fact, reported as a whole tab, on pins the Visited list was already
 * drawing, and duplicated in full by the Cutoff & Quota report.
 *
 * It is now NEEDS ATTENTION: the cap kept as one signal among three, alongside
 * the two client-lifecycle clocks from ADR-006 that nothing in web renders
 * today. See lib/attention.ts for what qualifies and why nothing here invents a
 * duration.
 */
export function SalesMapView({ headerAction, initialAgentId }: SalesMapViewProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | MapStatus>('all')
  // Touched pattern, mirroring TripMapView's `initialWorkerId` — the deep-linked
  // agent stands in until the admin picks one themselves, so it keeps working
  // even if this view doesn't remount on navigation.
  const [pickedAgent, setPickedAgent] = useState<'all' | 'unassigned' | string>('all')
  const [touchedAgent, setTouchedAgent] = useState(false)
  const agentFilter = touchedAgent ? pickedAgent : (initialAgentId ?? 'all')
  const setAgentFilter = (id: 'all' | 'unassigned' | string) => {
    setTouchedAgent(true)
    setPickedAgent(id)
  }
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  // A deep-linked agent means "show everything this agent has", not "show
  // today" — the default single-day window would otherwise land on an
  // near-empty map for a link that promised "all its clients".
  const dateFilter = useDateRangeFilter({ defaultPreset: initialAgentId ? 'all' : 'day' })
  const [teamFilter, setTeamFilter] = useState<'all' | string>('all')
  const [colorBy, setColorBy] = useState<'status' | 'outcome'>('status')
  const [listMode, setListMode] = useState<'visited' | 'attention'>('visited')
  /**
   * Index into `reviewablePeriods` — 0 is the newest, higher is further back.
   *
   * An index rather than a date offset because periods are explicit rows now
   * (migration 057) and need not be contiguous or evenly sized: an admin can
   * leave a gap between cutoffs, and a superseded period sits beside its
   * replacement. Stepping the list is the only way to walk them that can't
   * invent a period that was never defined.
   */
  const [periodIndex, setPeriodIndex] = useState(0)

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
  // Cutoff boundaries and the visit cap are admin-configured, never hardcoded
  // (team decision, 2026-08-02). `period` is null when no cutoff has been set,
  // and that must disable the lens rather than fall back to a guessed
  // 1-15/16-EOM — see the note on CutoffCalendar in types/index.ts.
  const { periods } = useCutoffPeriods()
  const { attributions, unattributedMeetingCount } = useCutoffAttributions()

  // Periods worth reviewing, newest first. Empty until an admin defines one —
  // migrations 057-060 seed nothing, deliberately, so that no cutoff rule is
  // enforced before someone sets it.
  const periodList = useMemo(() => reviewablePeriods(periods), [periods])
  const isConfigured = periodList.length > 0
  const period = periodList[Math.min(periodIndex, periodList.length - 1)] ?? null

  // Unlike the quota lens this replaced, Needs Attention does NOT require a
  // configured cutoff: two of its three signals are lifecycle clocks anchored
  // on the client row itself (lib/attention.ts) and run whether or not anyone
  // has ever defined a period. Only the cap signal goes quiet, which the list
  // header says out loud rather than hiding the tab over.

  /**
   * One clock for the whole render pass.
   *
   * The lifecycle signals compare against "now" per client, and reading the
   * system clock inside the loop would let a list straddle midnight — two rows
   * anchored on the same date reporting deadlines a day apart. Pinned per mount
   * instead, which is also what makes the row order stable between renders.
   */
  const now = useMemo(() => new Date(), [])

  /** Per-client usage for the visible period, folded from the ledger. */
  const usageByClient = useMemo(
    () => (period ? clientQuotaUsage(attributions, period) : new Map<string, ClientQuotaUsage>()),
    [attributions, period]
  )

  // Which meetings the server attributed to this period, per client — the pin
  // is placed at one of these rather than at "a meeting whose date falls in
  // range", so the map can never show a visit the ledger didn't attribute.
  const attributedMeetingIds = useMemo(() => {
    const byClient = new Map<string, Set<string>>()
    if (!period) return byClient
    for (const row of attributions) {
      if (row.period_id !== period.id) continue
      const set = byClient.get(row.client_id)
      if (set) set.add(row.meeting_id)
      else byClient.set(row.client_id, new Set([row.meeting_id]))
    }
    return byClient
  }, [attributions, period])

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
    period?.id ?? '',
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
    const byId = new Map<string, { id: string; name: string; teamId: string | null }>()
    let hasUnassigned = false
    clients.forEach(c => {
      if (teamFilter !== 'all' && c.agent?.team_id !== teamFilter) return
      if (c.agent) byId.set(c.agent.id, { id: c.agent.id, name: c.agent.full_name, teamId: c.agent.team_id ?? null })
      else hasUnassigned = true
    })
    return {
      hasUnassigned,
      agents: Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }
  }, [clients, teamFilter])

  // Its own memo so the picker's `items` identity survives renders that only
  // moved the map — a fresh array each time makes the combobox re-derive its
  // whole collection.
  const agentExtras = useMemo(
    () => (agentOptions.hasUnassigned ? [{ value: 'unassigned', label: 'Unassigned' }] : []),
    [agentOptions.hasUnassigned]
  )

  // The single agent the list is scoped to, if any — shown once as a header
  // instead of repeated on every row below (see the per-row agent block).
  const selectedAgent = useMemo(() => {
    if (agentFilter === 'all' || agentFilter === 'unassigned') return null
    return clients.find(c => c.agent?.id === agentFilter)?.agent ?? null
  }, [clients, agentFilter])

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

  // --- Filtered clients, as visits-in-range and as accounts needing attention -
  //
  // Two different windows on purpose. `visited` answers "what happened during
  // the dates I'm looking at" and follows the toolbar. `attention` answers
  // "what is wrong with this account", which the toolbar must not influence —
  // stepping the date filter to yesterday cannot make a 6-month lifecycle
  // deadline go away, and the cap is measured per CUTOFF PERIOD.
  const { visited, attention } = useMemo(() => {
    const q = coord ? '' : search.toLowerCase().trim()
    const vis: {
      client: Client
      inRange: Meeting[]
      plotMeeting: Meeting | null
      lastVisit: string | null
    }[] = []
    const attentionRows: AttentionRow[] = []

    // Scoped to one agent (the Clients page's "View on map" deep link) means
    // the whole roster, not just the ones with a meeting in range — a client
    // with no visit yet is still one of theirs, just unlocated. Left off the
    // unscoped list on purpose (see the block comment above `SalesMapView`):
    // that would resurrect the old "Not visited" lens, which dumped nearly
    // every client in the database with nothing actionable in it.
    const isAgentScoped = agentFilter !== 'all' && agentFilter !== 'unassigned'

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

      // Attention: only clients with something actually wrong get a row. This is
      // the break from the quota lens, which listed every client and sorted the
      // unremarkable ones to the bottom — a work queue that includes everyone is
      // not a work queue. A clean account simply isn't here.
      //
      // The meeting-type tabs deliberately do NOT apply, same as the quota lens:
      // the cap counts meetings and an online meeting is a meeting, and a
      // lifecycle clock has no opinion about how the visit was held.
      const usage = period ? usageByClient.get(client.id) ?? emptyUsage(client.id, period) : null
      const flags = clientAttention(client, all, usage, now)
      if (flags.length > 0) {
        // Pinned at the attributed visit where there is one, because that is the
        // evidence for an over-limit row. Otherwise the latest located visit at
        // all: a lifecycle clock is about the account rather than the period, so
        // restricting its pin to this cutoff would leave the very accounts the
        // lens exists to surface — the quiet ones — unplotted.
        const ids = attributedMeetingIds.get(client.id)
        const attributed = ids ? all.find(m => ids.has(m.id) && isPlottableMeeting(m)) : null
        attentionRows.push({
          client,
          flags,
          usage,
          plotMeeting: attributed ?? all.find(isPlottableMeeting) ?? null,
        })
      }

      const inRange = all.filter(m => {
        if (typeFilter !== 'all' && m.meeting_type !== typeFilter) return false
        if (!range) return true
        const t = new Date(m.meeting_date).getTime()
        return t >= range.start.getTime() && t <= range.end.getTime()
      })

      if (inRange.length === 0 && !isAgentScoped) continue

      // Pin sits at the most recent plottable f2f visit in range.
      const plotMeeting = inRange.find(isPlottableMeeting) ?? null
      vis.push({ client, inRange, plotMeeting, lastVisit: inRange[0]?.meeting_date ?? null })
    }

    // Visited-most-recently first, same as before; a client with no visit at
    // all (only possible when agent-scoped) has nothing to rank by time, so
    // those sink to the bottom, alphabetically.
    vis.sort((a, b) => {
      if (a.lastVisit && b.lastVisit) return new Date(b.lastVisit).getTime() - new Date(a.lastVisit).getTime()
      if (a.lastVisit) return -1
      if (b.lastVisit) return 1
      return a.client.company_name.localeCompare(b.client.company_name)
    })
    attentionRows.sort(compareAttention)
    return { visited: vis, attention: attentionRows }
  }, [
    clients, meetingsByClient, teamFilter, statusFilter, agentFilter, typeFilter,
    range, search, coord, period, usageByClient, attributedMeetingIds, now,
  ])

  /**
   * Per-signal tallies for the tab badge and the legend.
   *
   * Counted over every flag a row carries, not just its worst one, so the
   * legend numbers describe the pins' own vocabulary — an account that is both
   * expiring and over its cap is genuinely two problems, and a legend that only
   * counted the top one would total less than the work outstanding.
   */
  const attentionCounts = useMemo(() => {
    const acc = Object.fromEntries(ATTENTION_KEYS.map(k => [k, 0])) as Record<AttentionKind, number>
    for (const row of attention) for (const flag of row.flags) acc[flag.kind] += 1
    return acc
  }, [attention])

  /**
   * The meeting the selected client's pin is actually sitting on. Mirrors the
   * lens split in `selectClient` — each list pins a different meeting, so the
   * panel must describe the one the visible list chose.
   */
  const selectedPlotMeeting = useMemo(() => {
    if (!selectedId) return null
    const row =
      listMode === 'attention'
        ? attention.find(r => r.client.id === selectedId)
        : visited.find(v => v.client.id === selectedId)
    return row?.plotMeeting ?? null
  }, [selectedId, listMode, attention, visited])

  /**
   * Where the pin IS, in words. Resolved from the captured GPS rather than from
   * the client record, because those are two different facts and the panel used
   * to show only the second one under a map-pin icon: a meeting recorded in
   * Pampanga captioned "122, Hagonoy Bulacan", the client's registered address.
   * A tester read that as the map plotting the wrong place. Both now appear,
   * each labelled, with the GPS first — it is the evidence.
   *
   * Note this is honest about `location_type: 'client_office'` too. Mobile lets
   * an agent tag a meeting as being at the client's office wherever they are
   * standing, so that tag is a claim; this line is the measurement.
   *
   * Declared above `pins` because the pin popup shows it too: clicking a pin
   * selects that client in the same event, so by the time its popup is open this
   * is already resolving for exactly that meeting — the popup gets a real place
   * name for free, without geocoding pins nobody opened.
   */
  const plotPlace = useReverseGeocode(selectedPlotMeeting?.gps_lat, selectedPlotMeeting?.gps_lng)

  const pins = useMemo<MapPin[]>(() => {
    // Every attention signal rests on an account that has been visited at some
    // point, so all three plot — seeing WHERE trouble clusters is most of the
    // value. Only a client with no located visit in its whole history stays
    // list-only, and it is listed rather than dropped.
    /**
     * The popup lines describing the pinned visit.
     *
     * The pin used to be captioned "Client office · Aug 4" — a venue tag that
     * reads as a place, a date with no time, and no statement of where the
     * coordinates under the pin actually are. All three facts are now separate
     * lines: when, where (resolved, for the open pin — see `plotPlace`), and
     * what the agent tagged it as, prefixed so it can't be read as an address.
     */
    const visitMeta = (m: Meeting, active: boolean) => {
      const clock = meetingClock(m)
      return {
        sublabel: [clock.dateTime, clock.duration].filter(Boolean).join(' · '),
        meta: [
          active ? (plotPlace.loading ? 'Locating…' : plotPlace.label) : null,
          `Tagged ${meetingTag(m)}`,
        ],
      }
    }

    if (listMode === 'attention') {
      return attention
        .filter(r => r.plotMeeting)
        .map(r => {
          const active = r.client.id === selectedId
          const visit = visitMeta(r.plotMeeting!, active)
          return {
            id: r.client.id,
            lat: r.plotMeeting!.gps_lat!,
            lng: r.plotMeeting!.gps_lng!,
            // The worst flag owns the pin. A client can carry several and the
            // popup lists them all, but a pin has one colour and it should be
            // the one that decides where this account sits in the queue.
            color: ATTENTION_META[r.flags[0].kind].color,
            active,
            label: r.client.company_name,
            // What is wrong leads — it is what the lens is about — with every
            // other flag under it, then the pinned visit's own when/where, since
            // that is the visit the pin is standing on.
            sublabel: r.flags[0].detail,
            meta: [
              ...r.flags.slice(1).map(f => f.detail),
              `Pinned at ${visit.sublabel}`,
              ...visit.meta,
            ],
            avatarUrl: r.client.agent?.avatar_url,
          }
        })
    }

    return visited
      .filter(v => v.plotMeeting)
      .map(v => {
        const active = v.client.id === selectedId
        return {
          id: v.client.id,
          lat: v.plotMeeting!.gps_lat!,
          lng: v.plotMeeting!.gps_lng!,
          color:
            colorBy === 'outcome'
              ? OUTCOME_META[v.plotMeeting!.outcome].color
              : mapStatusMeta(v.client).color,
          active,
          label: v.client.company_name,
          ...visitMeta(v.plotMeeting!, active),
          avatarUrl: v.client.agent?.avatar_url,
        }
      })
  }, [visited, attention, selectedId, colorBy, listMode, plotPlace.loading, plotPlace.label])

  // Built from STATUS_KEYS, not a literal, so adding a lifecycle stage to
  // STATUS_META can't leave a legend row counting `undefined + 1` (NaN). A
  // status outside the map falls through to no bucket, matching the grey pin.
  const statusCounts = useMemo(() => {
    const acc = Object.fromEntries(STATUS_KEYS.map(k => [k, 0])) as Record<MapStatus, number>
    for (const v of visited) {
      const status = getMapStatus(v.client)
      if (status in acc) acc[status] += 1
    }
    return acc
  }, [visited])

  // The subset behind the prospect pin. Shown as a sub-count under that legend
  // row rather than as a fifth colour — see getMapStatus.
  const inProgressCount = useMemo(() => visited.filter(v => isInProgress(v.client)).length, [visited])

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

  /** Record fields the agent still owes, for the note in the panel. */
  const infoGaps = selected ? clientInfoGaps(selected) : []

  /**
   * What is wrong with the selected account, for the panel.
   *
   * Read off the attention list rather than recomputed, so the panel can never
   * disagree with the row that opened it. Empty on both lenses when the account
   * is clean — this is a fact about the client, not about which tab you are on,
   * so it is worth showing while browsing the Visited list too.
   */
  const selectedFlags = selectedId
    ? attention.find(r => r.client.id === selectedId)?.flags ?? []
    : []

  const selectedAddress = selected ? clientAddress(selected) : null
  // Keyed on selectedId (a string), not the client object — depending on the
  // object trips the React Compiler's mutation analysis (see git history).
  const selectedHistory = useMemo(
    () => (selectedId ? meetingsByClient.get(selectedId) ?? [] : []),
    [selectedId, meetingsByClient]
  )

  function selectClient(id: string) {
    setSelectedId(id)
    // Each lens pins a different meeting — the latest in the date range vs the
    // latest this cutoff — so fly to whichever one the visible list is showing.
    const plotMeeting =
      listMode === 'attention'
        ? attention.find(r => r.client.id === id)?.plotMeeting
        : visited.find(v => v.client.id === id)?.plotMeeting
    if (plotMeeting) {
      focusNonce.current += 1
      setHighlight(null)
      setFocus({
        lat: plotMeeting.gps_lat!,
        lng: plotMeeting.gps_lng!,
        zoom: 15,
        nonce: focusNonce.current,
      })
    }
  }

  // Clicking a meeting in the history pins it and flies there. The marker mirrors
  // the status pins — status colour + the agent's face — rather than a bare dot.
  function locateMeeting(m: Meeting, place?: string | null) {
    if (!isPlottableMeeting(m)) return
    const client = clients.find(c => c.id === m.client_id)
    const clock = meetingClock(m)
    focusNonce.current += 1
    setHighlight({
      lat: m.gps_lat!,
      lng: m.gps_lng!,
      kind: 'meeting',
      label: clock.dateTime,
      // `place` comes from the history row that was clicked — it resolved this
      // coordinate for its own line already, so the popup costs no extra lookup.
      meta: [
        clock.window ? `${clock.window}${clock.duration ? ` · ${clock.duration}` : ''}` : null,
        place,
        `Tagged ${meetingTag(m)}`,
        m.agent?.full_name ?? client?.agent?.full_name ?? null,
      ],
      color: client ? mapStatusMeta(client).color : undefined,
      avatarUrl: m.agent?.avatar_url ?? client?.agent?.avatar_url ?? null,
    })
    setFocus({ lat: m.gps_lat!, lng: m.gps_lng!, zoom: 16, nonce: focusNonce.current })
  }

  return (
    <>
      <Header
        title="Meetings Map"
        // Each lens describes its own window — the visited counts say nothing
        // about a cutoff, and quoting them under the attention list read as if
        // the date filter were still driving it.
        subtitle={
          listMode === 'attention'
            ? `${attention.length} ${attention.length === 1 ? 'account needs' : 'accounts need'} attention · ${attentionCounts.expiring} expiring · ${attentionCounts.over_limit} over limit`
            : `${rangeLabel} · ${visited.length} ${visited.length === 1 ? 'client' : 'clients'} visited · ${mappedCount} mapped · ${unlocatedCount} no location`
        }
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

        <PersonSelect
          options={agentOptions.agents}
          value={agentFilter}
          onChange={setAgentFilter}
          allLabel="All agents"
          // The list is already narrowed by the team filter beside it, so team
          // headings only earn their space while that filter is off.
          teams={teamFilter === 'all' ? teams : undefined}
          extras={agentExtras}
          aria-label="Agent"
          // Wider than the plain selects beside it: this one shows the chosen
          // name, and a full name plus the search, clear and chevron affordances
          // does not fit their 8.5rem.
          className="w-56"
        />

        {/* The window control belongs to whichever lens is showing.

            Visited measures DAYS, so it gets the day stepper and its presets.
            Attention's cap signal measures CUTOFFS, so the same slot becomes a
            cutoff stepper — step back one and you are looking at last period's
            over-limit accounts, which is the review a supervisor actually does
            at payroll time. Leaving the day filter visible there would be a
            control that changes nothing in the list in front of you. (The two
            lifecycle signals ignore the stepper entirely; a 6-month deadline is
            not a property of the cutoff you happen to be looking at.)

            The meeting-type tabs go with it, for a different reason: the cap
            counts VISITS, and an online meeting is a visit. Filtering to F2F
            would report 1/2 for a client that has genuinely used both slots, so
            the tabs are withheld rather than allowed to lie. */}
        {listMode === 'attention' ? (
          isConfigured ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPeriodIndex(i => Math.min(periodList.length - 1, i + 1))}
              // Bounded by what an admin actually defined — there is no period
              // before the first one, and inventing dates would misreport.
              disabled={periodIndex >= periodList.length - 1}
              className="h-9 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              aria-label="Previous cutoff period"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="h-9 flex items-center gap-1.5 px-3 rounded-md border border-border bg-card">
              <CalendarDays className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium text-foreground">{period?.label}</span>
              {period && (
                <span className="text-[11px] text-muted-foreground">{periodDateLabel(period)}</span>
              )}
              {/* A closed or superseded period is still worth reviewing, but the
                  reader needs to know it is not the live one. */}
              {period && period.status !== 'active' && (
                <Badge variant="outline" className="text-[9px] px-1 h-4 ml-0.5">
                  {period.status}
                </Badge>
              )}
            </div>
            <button
              type="button"
              onClick={() => setPeriodIndex(i => Math.max(0, i - 1))}
              disabled={periodIndex <= 0}
              className="h-9 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              aria-label="Next cutoff period"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          ) : (
            /* No cutoff defined, so there is no window to step and no cap to
               measure — but the lifecycle signals are unaffected, so the lens
               stays. Says which signal is missing rather than showing a dead
               stepper; the fix lives in Settings. */
            <div className="h-9 flex items-center gap-1.5 px-3 rounded-md border border-dashed border-border text-[11px] text-muted-foreground">
              <Info className="w-3.5 h-3.5 shrink-0" />
              No cutoff set — visit limits not checked
            </div>
          )
        ) : (
          <>
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
          </>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ---- Left: collapsible visited-client list -------------------------- */}
        {listOpen ? (
          <div className="w-80 shrink-0 border-r border-border flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <Tabs value={listMode} onValueChange={v => setListMode(v as 'visited' | 'attention')} className="flex-1">
                <TabsList className="h-8 w-full">
                  <TabsTrigger value="visited" className="px-2 text-xs">
                    Visited <span className="ml-1 opacity-60">{visited.length}</span>
                  </TabsTrigger>
                  {/* Badged with the whole queue, not just the worst band: every
                      row here is by definition something somebody has to do, so
                      the count is already the actionable number. */}
                  <TabsTrigger value="attention" className="px-2 text-xs">
                    Attention
                    {attention.length > 0 && (
                      <span className="ml-1 opacity-60">{attention.length}</span>
                    )}
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

            {/* Agent identity, once — mirrors the Collection/Delivery run header
                (worker shown once at the top) rather than repeating their name
                on every row below, which just clutters an already-scoped list. */}
            {selectedAgent && (
              <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border bg-muted/30">
                <Avatar size="default">
                  {selectedAgent.avatar_url && <AvatarImage src={selectedAgent.avatar_url} alt="" />}
                  <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
                    {selectedAgent.full_name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Agent
                  </p>
                  <p className="text-sm font-semibold text-foreground truncate">
                    {selectedAgent.full_name}
                  </p>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
              {listMode === 'visited' ? (
                <>
                  {visited.map(({ client, inRange, plotMeeting, lastVisit }) => {
                    const status = mapStatusMeta(client)
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
                            style={{ background: status.color }}
                          />
                          <p className="text-sm font-medium text-foreground truncate flex-1">{client.company_name}</p>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {lastVisit ? format(new Date(lastVisit), 'MMM d') : 'No visits'}
                          </span>
                        </div>
                        {/* Prefixed because this is the account's address, not
                            the pin's. See officeAddressLine. */}
                        <p className="text-xs text-muted-foreground mt-0.5 truncate pl-4">
                          <span className="text-muted-foreground/60">Office: </span>
                          {officeAddressLine(client)}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1 pl-4">
                          {/* Redundant once the agent is the list's own header. */}
                          {!selectedAgent && client.agent && (
                            <Avatar className="size-4 after:border-0">
                              {client.agent.avatar_url && <AvatarImage src={client.agent.avatar_url} alt="" />}
                              <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                                {client.agent.full_name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          {!selectedAgent && (
                            <p className="text-[11px] text-muted-foreground truncate">
                              {client.agent?.full_name ?? 'Unassigned'}
                            </p>
                          )}
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
                  {/* States what is being measured once, here, rather than
                      stamping it on every row. Sticky because the list is
                      sorted worst-first and the counts summarise what follows. */}
                  <div className="sticky top-0 z-10 px-4 py-2.5 bg-card border-b border-border">
                    <p className="text-[11px] font-medium text-foreground">
                      Needs attention
                      {period && (
                        <span className="text-muted-foreground font-normal">
                          {' '}· {period.label}, at most {period.client_meeting_cap} per client
                        </span>
                      )}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1 text-[10px] text-muted-foreground">
                      {ATTENTION_KEYS.filter(key => attentionCounts[key] > 0).map(key => (
                        <span key={key} className="flex items-center gap-1">
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: ATTENTION_META[key].color }}
                          />
                          {attentionCounts[key]} {ATTENTION_META[key].label.toLowerCase()}
                        </span>
                      ))}
                    </div>
                    {/* Meetings that predate migration 059's trigger have no
                        ledger row and are counted nowhere. Saying so beats a
                        quiet zero that reads as "nobody visited anyone". */}
                    {unattributedMeetingCount > 0 && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {unattributedMeetingCount} older {unattributedMeetingCount === 1 ? 'meeting' : 'meetings'} not attributed
                      </p>
                    )}
                  </div>

                  {attention.map(({ client, flags, usage, plotMeeting }) => {
                    const top = flags[0]
                    const meta = ATTENTION_META[top.kind]
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
                            style={{ background: meta.color }}
                          />
                          <p className="text-sm font-medium text-foreground truncate flex-1">{client.company_name}</p>
                          {/* The countdown, which is the whole point of the row.
                              Days rather than a date: "12d" is a decision, a date
                              needs arithmetic. Past-due goes negative-free and
                              says so instead. */}
                          {top.daysLeft !== null && (
                            <span
                              className="text-[11px] font-semibold shrink-0 tabular-nums"
                              style={{ color: meta.color }}
                            >
                              {top.daysLeft < 0 ? 'overdue' : `${top.daysLeft}d`}
                            </span>
                          )}
                        </div>

                        {/* Every flag, spelled out. A row exists BECAUSE of these
                            lines, so they lead — the office address that used to
                            sit here is in the panel and on the pin, and saying
                            what is wrong matters more in a queue. */}
                        <div className="mt-1 pl-4 space-y-0.5">
                          {flags.map(flag => (
                            <p key={flag.kind} className="text-[11px] leading-snug flex items-start gap-1.5">
                              <span
                                className="w-1 h-1 rounded-full shrink-0 mt-1.5"
                                style={{ background: ATTENTION_META[flag.kind].color }}
                              />
                              <span className="text-muted-foreground">{flag.detail}</span>
                            </p>
                          ))}
                        </div>

                        <div className="flex items-center gap-1.5 mt-1.5 pl-4">
                          {/* Redundant once the agent is the list's own header. */}
                          {!selectedAgent && client.agent && (
                            <Avatar className="size-4 after:border-0">
                              {client.agent.avatar_url && <AvatarImage src={client.agent.avatar_url} alt="" />}
                              <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                                {client.agent.full_name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          {!selectedAgent && (
                            <p className="text-[11px] text-muted-foreground truncate">
                              {client.agent?.full_name ?? 'Unassigned'}
                            </p>
                          )}
                          {/* A pending tag-along reserves no slot, so an
                              over-limit count can still move. Flagged so it
                              isn't read as settled. */}
                          {usage && usage.pending > 0 && (
                            <Badge variant="outline" className="text-[9px] px-1 h-3.5 shrink-0 text-muted-foreground">
                              {usage.pending} pending
                            </Badge>
                          )}
                          {!plotMeeting && (
                            <Badge variant="outline" className="text-[9px] px-1 h-3.5 shrink-0 text-muted-foreground">
                              No pin
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className="ml-auto text-[9px] px-1 h-3.5 shrink-0"
                            style={{ borderColor: `${meta.color}55`, color: meta.color }}
                          >
                            {meta.label}
                          </Badge>
                        </div>
                      </button>
                    )
                  })}
                  {attention.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground text-sm px-6 space-y-1">
                      <p className="text-foreground font-medium">Nothing needs attention</p>
                      <p className="text-xs">
                        No account is over its visit limit or near a lifecycle deadline.
                      </p>
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
              {listMode === 'visited'
                ? `${visited.length} visited`
                : `${attention.length} need attention`}
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
                  {listMode === 'attention' ? (
                    attention.length === 0 ? (
                      <>
                        <p className="font-medium text-foreground mb-0.5">Nothing needs attention</p>
                        No account is over its visit limit or near a lifecycle deadline, so there is nothing to plot.
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-foreground mb-0.5">Nothing located</p>
                        No visit to these accounts carries coordinates, so there are no pins to place. Every one is still listed on the left.
                      </>
                    )
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

          {/* Legend — top-left, clear of the detail overlay on the right. */}
          {listMode === 'attention' ? (
            /* The attention lens colours pins by what is wrong with an account,
               so it carries its own legend and no colour-by toggle — status and
               outcome would be a second colour vocabulary on the same pins. */
            <Card className="absolute top-4 left-4 w-52 bg-card/95 border-border backdrop-blur-sm z-10 pt-0 gap-0">
              <CardContent className="p-3 space-y-1.5">
                <p className="text-[10px] font-semibold text-foreground mb-2">
                  Needs attention
                </p>
                {ATTENTION_KEYS.map(key => (
                  <div key={key} className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: ATTENTION_META[key].color }}
                    />
                    <span className="text-xs text-muted-foreground">{ATTENTION_META[key].label}</span>
                    <span className="text-xs text-foreground ml-auto font-medium pl-4">
                      {attentionCounts[key]}
                    </span>
                  </div>
                ))}
                {/* A pin takes its worst flag's colour, so the legend's totals
                    can exceed the pin count. Said once here rather than left to
                    be discovered by adding the numbers up. */}
                <p className="text-[10px] text-muted-foreground/80 leading-snug pt-1">
                  An account can carry more than one; its pin shows the worst.
                </p>
              </CardContent>
            </Card>
          ) : (
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
                      <Fragment key={key}>
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_META[key].color }} />
                          <span className="text-xs text-muted-foreground">{STATUS_META[key].label}</span>
                          <span className="text-xs text-foreground ml-auto font-medium pl-4">{statusCounts[key]}</span>
                        </div>
                        {/* The in-progress subset, indented under the pin it shares.
                            Hidden at zero: an always-present "0" reads as a legend
                            entry for a colour that isn't on the map. */}
                        {key === 'prospect' && inProgressCount > 0 && (
                          <div className="flex items-center gap-2 pl-4.5">
                            <span className="text-[11px] text-muted-foreground">of which in progress</span>
                            <span className="text-[11px] text-foreground ml-auto font-medium pl-2">{inProgressCount}</span>
                          </div>
                        )}
                      </Fragment>
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
                      borderColor: `${mapStatusMeta(selected).color}55`,
                      color: mapStatusMeta(selected).color,
                    }}
                    className="text-[10px] px-1.5 h-5 mb-1.5"
                  >
                    {mapStatusMeta(selected).label}
                  </Badge>
                  <h2 className="text-base font-semibold text-foreground leading-tight truncate">{selected.company_name}</h2>

                  {/* ONE location, and it is the client's own address.
                      Deliberately no coordinates in this header.
                      ---------------------------------------------------------
                      It used to carry three location lines — the pinned visit's
                      GPS, the address, and the client's office pin — which read
                      as three places for one client. Two of them were routinely
                      the same coordinate printed twice: an office pin sourced
                      from a Client Office meeting IS that meeting's start GPS
                      (verified on live rows — identical to 7 decimals, same
                      timestamp), and 9 of the 11 pinned clients got theirs that
                      way.

                      So the header answers "who is this client and where are
                      they on paper", and every captured coordinate moved to the
                      visit that produced it, down in Meeting History. The pin
                      currently on the map is identified there too (see the
                      "Shown on map" marker), which is what keeps a caption in
                      one town and a pin in another from reading as a bug.

                      The office pin is not shown on this page at all — a
                      deliberate trade, agreed 2026-08-04. It is a property of
                      the client record, not of anything this map plots, and it
                      lives on the Clients page detail dialog with its own map
                      and its provenance. */}
                  <div className="flex items-start gap-1.5 mt-1.5">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{officeAddressLine(selected)}</p>
                      {/* Says which kind of address it is. A row can have a city
                          from sync while its `office_address` — the field the
                          agent is actually held to — is still empty, and
                          captioning that "Office address on file" contradicts
                          the outstanding-work note further down the panel. Most
                          rows are in exactly that state: 39 of 67 have a city
                          and no street. */}
                      <p className="text-[10px] text-muted-foreground/70">
                        {selectedAddress?.line
                          ? 'Office address on file'
                          : selectedAddress?.locality
                            ? `${selected.province ? 'City and province' : 'City'} on record — no street address yet`
                            : 'Office address'}
                      </p>
                      {selectedAddress?.landmark && (
                        <p className="text-[10px] text-muted-foreground/70">
                          Landmark: {selectedAddress.landmark}
                        </p>
                      )}
                    </div>
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

                {/* The client record itself. Scoped to the fields the product
                    actually judges a record on — see lib/client-info.ts — with
                    the stage left to the badge in the header rather than
                    repeated here. */}
                {/* Why this account is in the queue, stated before the record
                    details — an admin who clicked an orange pin is asking "what
                    is wrong with this one", and the answer should not be below
                    the contact number. The lifecycle rules cited here are
                    ADR-006; see lib/attention.ts. */}
                {selectedFlags.length > 0 && (
                  <div className="space-y-2 pb-3 border-b border-border">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                      Needs Attention
                    </p>
                    {selectedFlags.map(flag => (
                      <div
                        key={flag.kind}
                        className="flex items-start gap-2 p-2 rounded-lg border"
                        style={{
                          borderColor: `${ATTENTION_META[flag.kind].color}44`,
                          background: `${ATTENTION_META[flag.kind].color}0f`,
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                          style={{ background: ATTENTION_META[flag.kind].color }}
                        />
                        <div className="min-w-0">
                          <p
                            className="text-[11px] font-medium"
                            style={{ color: ATTENTION_META[flag.kind].color }}
                          >
                            {ATTENTION_META[flag.kind].label}
                          </p>
                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            {flag.detail}
                          </p>
                        </div>
                      </div>
                    ))}
                    {/* The anchor, so the countdown can be checked rather than
                        taken on trust. Both lifecycle clocks run from info
                        completion, never from creation. */}
                    {selected.details_completed_at && (
                      <p className="text-[10px] text-muted-foreground/80 leading-snug">
                        Lifecycle clocks run from info completion on{' '}
                        {format(new Date(selected.details_completed_at), 'MMM d, yyyy')}
                        {' '}· {MAX_LIFESPAN_MONTHS}-month limit
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                    Client Information
                  </p>
                  <ClientFact
                    icon={User}
                    label="Contact person"
                    value={selected.contact_person}
                    // The decision-maker's role, which is the point of capturing
                    // it — mobile's field is labelled "purchasing/CEO/owner".
                    hint={selected.contact_position}
                  />
                  <ClientFact icon={Phone} label="Contact number" value={selected.contact_number} />
                  <ClientFact
                    icon={Tag}
                    label="Sales channel"
                    // Through the shared map, so the panel says "End-User" like
                    // every other surface rather than the raw "end_user".
                    value={CHANNEL_LABEL[selected.sales_channel] ?? selected.sales_channel}
                  />

                  {/* Why a record looks thin. A field-created client is saved
                      with a name and filled in later (the two-phase create in
                      migration 013), and without this an admin reads the gaps as
                      the page failing rather than as work outstanding. The
                      deadline is the 1-month data-quality rule. */}
                  {infoGaps.length > 0 && (
                    <div className="flex items-start gap-2 p-2 rounded-lg border border-border bg-muted/30">
                      <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Still to be completed by the agent:{' '}
                        <span className="text-foreground">
                          {infoGaps.map(gap => gap.label.toLowerCase()).join(', ')}
                        </span>
                        {selected.details_deadline_at && !selected.details_completed_at && (
                          <> · due {format(new Date(selected.details_deadline_at), 'MMM d, yyyy')}</>
                        )}
                      </p>
                    </div>
                  )}
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
                    {selectedHistory.map((m, i) => (
                      <MeetingHistoryRow
                        key={m.id}
                        meeting={m}
                        onLocate={locateMeeting}
                        resolvePlace={i < HISTORY_GEOCODE_LIMIT}
                        pinned={m.id === selectedPlotMeeting?.id}
                      />
                    ))}
                    {selectedHistory.length > HISTORY_GEOCODE_LIMIT && (
                      <p className="text-[10px] text-muted-foreground pt-1">
                        Older visits show coordinates instead of a place name.
                      </p>
                    )}
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
