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
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import type { DateRangeFilterState } from '@/lib/hooks/use-date-range-filter'
import { TILE_LAYERS, parseLatLng, type MapTileType } from '@/components/maps/map-constants'
import type { MapPin, FocusTarget, HighlightMarker, TripPath } from '@/components/maps/field-map'
import {
  TRIP_TONE_COLOR, tripDurationMinutes, tripPoints,
  type Trip, type TripStop,
} from '@/lib/trips'
import {
  Search, Layers, ChevronDown, Check, Info, PanelLeftClose, PanelLeftOpen,
  X, Crosshair, Clock, CameraOff, MapPin as MapPinIcon, Route,
} from 'lucide-react'
import { format } from 'date-fns'

const FieldMap = dynamic(() => import('@/components/maps/field-map'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 h-full flex items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
})

const TILE_KEYS = Object.keys(TILE_LAYERS) as MapTileType[]

interface Nouns {
  /** "store" / "stores", "stop" / "stops". */
  stop: [string, string]
  /** "collector" / "collectors", "driver" / "drivers". */
  worker: [string, string]
}

interface TripMapViewProps {
  /** Page heading, e.g. "Collection Trips". */
  title: string
  /** Lowercase module name used in empty-state copy, e.g. "collection". */
  moduleLabel: string
  /** Rendered to the right of the heading — the module switcher, when there is one. */
  headerAction?: React.ReactNode
  trips: Trip[]
  /**
   * Entries on the listed days that nobody has worked yet. They belong to the
   * published list rather than to a route, so they are never drawn — but an
   * admin still needs to see what is outstanding, so they get their own tab.
   */
  openStops: TripStop[]
  nouns: Nouns
  dateFilter: DateRangeFilterState
}

