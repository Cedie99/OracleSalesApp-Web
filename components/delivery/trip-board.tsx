'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { TRIP_CAP, dwellMinutes, hasMissingProof, tripProgress, type TripList } from '@/lib/delivery'
import { peso } from '@/lib/money'
import { DELIVERY_STATUS_LABEL, DELIVERY_STATUS_TONE, TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import type { PurchaseOrder } from '@/types'
import { CalendarClock, ImageOff, Plus, Truck, X } from 'lucide-react'
import { format, isToday, isTomorrow, isYesterday } from 'date-fns'

/** "Today" reads faster than a date the admin has to compare against a calendar. */
function dayLabel(day: Date): string {
  if (isToday(day)) return 'Today'
  if (isTomorrow(day)) return 'Tomorrow'
  if (isYesterday(day)) return 'Yesterday'
  return format(day, 'EEE, MMM d')
}

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
}

interface TripBoardProps {
  lists: TripList[]
  onOpenPo: (po: PurchaseOrder) => void
  onAddPo: (list: TripList) => void
  onRemovePo: (po: PurchaseOrder) => void
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
export function TripBoard({ lists, onOpenPo, onAddPo, onRemovePo }: TripBoardProps) {
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
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {lists.map(list => {
        const progress = tripProgress(list)
        const done = list.openCount === 0

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
                <Badge
                  variant="tone"
                  className={`shrink-0 ${done ? TONE_CLASS.brand : TONE_CLASS.amber}`}
                >
                  {done ? 'Run cleared' : `${list.openCount} left`}
                </Badge>
              </div>

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
                {list.stops.map(stop => (
                  <StopRow
                    key={stop.id}
                    stop={stop}
                    onOpen={() => onOpenPo(stop)}
                    onRemove={() => onRemovePo(stop)}
                  />
                ))}
              </div>

              {/* The paper trip ticket tops out around here, so say so before a
                  driver finds out on the road. */}
              {list.overCap && (
                <p className={`text-[11px] ${TONE_TEXT.amber}`}>
                  {list.stops.length} stops — the paper trip ticket runs about {TRIP_CAP} customers
                  per trip. This day may need splitting across two runs.
                </p>
              )}

              <Button variant="outline" size="sm" className="w-full" onClick={() => onAddPo(list)}>
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
  stop, onOpen, onRemove,
}: { stop: PurchaseOrder; onOpen: () => void; onRemove: () => void }) {
  const missingProof = hasMissingProof(stop)
  // Only an untouched stop can be pulled back off the list. Once a driver has
  // been there the record is theirs, and removing it would erase captured proof
  // — or, on a COD stop, captured money.
  const removable = stop.status === 'pending'

  return (
    <div className="flex items-center gap-2 px-3 py-2 hover:bg-muted/20 transition-colors">
      {/* The driver's own sequence number, assigned when they got there. */}
      <span
        className={`w-5 shrink-0 text-center text-[11px] font-semibold tabular-nums ${
          stop.sequence_no ? 'text-muted-foreground' : 'text-transparent'
        }`}
      >
        {stop.sequence_no ? `#${stop.sequence_no}` : '#'}
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
      </button>

      {removable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${stop.po_number} from this list`}
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  )
}
