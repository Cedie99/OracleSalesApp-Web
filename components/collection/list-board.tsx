'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { dayProgress, hasMissingProof, type CollectionDay } from '@/lib/collection'
import { peso } from '@/lib/money'
import { TONE_CLASS, TONE_TEXT, VISIT_STATUS_LABEL, VISIT_STATUS_TONE } from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { CalendarClock, ImageOff, Plus, X } from 'lucide-react'
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

interface ListBoardProps {
  days: CollectionDay[]
  onOpenVisit: (visit: CollectionVisit) => void
  onAddStore: (day: CollectionDay) => void
  onRemoveStore: (visit: CollectionVisit) => void
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
export function ListBoard({ days, onOpenVisit, onAddStore, onRemoveStore }: ListBoardProps) {
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
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {days.map(day => {
        const progress = dayProgress(day)
        const done = day.pendingCount === 0

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
                <Badge
                  variant="tone"
                  className={`shrink-0 ${done ? TONE_CLASS.brand : TONE_CLASS.amber}`}
                >
                  {done ? 'List cleared' : `${day.pendingCount} left`}
                </Badge>
              </div>

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
                {day.stores.map(store => (
                  <StoreRow
                    key={store.id}
                    store={store}
                    onOpen={() => onOpenVisit(store)}
                    onRemove={() => onRemoveStore(store)}
                  />
                ))}
              </div>

              <Button variant="outline" size="sm" className="w-full" onClick={() => onAddStore(day)}>
                <Plus /> Add store
              </Button>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function StoreRow({
  store, onOpen, onRemove,
}: { store: CollectionVisit; onOpen: () => void; onRemove: () => void }) {
  const missingProof = hasMissingProof(store)
  // Only an untouched store can be pulled back off the list. Once a collector
  // has been there, the record is theirs and removing it would erase captured
  // money.
  const removable = store.status === 'pending'

  return (
    <div className="flex items-center gap-2 px-3 py-2 hover:bg-muted/20 transition-colors">
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
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {store.status === 'collected'
              ? `${peso(store.amount_collected ?? 0)} of ${peso(store.amount_due)}`
              : `${peso(store.amount_due)} due`}
          </span>
          {store.collector && (
            <span className="text-[11px] text-muted-foreground truncate">
              · {store.collector.full_name}
            </span>
          )}
        </div>
      </button>

      {removable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${store.client?.company_name} from this list`}
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  )
}