function plural(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The map lens for a module whose day IS a run — Collection and Delivery both.
 *
 * One component serves both because the question is identical ("where did this
 * person go, in what order, and how did each stop end?") and only the nouns
 * differ. The `Trip` model in lib/trips.ts is what makes that possible; the two
 * modules' builders do the translating, and nothing module-specific reaches
 * this file.
 *
 * Sales deliberately does NOT use this — a client pin marks their latest visit,
 * and joining one agent's meetings into a line would draw a route between
 * accounts that were never driven in sequence.
 */
export function TripMapView({
  title,
  moduleLabel,
  headerAction,
  trips,
  openStops,
  nouns,
  dateFilter,
}: TripMapViewProps) {
  const [search, setSearch] = useState('')
  const [workerFilter, setWorkerFilter] = useState<'all' | string>('all')
  const [listMode, setListMode] = useState<'trips' | 'open'>('trips')
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null)

  const [mapType, setMapType] = useState<MapTileType>('satellite')
  const [mapTypeMenuOpen, setMapTypeMenuOpen] = useState(false)
  const mapTypeMenuRef = useRef<HTMLDivElement>(null)

  const [listOpen, setListOpen] = useState(true)
  const [focus, setFocus] = useState<FocusTarget | null>(null)
  const [highlight, setHighlight] = useState<HighlightMarker | null>(null)
  const focusNonce = useRef(0)

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

  // Same reasoning as the Sales map: changing a filter rebuilds the list, so a
  // selection left standing describes a row that may no longer be on screen.
  // Reset during render rather than in an effect so nothing paints stale.
  // `search` is excluded because it sets its own highlight for coordinate entry.
  const filterKey = [workerFilter, dateFilter.key, listMode].join('|')
  const [lastFilterKey, setLastFilterKey] = useState(filterKey)
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey)
    setSelectedTripId(null)
    setSelectedStopId(null)
    setHighlight(null)
  }

  const coord = useMemo(() => parseLatLng(search), [search])

  const workerOptions = useMemo(() => {
    const byId = new Map<string, string>()
    trips.forEach(t => byId.set(t.workerId, t.workerName))
    return [...byId]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [trips])

  const visibleTrips = useMemo(() => {
    const q = coord ? '' : search.toLowerCase().trim()
    return trips.filter(trip => {
      if (workerFilter !== 'all' && trip.workerId !== workerFilter) return false
      if (!q) return true
      // Match the worker or any customer on their run — an admin searching a
      // store name wants the trip that touched it, not an empty result.
      return (
        trip.workerName.toLowerCase().includes(q) ||
        trip.stops.some(s => s.label.toLowerCase().includes(q))
      )
    })
  }, [trips, workerFilter, search, coord])

  const visibleOpenStops = useMemo(() => {
    const q = coord ? '' : search.toLowerCase().trim()
    if (!q) return openStops
    return openStops.filter(s => s.label.toLowerCase().includes(q))
  }, [openStops, search, coord])

  const pins = useMemo<MapPin[]>(
    () =>
      // The not-worked lens has nothing to plot by definition, so the map clears
      // and the panel below explains why.
      listMode === 'open'
        ? []
        : visibleTrips.flatMap(trip =>
            trip.located.map(stop => ({
              id: stop.id,
              lat: stop.lat!,
              lng: stop.lng!,
              color: trip.color,
              active: stop.id === selectedStopId,
              label: stop.label,
              sublabel: `#${stop.sequence} · ${trip.workerName} · ${stop.statusLabel}`,
              avatarUrl: trip.avatarUrl,
              badge: stop.sequence,
              badgeColor: TRIP_TONE_COLOR[stop.tone],
            }))
          ),
    [visibleTrips, selectedStopId, listMode]
  )

  const paths = useMemo<TripPath[]>(
    () =>
      listMode === 'open'
        ? []
        : visibleTrips.map(trip => ({
            id: trip.id,
            color: trip.color,
            points: tripPoints(trip),
            // Selecting one run dims the others rather than hiding them, so you
            // can still see where it sat relative to the rest of the day.
            muted: selectedTripId !== null && selectedTripId !== trip.id,
          })),
    [visibleTrips, selectedTripId, listMode]
  )

  // Built as one string rather than inlined as `All {nouns.worker[1]}`: the
  // Select derives a trigger label from its item's children and only accepts a
  // plain string (components/ui/select.tsx), so an interpolated child falls back
  // to rendering the raw value — a trigger reading "all" instead of "All drivers".
  const allWorkersLabel = `All ${nouns.worker[1]}`

  const mappedCount = visibleTrips.reduce((n, t) => n + t.located.length, 0)
  const totalStops = visibleTrips.reduce((n, t) => n + t.stops.length, 0)
  const unlocatedCount = totalStops - mappedCount

  // Plain derivation rather than a useMemo: the early-return-inside-a-loop shape
  // is one the React Compiler can't preserve, and it bails out of optimising the
  // whole component when it sees it. The scan is over one day's stops.
  const selectedStop = selectedStopId
    ? visibleTrips.reduce<{ stop: TripStop; trip: Trip } | null>((found, trip) => {
        if (found) return found
        const stop = trip.stops.find(s => s.id === selectedStopId)
        return stop ? { stop, trip } : null
      }, null)
    : null

  function onSearchChange(value: string) {
    setSearch(value)
    setSelectedStopId(null)
    setHighlight(null)
    const c = parseLatLng(value)
    if (c) {
      focusNonce.current += 1
      setHighlight({ lat: c.lat, lng: c.lng, kind: 'search', label: `${c.lat}, ${c.lng}` })
      setFocus({ lat: c.lat, lng: c.lng, zoom: 16, nonce: focusNonce.current })
    }
  }

  function selectTrip(trip: Trip) {
    const next = selectedTripId === trip.id ? null : trip.id
    setSelectedTripId(next)
    setSelectedStopId(null)
    setHighlight(null)
    // Jump to where the run started, which is the natural place to read it from.
    const first = trip.located[0]
    if (next && first) {
      focusNonce.current += 1
      setFocus({ lat: first.lat!, lng: first.lng!, zoom: 13, nonce: focusNonce.current })
    }
  }

  function selectStop(stopId: string) {
    setSelectedStopId(stopId)
    setHighlight(null)
    for (const trip of visibleTrips) {
      const stop = trip.stops.find(s => s.id === stopId)
      if (!stop) continue
      // Selecting a stop implies its run — otherwise the line it sits on would
      // stay dimmed while the pin is highlighted.
      setSelectedTripId(trip.id)
      if (stop.lat != null && stop.lng != null) {
        focusNonce.current += 1
        setFocus({ lat: stop.lat, lng: stop.lng, zoom: 16, nonce: focusNonce.current })
      }
      return
    }
  }

  return (
    <>
      <Header
        title={title}
        subtitle={`${dateFilter.label} · ${plural(visibleTrips.length, ['trip', 'trips'])} · ${mappedCount} of ${totalStops} ${nouns.stop[1]} mapped${unlocatedCount > 0 ? ` · ${unlocatedCount} no location` : ''}`}
        action={headerAction}
      />

      {/* ---- Filter toolbar -------------------------------------------------- */}
      <div className="shrink-0 border-b border-border bg-card/50 px-4 py-2.5 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          {coord ? (
            <Crosshair className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary" />
          ) : (
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          )}
          <Input
            placeholder={`Search ${nouns.worker[0]}, ${nouns.stop[0]}, or paste lat, lng…`}
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

        <Select value={workerFilter} onValueChange={v => setWorkerFilter(v ?? 'all')}>
          <SelectTrigger className="w-[10rem] h-9 bg-card border-border">
            <SelectValue placeholder={allWorkersLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{allWorkersLabel}</SelectItem>
            {workerOptions.map(w => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DateRangeFilter filter={dateFilter} />
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ---- Left: trips / not-worked list -------------------------------- */}
        {listOpen ? (
          <div className="w-80 shrink-0 border-r border-border flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <Tabs value={listMode} onValueChange={v => setListMode(v as 'trips' | 'open')} className="flex-1">
                <TabsList className="h-8 w-full">
                  <TabsTrigger value="trips" className="px-2 text-xs">
                    Trips <span className="ml-1 opacity-60">{visibleTrips.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="open" className="px-2 text-xs">
                    Not worked <span className="ml-1 opacity-60">{visibleOpenStops.length}</span>
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
              {listMode === 'trips' ? (
                <>
                  {visibleTrips.map(trip => {
                    const active = trip.id === selectedTripId
                    const duration = tripDurationMinutes(trip)
                    return (
                      <div key={trip.id}>
                        <button
                          onClick={() => selectTrip(trip)}
                          className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ background: trip.color }}
                            />
                            <Avatar className="size-5 after:border-0">
                              {trip.avatarUrl && <AvatarImage src={trip.avatarUrl} alt="" />}
                              <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                                {trip.workerName.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <p className="text-sm font-medium text-foreground truncate flex-1">
                              {trip.workerName}
                            </p>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {format(new Date(trip.day + 'T00:00:00'), 'MMM d')}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate pl-[1.1rem]">
                            {trip.workerRole}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1.5 pl-[1.1rem] flex-wrap">
                            <Badge variant="outline" className="text-[9px] px-1 h-3.5">
                              {plural(trip.stops.length, nouns.stop)}
                            </Badge>
                            <Badge variant="outline" className="text-[9px] px-1 h-3.5">
                              {trip.totalLabel}
                            </Badge>
                            {trip.startedAt && trip.endedAt && (
                              <span className="text-[10px] text-muted-foreground">
                                {format(new Date(trip.startedAt), 'HH:mm')}–
                                {format(new Date(trip.endedAt), 'HH:mm')}
                                {duration != null && ` · ${Math.floor(duration / 60)}h ${duration % 60}m`}
                              </span>
                            )}
                          </div>
                        </button>

                        {/* The run itself, in order. Only expanded for the
                            selected trip — every trip open at once is a wall. */}
                        {active && (
                          <ol className="pb-2">
                            {trip.stops.map(stop => {
                              const stopActive = stop.id === selectedStopId
                              return (
                                <li key={stop.id}>
                                  <button
                                    onClick={() => selectStop(stop.id)}
                                    className={`w-full text-left pl-6 pr-4 py-2 flex items-start gap-2.5 transition-colors ${
                                      stopActive ? 'bg-primary/15' : 'hover:bg-muted/40'
                                    }`}
                                  >
                                    <span
                                      className="mt-0.5 w-5 h-5 rounded-full shrink-0 text-[10px] font-bold flex items-center justify-center text-slate-900"
                                      style={{ background: TRIP_TONE_COLOR[stop.tone] }}
                                    >
                                      {stop.sequence}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-xs font-medium text-foreground truncate">
                                        {stop.label}
                                      </span>
                                      <span className="block text-[11px] text-muted-foreground truncate">
                                        {stop.statusLabel}
                                        {stop.amountLabel ? ` · ${stop.amountLabel}` : ''}
                                        {stop.at ? ` · ${format(new Date(stop.at), 'HH:mm')}` : ''}
                                      </span>
                                    </span>
                                    <span className="flex flex-col items-end gap-0.5 shrink-0">
                                      {stop.lat == null && (
                                        <Badge variant="outline" className="text-[9px] px-1 h-3.5 text-muted-foreground">
                                          No pin
                                        </Badge>
                                      )}
                                      {stop.missingProof && (
                                        <CameraOff className="w-3 h-3 text-destructive" />
                                      )}
                                    </span>
                                  </button>
                                </li>
                              )
                            })}
                          </ol>
                        )}
                      </div>
                    )
                  })}

                  {visibleTrips.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground text-sm px-6 space-y-3">
                      <p>No {moduleLabel} trips for {dateFilter.label.toLowerCase()}.</p>
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
                  {visibleOpenStops.map(stop => (
                    <div key={stop.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: TRIP_TONE_COLOR.open }}
                        />
                        <p className="text-sm font-medium text-foreground truncate flex-1">{stop.label}</p>
                        {stop.amountLabel && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{stop.amountLabel}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate pl-4">
                        {stop.sublabel || 'No address on file'}
                      </p>
                    </div>
                  ))}
                  {visibleOpenStops.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground text-sm px-6">
                      Nothing outstanding for {dateFilter.label.toLowerCase()} — every{' '}
                      {nouns.stop[0]} on the list was worked.
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
              {listMode === 'trips'
                ? `${visibleTrips.length} trips`
                : `${visibleOpenStops.length} not worked`}
            </span>
          </button>
        )}

        {/* ---- Map ---------------------------------------------------------- */}
        <div className="flex-1 relative min-h-0">
          <FieldMap
            pins={pins}
            trips={paths}
            onSelect={selectStop}
            mapType={mapType}
            focus={focus}
            highlight={highlight}
          />

          {pins.length === 0 && (
            <Card className="absolute top-4 left-1/2 -translate-x-1/2 bg-card/95 border-border backdrop-blur-sm z-10 py-0 gap-0 max-w-md">
              <CardContent className="p-3 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground leading-relaxed">
                  {listMode === 'open' ? (
                    <>
                      <p className="font-medium text-foreground mb-0.5">Not-worked {nouns.stop[1]}</p>
                      Nobody has reached these yet, so there is no location to plot — they&apos;re
                      listed on the left.
                    </>
                  ) : visibleTrips.length === 0 ? (
                    <>
                      <p className="font-medium text-foreground mb-0.5">
                        No trips for {dateFilter.label.toLowerCase()}
                      </p>
                      Nothing was worked in this window. Widen the date range or clear the filters.
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-foreground mb-0.5">Worked, but no location captured</p>
                      The location rides along with each {nouns.stop[0]}&apos;s photo, so
                      {' '}{nouns.stop[1]} closed out without one can&apos;t be pinned. They&apos;re listed
                      on the left.
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Legend — who is who, and what each badge colour means. */}
          {listMode === 'trips' && visibleTrips.length > 0 && (
            <Card className="absolute top-4 left-4 w-52 bg-card/95 border-border backdrop-blur-sm z-10 pt-0 gap-0">
              <CardContent className="p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Route className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[11px] font-semibold text-foreground">Trips</span>
                </div>
                {visibleTrips.slice(0, 6).map(trip => (
                  <button
                    key={trip.id}
                    type="button"
                    onClick={() => selectTrip(trip)}
                    className="flex items-center gap-2 w-full text-left"
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: trip.color }} />
                    <span className="text-xs text-muted-foreground truncate">{trip.workerName}</span>
                    <span className="text-xs text-foreground ml-auto font-medium pl-2">
                      {trip.located.length}
                    </span>
                  </button>
                ))}
                {visibleTrips.length > 6 && (
                  <p className="text-[10px] text-muted-foreground pt-0.5">
                    +{visibleTrips.length - 6} more
                  </p>
                )}
                <div className="pt-2 mt-1 border-t border-border space-y-1">
                  <p className="text-[10px] text-muted-foreground">Badge = outcome</p>
                  {([
                    ['done', 'Closed out'],
                    ['problem', 'Needs attention'],
                  ] as const).map(([tone, label]) => (
                    <div key={tone} className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: TRIP_TONE_COLOR[tone] }}
                      />
                      <span className="text-[11px] text-muted-foreground">{label}</span>
                    </div>
                  ))}
                </div>
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

          {/* ---- Stop detail overlay ---------------------------------------- */}
          {selectedStop && (
            <div className="absolute top-4 right-4 bottom-4 w-80 z-10 flex flex-col rounded-xl border border-border bg-card/95 backdrop-blur-sm shadow-lg overflow-hidden">
              <div className="flex items-start justify-between gap-2 p-4 border-b border-border">
                <div className="min-w-0">
                  <Badge
                    variant="outline"
                    style={{
                      borderColor: `${TRIP_TONE_COLOR[selectedStop.stop.tone]}55`,
                      color: TRIP_TONE_COLOR[selectedStop.stop.tone],
                    }}
                    className="text-[10px] px-1.5 h-5 mb-1.5"
                  >
                    #{selectedStop.stop.sequence} · {selectedStop.stop.statusLabel}
                  </Badge>
                  <h2 className="text-base font-semibold text-foreground leading-tight truncate">
                    {selectedStop.stop.label}
                  </h2>
                  <div className="flex items-start gap-1.5 mt-1">
                    <MapPinIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground">
                      {selectedStop.stop.sublabel || 'No address on file'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedStopId(null)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="flex items-center gap-2.5 p-2 rounded-lg bg-muted/30 border border-border">
                  <Avatar size="default">
                    {selectedStop.trip.avatarUrl && (
                      <AvatarImage src={selectedStop.trip.avatarUrl} alt={selectedStop.trip.workerName} />
                    )}
                    <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
                      {selectedStop.trip.workerName.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">
                      {selectedStop.trip.workerName}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {selectedStop.trip.workerRole}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  {selectedStop.stop.at
                    ? format(new Date(selectedStop.stop.at), 'MMM d, yyyy · h:mm a')
                    : 'Not yet closed out'}
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <MapPinIcon className="w-3.5 h-3.5 shrink-0" />
                  {selectedStop.stop.lat != null
                    ? `${selectedStop.stop.lat.toFixed(4)}° N, ${selectedStop.stop.lng?.toFixed(4)}° E`
                    : 'No GPS captured'}
                </div>

                {selectedStop.stop.missingProof && (
                  <div className="flex items-start gap-2 p-2 rounded-lg border border-destructive/40 bg-destructive/10">
                    <CameraOff className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                    <p className="text-[11px] text-destructive leading-relaxed">
                      Closed out without a capture the app should have required — worth chasing.
                    </p>
                  </div>
                )}

                <div className="pt-3 border-t border-border space-y-2">
                  {selectedStop.stop.details.map(detail => (
                    <div key={detail.label} className="flex items-start justify-between gap-3">
                      <span className="text-[11px] text-muted-foreground shrink-0">{detail.label}</span>
                      {/* No `capitalize` here: these values include free-text
                          remarks and units, which it mangles into Title Case
                          ("13 Min", "Full Load Came Back"). Anything needing
                          presentation casing is formatted by the builder. */}
                      <span className="text-[11px] text-foreground text-right">
                        {detail.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
