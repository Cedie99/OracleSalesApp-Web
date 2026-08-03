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
import { dayProgress, hasMissingProof, type CollectionDay } from '@/lib/collection'
import { peso } from '@/lib/money'
import { workerColors } from '@/lib/trips'
import { TONE_CLASS, TONE_TEXT, VISIT_STATUS_LABEL, VISIT_STATUS_TONE } from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { CalendarClock, ImageOff, Plus, X } from 'lucide-react'
import { format, isToday, isTomorrow, isYesterday } from 'date-fns'
import { useMemo } from 'react'

/** "Today" reads faster than a date the admin has to compare against a calendar. */
function dayLabel(day: Date): string {
  if (isToday(day)) return 'Today'
  if (isTomorrow(day)) return 'Tomorrow'
  if (isYesterday(day)) return 'Yesterday'
  return format(day, 'EEE, MMM d')
}

/** True for a collection day earlier than today. Today itself is still open. */
function isPastDay(day: Date): boolean {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  return day.getTime() < startOfToday.getTime()
}

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
}

interface ListBoardProps {
  days: CollectionDay[]
  /**
   * Collector to bring forward, or 'all'. A FOCUS, not a filter: rows belonging
   * to anyone else are dimmed rather than removed.
   *
   * The distinction is the whole reason this board can honour the collector
   * selection at all. Filtering the rows out would take every PENDING store with
   * them — a pending store has no `collector_id` by constraint, because the day's
   * list is a shared pool nobody owns until they work it. Dimming keeps the pool
   * on screen, which is what an admin opens this tab to see.
   */
  focusWorkerId: string
  onOpenVisit: (visit: CollectionVisit) => void
  onAddStore: (day: CollectionDay) => void
  onRemoveStore: (visit: CollectionVisit) => void
  /** Release a collector's claim, returning the store to the shared pool. */
  onCancelClaim: (visit: CollectionVisit) => void
}

/**
 * The published collection lists, one card per collection day.
 *
 * This is the admin's working surface: which stores are out there to be
 * collected on a given day, how far the team has got through the list, and what
 * is still owed on the stores nobody has reached. Collectors appear only as
 * contributors — derived from who actually collected — because the list is a
 * shared pool and no store belongs to anyone until it is worked.
 */
