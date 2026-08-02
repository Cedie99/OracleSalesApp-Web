'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { StopNumber } from '@/components/stop-number'
import { TONE_TEXT } from '@/lib/status-styles'
import { tripDurationMinutes, type Trip, type TripStop } from '@/lib/trips'
import { ArrowLeft, CalendarClock, ChevronRight, ImageOff, Map, MapPin } from 'lucide-react'
import { format } from 'date-fns'

/**
 * One person's run, on one day — the lens the day board cannot give.
 *
 * The Lists tab answers "what is the state of this day?", which mixes everyone's
 * work into one list because that is genuinely what a published day IS: a shared
 * pool. That makes it the wrong place to ask "what did Marisa actually do?" —
 * her stops are interleaved with everyone else's, in list order rather than the
 * order she drove them.
 *
 * This tab answers the second question and nothing else. It renders the SAME
 * `Trip[]` the map consumes (`collectionTrips` / `deliveryTrips`), so a run
 * reads identically in both places and neither can drift from the other.
 *
 * **Numbering lives here and only here.** On a shared day list a stop number is
 * ambiguous — three drivers holding one stop each all show ①, which reads as
 * broken numbering. Every row on this screen provably belongs to one person, so
 * ①②③ means what it looks like. The Lists tab shows status instead.
 *
 * Laid out as a **drill-down**, matching the agents → clients flow on the
 * Clients page: a list of people, then one person's detail behind a back button.
 * Deliberately not an accordion — several runs expanded at once rebuilds the
 * same wall of interleaved rows this tab exists to break up.
 *
 * Named `TripRuns`, not `TripList`, because `lib/delivery.ts` already exports a
 * `TripList` type meaning something different and adjacent: one DAY's published
 * list. These are the per-person runs worked off it.
 */

interface TripRunsProps {
  trips: Trip[]
  /** Module vocabulary, mirroring TripMapView's prop of the same name. */
  nouns: { stop: [string, string]; worker: [string, string] }
  /** Open one of this run's stops in the module's own detail dialog. */
  onOpenStop?: (stopId: string) => void
  /** Show this run on the trip map, already selected. */
  onViewOnMap?: (trip: Trip) => void
}

