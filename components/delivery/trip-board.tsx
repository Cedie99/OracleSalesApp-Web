'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { isActiveClaim, staleClaimCount } from '@/lib/claims'
import {
  ClaimLine, ReleaseClaimButton, StaleClaimBadge, claimRowClass,
} from '@/components/claim-indicator'
import { StatusDot } from '@/components/status-dot'
import { boardWorkerIds } from '@/lib/board-numbering'
import { TRIP_CAP, dwellMinutes, hasMissingProof, tripProgress, type TripList } from '@/lib/delivery'
import { peso } from '@/lib/money'
import { workerColors } from '@/lib/trips'
import { DELIVERY_STATUS_LABEL, DELIVERY_STATUS_TONE, TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import type { PurchaseOrder } from '@/types'
import { CalendarClock, ImageOff, Plus, Truck, X } from 'lucide-react'
import { format, isToday, isTomorrow, isYesterday } from 'date-fns'
import { useMemo } from 'react'

/** "Today" reads faster than a date the admin has to compare against a calendar. */
function dayLabel(day: Date): string {
  if (isToday(day)) return 'Today'
  if (isTomorrow(day)) return 'Tomorrow'
  if (isYesterday(day)) return 'Yesterday'
  return format(day, 'EEE, MMM d')
}

/** True for a delivery day earlier than today. Today itself is still open. */
function isPastDay(day: Date): boolean {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  return day.getTime() < startOfToday.getTime()
}

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
}

interface TripBoardProps {
  lists: TripList[]
  /**
   * Driver to bring forward, or 'all'. A FOCUS, not a filter — see the twin note
   * on ListBoard. Filtering rows out would take every waiting stop with them,
   * since a pending stop has no `driver_id` by constraint.
   */
  focusWorkerId: string
  onOpenPo: (po: PurchaseOrder) => void
  onAddPo: (list: TripList) => void
  onRemovePo: (po: PurchaseOrder) => void
  /** Release a driver's claim, returning the stop to the shared pool. */
  onCancelClaim: (po: PurchaseOrder) => void
}

/**
 * The published trip lists, one card per delivery day.
 *
 * This is the Delivery Admin's working surface: which customers are out there to
 * be delivered to on a given day, how far the drivers have got through the run,
 * and what is left. Drivers appear only as after-the-fact contributors — with
 * the plate they actually ran — because the list is a shared pool and no stop
 * belongs to anyone until someone drives it.
 */
