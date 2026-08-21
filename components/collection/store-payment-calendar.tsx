'use client'

import { useMemo, useState } from 'react'
import {
  eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth,
  startOfMonth, startOfWeek, addMonths, subMonths,
} from 'date-fns'
import { peso } from '@/lib/money'
import type { ClientCreditEntry } from '@/types'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * A month calendar of what a store PAID (migration 117), for the Store balances
 * tool.
 *
 * "How much the store pays" is exactly the store's `collection` ledger entries —
 * one per collection_payments row, each a negative delta drawn off the balance.
 * This reads over those entries only (admin charges/adjustments are the balance
 * tool's business, not a payment), buckets them by day, and shows each day's
 * total; clicking a day breaks it into the individual hand-overs. No new data —
 * it is a lens on the same ledger the history list shows.
 */

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/** Amount paid = the magnitude of a collection entry's negative delta. */
function paidAmount(entry: ClientCreditEntry): number {
  return Math.abs(entry.amount)
}

export function StorePaymentCalendar({ entries }: { entries: ClientCreditEntry[] }) {
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Only collections — this view answers "what did the store pay", never "what
  // did the admin charge it".
  const collections = useMemo(
    () => entries.filter(e => e.entry_type === 'collection'),
    [entries]
  )

  /** yyyy-MM-dd -> total paid that day. */
  const paidByDay = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of collections) {
      const key = format(new Date(e.created_at), 'yyyy-MM-dd')
      map.set(key, (map.get(key) ?? 0) + paidAmount(e))
    }
    return map
  }, [collections])

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 0 })
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 0 })
    return eachDayOfInterval({ start, end })
  }, [month])

  const monthTotal = useMemo(() => {
    let sum = 0
    for (const [key, amt] of paidByDay) {
      if (isSameMonth(new Date(`${key}T00:00:00`), month)) sum += amt
    }
    return sum
  }, [paidByDay, month])

  // What the admin set the store owes overall — the running total of the
  // non-collection movements (opening/set adjustments + charges for new goods).
  // The collections below draw the remaining balance down; this figure does not
  // move when the store pays, so it stays the "of X, this is what's been paid"
  // reference for the month totals.
  const amountDue = useMemo(
    () => entries
      .filter(e => e.entry_type !== 'collection')
      .reduce((sum, e) => sum + e.amount, 0),
    [entries]
  )

  // Every peso the store has ever paid — the magnitude of all its collections.
  const totalPaid = useMemo(
    () => collections.reduce((sum, e) => sum + paidAmount(e), 0),
    [collections]
  )

  const dayPayments = useMemo(() => {
    if (!selectedDay) return []
    return collections
      .filter(e => format(new Date(e.created_at), 'yyyy-MM-dd') === selectedDay)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [collections, selectedDay])

  function step(delta: number) {
    setMonth(m => (delta < 0 ? subMonths(m, 1) : addMonths(m, 1)))
    setSelectedDay(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Month header + running total */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous month"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[7.5rem] text-center text-sm font-medium text-foreground">
            {format(month, 'MMMM yyyy')}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next month"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
          <span>
            Amount due:{' '}
            <span className="font-medium tabular-nums text-foreground">{peso(amountDue)}</span>
          </span>
          <span>
            Total paid:{' '}
            <span className="font-medium tabular-nums text-foreground">{peso(totalPaid)}</span>
          </span>
          <span>
            Paid this month:{' '}
            <span className="font-medium tabular-nums text-foreground">{peso(monthTotal)}</span>
          </span>
        </div>
      </div>

      {/* Weekday labels */}
      <div className="grid grid-cols-7 gap-1 pb-1">
        {WEEKDAYS.map(d => (
          <span key={d} className="text-center text-[10px] font-medium uppercase text-muted-foreground">
            {d}
          </span>
        ))}
      </div>

      {/* The grid */}
      <div className="grid grid-cols-7 gap-1">
        {days.map(day => {
          const key = format(day, 'yyyy-MM-dd')
          const paid = paidByDay.get(key) ?? 0
          const inMonth = isSameMonth(day, month)
          const isSelected = selectedDay === key
          const isToday = isSameDay(day, new Date())
          return (
            <button
              key={key}
              type="button"
              disabled={paid === 0}
              onClick={() => setSelectedDay(isSelected ? null : key)}
              className={`flex aspect-square flex-col items-center justify-center rounded-md border p-0.5 text-center transition-colors disabled:cursor-default ${
                isSelected
                  ? 'border-primary bg-primary/10'
                  : paid > 0
                    ? 'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20'
                    : 'border-transparent'
              } ${!inMonth ? 'opacity-40' : ''}`}
            >
              <span
                className={`text-[11px] leading-none ${
                  isToday ? 'font-bold text-primary' : 'text-foreground'
                }`}
              >
                {format(day, 'd')}
              </span>
              {paid > 0 && (
                <span className="mt-0.5 text-[9px] font-medium leading-none tabular-nums text-emerald-600 dark:text-emerald-400">
                  {peso(paid)}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Selected-day breakdown */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {selectedDay && (
          <div className="rounded-xl border border-border">
            <p className="border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground">
              {format(new Date(`${selectedDay}T00:00:00`), 'EEEE, MMM d, yyyy')} —{' '}
              {dayPayments.length} {dayPayments.length === 1 ? 'payment' : 'payments'}
            </p>
            <ul className="divide-y divide-border">
              {dayPayments.map(e => (
                <li key={e.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    {format(new Date(e.created_at), 'h:mm a')}
                    {e.note && <span> · {e.note}</span>}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    {peso(paidAmount(e))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!selectedDay && collections.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No payments recorded for this store yet.
          </p>
        )}
      </div>
    </div>
  )
}