export function ListBoard({
  days, focusWorkerId, onOpenVisit, onAddStore, onRemoveStore, onCancelClaim,
}: ListBoardProps) {
  // Assigned across every visible day, not per card, so one collector keeps one
  // colour throughout the board — and the same colour the trip map gives them.
  const colors = useMemo(
    () => workerColors(boardWorkerIds(days.map(d => d.numbers))),
    [days]
  )

  if (days.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No collection lists for this filter</p>
        <p className="text-xs mt-1">Add a store to publish a day&apos;s list.</p>
      </div>
    )
  }

  return (
    // A grid, not full-width rows. Tried one card per row and it was worse: a
    // day card is low-density — a stat block and a handful of store rows — so
    // stretching it across a wide monitor spread DUE/COLLECTED/STILL OUT over a
    // metre of screen and marooned each row's money far from its name. Wide
    // screens want MORE content per row, not the same content spread thinner.
    <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-4 items-start">
      {days.map(day => {
        const progress = dayProgress(day)
        const done = day.pendingCount === 0
        // Claims left on a past day. Surfaced up here because the board sorts
        // newest first, so the row that needs clearing is the one nobody scrolls to.
        const stuck = staleClaimCount(day.stores)

        return (
          <Card key={day.id}>
            <CardContent className="px-4 space-y-3">
              {/* When, and how far through */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{dayLabel(day.day)}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(day.day, 'MMM d, yyyy')} · {day.stores.length}{' '}
                    {day.stores.length === 1 ? 'store' : 'stores'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <StaleClaimBadge count={stuck} />
                  <Badge
                    variant="tone"
                    className={done ? TONE_CLASS.brand : TONE_CLASS.amber}
                  >
                    {done ? 'List cleared' : `${day.pendingCount} left`}
                  </Badge>
                </div>
              </div>

              {stuck > 0 && (
                <p className={`text-[11px] ${TONE_TEXT.red}`}>
                  {stuck === 1 ? 'A store is' : `${stuck} stores are`} still claimed from this
                  day. A claim never expires and each collector may hold only one, so whoever
                  holds {stuck === 1 ? 'it' : 'them'} cannot take anything new until released.
                </p>
              )}

              {/* The collector's list decrements as they visit; this mirrors it. */}
              <div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
                  <span>{day.workedCount} of {day.stores.length} worked</span>
                  <span className="tabular-nums">{progress}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/50 p-3 text-center">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Due</p>
                  <p className="text-sm font-semibold tabular-nums">{peso(day.totalDue)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Collected</p>
                  <p className="text-sm font-semibold tabular-nums">{peso(day.totalCollected)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Still out</p>
                  <p
                    className={`text-sm font-semibold tabular-nums ${day.outstanding > 0 ? TONE_TEXT.amber : ''}`}
                  >
                    {peso(day.outstanding)}
                  </p>
                </div>
              </div>

              {/* Who has worked it — after the fact, never an assignment. */}
              {day.contributors.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[11px] text-muted-foreground">Worked by</span>
                  {day.contributors.map(c => (
                    <span key={c.id} className="inline-flex items-center gap-1.5">
                      <Avatar className="size-5 after:border-0">
                        {c.avatarUrl && <AvatarImage src={c.avatarUrl} alt="" />}
                        <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                          {initials(c.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-[11px] text-foreground">{c.name}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {c.count} · {peso(c.collected)}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <div className="divide-y divide-border rounded-xl border border-border">
                {day.stores.map(store => {
                  const number = day.numbers.get(store.id)
                  return (
                    <StoreRow
                      key={store.id}
                      store={store}
                      color={number ? colors.get(number.workerId) : undefined}
                      // Dimmed only when someone ELSE owns the row. An unowned
                      // pending store (no number) stays at full strength — it is
                      // still up for grabs by the collector being focused.
                      dimmed={
                        focusWorkerId !== 'all'
                        && number != null
                        && number.workerId !== focusWorkerId
                      }
                      onOpen={() => onOpenVisit(store)}
                      onRemove={() => onRemoveStore(store)}
                      onCancelClaim={() => onCancelClaim(store)}
                    />
                  )
                })}
              </div>

              {/* Gone entirely on a past day, not disabled. Publishing into a
                  day that has already gone would put a store on a list no
                  collector will ever see again — the phone works today's list —
                  so it would land as "not worked" the moment it was created.
                  A greyed-out button still reads as "possible, just not yet",
                  which is the wrong idea: that day is closed and will not
                  reopen. Today and future days keep the button, since
                  publishing tomorrow's list ahead of time is normal — the card
                  even has a "Tomorrow" label. */}
              {!isPastDay(day.day) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => onAddStore(day)}
                >
                  <Plus /> Add store
                </Button>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function StoreRow({
  store, color, dimmed = false, onOpen, onRemove, onCancelClaim,
}: {
  store: CollectionVisit
  /** Owned by a collector other than the one being focused. */
  dimmed?: boolean
  /** The claim holder's colour, for the avatar on the claim line. */
  color?: string
  onOpen: () => void
  onRemove: () => void
  onCancelClaim: () => void
}) {
  const missingProof = hasMissingProof(store)
  // Only an untouched store can be pulled back off the list. Once a collector
  // has been there, the record is theirs and removing it would erase captured
  // money.
  // Held right now — the store is locked to this collector and is using up
  // their single claim slot.
  const claimed = isActiveClaim(store)
  // A claimed store is NOT removable either: someone is driving to it, and
  // deleting it out from under them is how a collector arrives at a store that
  // no longer exists. Release the claim first, then remove.
  const removable = store.status === 'pending' && !claimed

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 transition-all hover:bg-muted/20 ${claimRowClass(store, claimed)} ${
        // Dimmed, never hidden — the row still counts toward the day's totals
        // above it, so removing it would make the card's own arithmetic lie.
        dimmed ? 'opacity-35' : ''
      }`}
    >
      <span className="w-4 shrink-0 flex justify-center">
        <StatusDot
          tone={VISIT_STATUS_TONE[store.status]}
          label={VISIT_STATUS_LABEL[store.status]}
        />
      </span>

      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-foreground truncate">
            {store.client?.company_name}
          </p>
          {missingProof && (
            <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${TONE_TEXT.red}`}>
              <ImageOff className="w-3 h-3" /> proof
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <Badge variant="tone" className={`text-[10px] ${TONE_CLASS[VISIT_STATUS_TONE[store.status]]}`}>
            {VISIT_STATUS_LABEL[store.status]}
          </Badge>
          {store.collector && (
            <span className="text-[11px] text-muted-foreground truncate">
              {store.collector.full_name}
            </span>
          )}
        </div>

        {/* Who is on their way. Distinct from "worked by" above, which is after
            the fact — this one is a live lock nobody else can work around. */}
        {claimed && <ClaimLine row={store} holder="collector" color={color} />}
      </button>

      {/* Money right-aligned in its own column so the figures stack into
          something scannable, which is the point of the full-width card. */}
      <span className="shrink-0 text-right tabular-nums">
        <span className="block text-sm font-medium text-foreground">
          {store.status === 'collected' ? peso(store.amount_collected ?? 0) : peso(store.amount_due)}
        </span>
        <span className="block text-[11px] text-muted-foreground">
          {store.status === 'collected' ? `of ${peso(store.amount_due)}` : 'due'}
        </span>
      </span>

      {claimed && (
        <ReleaseClaimButton
          row={store}
          holder="collector"
          target={store.client?.company_name ?? 'this store'}
          onRelease={onCancelClaim}
        />
      )}

      {removable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${store.client?.company_name} from this list`}
          // A bare × is unreadable until pressed. The confirmation explains the
          // consequence; this explains the button before you get there.
          title="Take this store off the day's list"
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  )
}