export function TripBoard({
  lists, focusWorkerId, onOpenPo, onAddPo, onRemovePo, onCancelClaim,
}: TripBoardProps) {
  // Assigned across every visible day, not per card, so one driver keeps one
  // colour throughout the board — and the same colour the trip map gives them.
  const colors = useMemo(
    () => workerColors(boardWorkerIds(lists.map(l => l.numbers))),
    [lists]
  )

  if (lists.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No trip lists for this filter</p>
        <p className="text-xs mt-1">Add a PO to publish a day&apos;s list.</p>
      </div>
    )
  }

  return (
    // A grid, not full-width rows — see the twin note on ListBoard.
    <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-4 items-start">
      {lists.map(list => {
        const progress = tripProgress(list)
        const done = list.openCount === 0
        // Claims left on a past day — see the same note on ListBoard.
        const stuck = staleClaimCount(list.stops)

        return (
          <Card key={list.id}>
            <CardContent className="px-4 space-y-3">
              {/* When, where, and how far through */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{dayLabel(list.day)}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {format(list.day, 'MMM d, yyyy')} · {list.stops.length}{' '}
                    {list.stops.length === 1 ? 'stop' : 'stops'} · {list.areas.join(', ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <StaleClaimBadge count={stuck} />
                  <Badge
                    variant="tone"
                    className={done ? TONE_CLASS.brand : TONE_CLASS.amber}
                  >
                    {done ? 'Run cleared' : `${list.openCount} left`}
                  </Badge>
                </div>
              </div>

              {stuck > 0 && (
                <p className={`text-[11px] ${TONE_TEXT.red}`}>
                  {stuck === 1 ? 'A stop is' : `${stuck} stops are`} still claimed from this day.
                  A claim never expires and each driver may hold only one, so whoever holds{' '}
                  {stuck === 1 ? 'it' : 'them'} cannot take anything new until released.
                </p>
              )}

              {/* The driver's PO list decrements as they go; this mirrors it. */}
              <div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
                  <span>{list.closedCount} of {list.stops.length} closed out</span>
                  <span className="tabular-nums">{progress}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                {/* Nothing re-lists itself, so a failed stop is only ever closed
                    in the sense that this day is over for it. */}
                {list.failedCount > 0 && (
                  <p className={`text-[11px] mt-1.5 ${TONE_TEXT.red}`}>
                    {list.failedCount} came back on the truck — re-list on another day or write off
                  </p>
                )}
              </div>

              {/* COD only — a non-COD run has no money on it at all. */}
              {list.codDue > 0 && (
                <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/50 p-3 text-center">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">COD due</p>
                    <p className="text-sm font-semibold tabular-nums">{peso(list.codDue)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Collected</p>
                    <p className="text-sm font-semibold tabular-nums">{peso(list.codCollected)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Still out</p>
                    <p
                      className={`text-sm font-semibold tabular-nums ${list.codOutstanding > 0 ? TONE_TEXT.amber : ''}`}
                    >
                      {peso(list.codOutstanding)}
                    </p>
                  </div>
                </div>
              )}

              {/* Who ran it, and on which truck — after the fact, never a dispatch. */}
              {list.drivers.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[11px] text-muted-foreground">Run by</span>
                  {list.drivers.map(d => (
                    <span key={d.id} className="inline-flex items-center gap-1.5">
                      <Avatar className="size-5 after:border-0">
                        {d.avatarUrl && <AvatarImage src={d.avatarUrl} alt="" />}
                        <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                          {initials(d.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-[11px] text-foreground">{d.name}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {d.count} {d.plates.length > 0 && `· ${d.plates.join(', ')}`}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <div className="divide-y divide-border rounded-xl border border-border">
                {list.stops.map(stop => {
                  const number = list.numbers.get(stop.id)
                  return (
                    <StopRow
                      key={stop.id}
                      stop={stop}
                      color={number ? colors.get(number.workerId) : undefined}
                      // Only rows owned by another driver dim. An unowned waiting
                      // stop stays bright — it is still available to this driver.
                      dimmed={
                        focusWorkerId !== 'all'
                        && number != null
                        && number.workerId !== focusWorkerId
                      }
                      onOpen={() => onOpenPo(stop)}
                      onRemove={() => onRemovePo(stop)}
                      onCancelClaim={() => onCancelClaim(stop)}
                    />
                  )
                })}
              </div>

              {/* The paper trip ticket tops out around here, so say so before a
                  driver finds out on the road. */}
              {list.overCap && (
                <p className={`text-[11px] ${TONE_TEXT.amber}`}>
                  {list.stops.length} stops — the paper trip ticket runs about {TRIP_CAP} customers
                  per trip. This day may need splitting across two runs.
                </p>
              )}

              {/* A day that has already passed cannot be added to — see the
                  twin note on ListBoard. Today and future days stay open, since
                  publishing tomorrow's trip list ahead of time is normal. */}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isPastDay(list.day)}
                title={
                  isPastDay(list.day)
                    ? 'This day has passed — add the PO to today or a later day instead'
                    : undefined
                }
                onClick={() => onAddPo(list)}
              >
                <Plus /> Add PO
              </Button>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function StopRow({
  stop, color, dimmed = false, onOpen, onRemove, onCancelClaim,
}: {
  stop: PurchaseOrder
  /** Owned by a driver other than the one being focused. */
  dimmed?: boolean
  /** The claim holder's colour, for the avatar on the claim line. */
  color?: string
  onOpen: () => void
  onRemove: () => void
  onCancelClaim: () => void
}) {
  const missingProof = hasMissingProof(stop)
  // Held right now — the stop is locked to this driver and is using up their
  // single claim slot.
  const claimed = isActiveClaim(stop)
  // Only an untouched stop can be pulled back off the list. Once a driver has
  // been there the record is theirs, and removing it would erase captured proof
  // — or, on a COD stop, captured money. A claimed stop is also off limits:
  // someone is driving to it. Release the claim first.
  const removable = stop.status === 'pending' && !claimed

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 transition-all hover:bg-muted/20 ${claimRowClass(stop, claimed)} ${
        // Dimmed, never hidden — the row still counts toward the card's totals.
        dimmed ? 'opacity-35' : ''
      }`}
    >
      {/* State, not sequence — see StatusDot. A per-person stop number was here
          briefly and read as broken numbering on a shared list: three drivers
          holding one stop each all showed ①. The run order lives on Activity →
          By driver, where every row belongs to the same person. */}
      <span className="w-4 shrink-0 flex justify-center">
        <StatusDot
          tone={DELIVERY_STATUS_TONE[stop.status]}
          label={DELIVERY_STATUS_LABEL[stop.status]}
        />
      </span>

      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-foreground truncate">
            {stop.client?.company_name}
          </p>
          <span className="text-[11px] text-muted-foreground shrink-0">{stop.po_number}</span>
          {missingProof && (
            <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${TONE_TEXT.red}`}>
              <ImageOff className="w-3 h-3" /> proof
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <Badge variant="tone" className={`text-[10px] ${TONE_CLASS[DELIVERY_STATUS_TONE[stop.status]]}`}>
            {DELIVERY_STATUS_LABEL[stop.status]}
          </Badge>
          {stop.status === 'failed' && (
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">backloaded</span>
          )}
          <span className="text-[11px] text-muted-foreground truncate">{stop.area}</span>
          {stop.cod && (
            <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
              · COD {peso(stop.cod_amount ?? stop.cod_due ?? 0)}
            </span>
          )}
          {stop.truck_plate && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
              <Truck className="w-3 h-3" /> {stop.truck_plate}
            </span>
          )}
          {stop.time_in && stop.time_out && (
            <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
              · {format(new Date(stop.time_in), 'h:mm')}—{format(new Date(stop.time_out), 'h:mm a')}
              {' '}({dwellMinutes(stop)}m)
            </span>
          )}
        </div>

        {/* Who is on their way. A live lock, unlike the plate/driver above which
            are recorded after the stop was actually run. */}
        {claimed && <ClaimLine row={stop} holder="driver" color={color} />}
      </button>

      {claimed && (
        <ReleaseClaimButton
          row={stop}
          holder="driver"
          target={stop.po_number}
          onRelease={onCancelClaim}
        />
      )}

      {removable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${stop.po_number} from this list`}
          title="Take this stop off the day's trip list"
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  )
}