function plural(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "08:32–15:15 · 6h 43m", or null when the run has no timestamps. */
function timeRange(trip: Trip): string | null {
  if (!trip.startedAt || !trip.endedAt) return null
  const duration = tripDurationMinutes(trip)
  return `${format(new Date(trip.startedAt), 'HH:mm')}–${format(new Date(trip.endedAt), 'HH:mm')}`
    + (duration != null ? ` · ${Math.floor(duration / 60)}h ${duration % 60}m` : '')
}

/** "3 stores · ₱14,800 collected · 08:32–15:15 · 6h 43m" — the drill-down header. */
function runSummary(trip: Trip, nouns: TripRunsProps['nouns']): string {
  const parts = [plural(trip.stops.length, nouns.stop), trip.totalLabel]
  const times = timeRange(trip)
  if (times) parts.push(times)
  return parts.join(' · ')
}

export function TripRuns({ trips, nouns, onOpenStop, onViewOnMap }: TripRunsProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  // Resolved from the live list rather than held in state, so a filter change
  // that drops the run falls back to the list instead of stranding a detail
  // view of something no longer on screen.
  const selected = trips.find(t => t.id === openId) ?? null

  if (trips.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No trips in this window</p>
        <p className="text-xs mt-1">
          A trip appears once someone works a {nouns.stop[0]} on a published list.
        </p>
      </div>
    )
  }

  if (selected) {
    return (
      // Full width, deliberately. This one IS a list — a person's stops in the
      // order they worked them — so it cannot be gridded without destroying the
      // sequence, and capping it just left a dead column down the right. The
      // stretch problem is solved inside each row instead, by pushing the money
      // and time into a right-aligned column.
      <div className="space-y-4">
        <div className="space-y-3">
          <Button variant="ghost" size="sm" onClick={() => setOpenId(null)}>
            <ArrowLeft /> Back to {nouns.worker[1]}
          </Button>

          <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${selected.color}33` }}
            >
              <span className="text-sm font-bold" style={{ color: selected.color }}>
                {selected.workerName.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                {selected.workerRole} · {format(new Date(selected.day + 'T00:00:00'), 'MMM d, yyyy')}
              </p>
              <p className="text-base font-semibold text-foreground truncate">
                {selected.workerName}
              </p>
              <p className="text-xs text-muted-foreground">{runSummary(selected, nouns)}</p>
            </div>
            {onViewOnMap && (
              <Button variant="outline" size="sm" onClick={() => onViewOnMap(selected)}>
                <Map /> View on map
              </Button>
            )}
          </div>
        </div>

        <Card>
          <CardContent className="px-0 py-0">
            <ol className="divide-y divide-border">
              {selected.stops.map(stop => (
                <StopRow
                  key={stop.id}
                  stop={stop}
                  color={selected.color}
                  total={selected.stops.length}
                  workerName={selected.workerName}
                  onOpen={onOpenStop ? () => onOpenStop(stop.id) : undefined}
                />
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    // Cards in a grid rather than full-width rows: a run summary is four short
    // facts, so a row stretched across a wide monitor put the chevron a foot
    // from the name it belonged to. Mirrors how the Clients page grids its
    // client cards one level down from the agent list.
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {trips.map(trip => (
        <button
          key={trip.id}
          type="button"
          onClick={() => setOpenId(trip.id)}
          className="flex flex-col gap-3 p-4 rounded-xl bg-card border border-border shadow-sm text-left hover:border-primary/40 hover:bg-accent/30 transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Tinted with the worker's own colour — the same one their pins and
                route line carry on the map, so a person stays recognisable
                across both screens. */}
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${trip.color}33` }}
            >
              <span className="text-sm font-bold" style={{ color: trip.color }}>
                {trip.workerName.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">{trip.workerName}</p>
              <p className="text-xs text-muted-foreground">
                {format(new Date(trip.day + 'T00:00:00'), 'MMM d, yyyy')}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] px-1.5 h-4">
              {plural(trip.stops.length, nouns.stop)}
            </Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 h-4">{trip.totalLabel}</Badge>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border text-[11px] text-muted-foreground tabular-nums">
            <span>{timeRange(trip) ?? 'No times recorded'}</span>
            {/* A stop with no photo has no fix, so the route line skips it.
                Said here rather than discovered on the map. */}
            {trip.stops.length - trip.located.length > 0 && (
              <span>{trip.stops.length - trip.located.length} with no pin</span>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}

function StopRow({
  stop, color, total, workerName, onOpen,
}: {
  stop: TripStop
  color: string
  total: number
  workerName: string
  onOpen?: () => void
}) {
  const label = `${workerName}'s stop ${stop.sequence} of ${total}`
  const body = (
    <>
      {/* Unambiguous here in a way it is not on the day board: every row below
          belongs to the same person, so the number is their running order. */}
      <StopNumber sequence={stop.sequence} color={color} label={label} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground truncate">{stop.label}</span>
          {stop.missingProof && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-medium shrink-0 ${TONE_TEXT.red}`}
            >
              <ImageOff className="w-3 h-3" /> proof
            </span>
          )}
          {stop.lat == null && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0">
              <MapPin className="w-3 h-3" /> no pin
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <Badge variant="outline" className="text-[10px] px-1.5 h-4">{stop.statusLabel}</Badge>
          {stop.sublabel && (
            <span className="text-[11px] text-muted-foreground truncate">{stop.sublabel}</span>
          )}
        </span>
      </span>

      <span className="shrink-0 text-right tabular-nums">
        {stop.amountLabel && (
          <span className="block text-sm font-medium text-foreground">{stop.amountLabel}</span>
        )}
        {stop.at && (
          <span className="block text-[11px] text-muted-foreground">
            {format(new Date(stop.at), 'h:mm a')}
          </span>
        )}
      </span>
    </>
  )

  return (
    <li>
      {onOpen ? (
        <button
          onClick={onOpen}
          className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2.5 px-4 py-2.5">{body}</div>
      )}
    </li>
  )
}
