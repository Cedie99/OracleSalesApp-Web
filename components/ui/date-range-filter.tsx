'use client'

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import {
  toDateInput,
  fromDateInput,
  type DatePreset,
  type DateRangeFilterState,
} from '@/lib/hooks/use-date-range-filter'

/**
 * Shared date-range control driven by useDateRangeFilter. Renders a preset
 * dropdown, prev/next steppers for single-day mode, and two native date inputs
 * for custom ranges. Keep it presentational — all state lives in the hook.
 */
export function DateRangeFilter({ filter }: { filter: DateRangeFilterState }) {
  const {
    preset, setPreset, customStart, customEnd,
    setCustomStart, setCustomEnd, stepDay, isToday, label,
  } = filter

  return (
    <div className="flex items-center gap-1">
      {preset === 'day' && (
        <button
          type="button"
          onClick={() => stepDay(-1)}
          className="h-9 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          aria-label="Previous day"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      <Select value={preset} onValueChange={v => setPreset((v as DatePreset | null) ?? 'day')}>
        <SelectTrigger className="h-9 bg-card border-border gap-1.5 min-w-[9rem]">
          <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="font-medium">{label}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="day">Single day</SelectItem>
          <SelectItem value="7d">Last 7 days</SelectItem>
          <SelectItem value="30d">Last 30 days</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
          <SelectItem value="all">All time</SelectItem>
        </SelectContent>
      </Select>
      {preset === 'custom' && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={toDateInput(customStart)}
            max={toDateInput(new Date())}
            onChange={e => e.target.value && setCustomStart(fromDateInput(e.target.value))}
            aria-label="From date"
            className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            value={toDateInput(customEnd)}
            max={toDateInput(new Date())}
            onChange={e => e.target.value && setCustomEnd(fromDateInput(e.target.value))}
            aria-label="To date"
            className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      )}
      {preset === 'day' && (
        <button
          type="button"
          onClick={() => stepDay(1)}
          disabled={isToday}
          className="h-9 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          aria-label="Next day"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
