'use client'

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { periodDateLabel, periodPhase } from '@/lib/cutoff'
import {
  toDateInput,
  fromDateInput,
  type DatePreset,
  type DateRangeFilterState,
} from '@/lib/hooks/use-date-range-filter'

/**
 * Shared date-range control driven by useDateRangeFilter. Renders a preset
 * dropdown, prev/next steppers for single-day and cutoff mode, two native date
 * inputs for custom ranges, and a period picker for cutoffs. Keep it
 * presentational — all state lives in the hook.
 */
export function DateRangeFilter({ filter }: { filter: DateRangeFilterState }) {
  const {
    preset, setPreset, customStart, customEnd,
    setCustomStart, setCustomEnd, stepDay, isToday, label,
    cutoffPeriods, cutoffPeriod, setCutoffPeriodId,
    stepCutoff, hasOlderCutoff, hasNewerCutoff,
  } = filter

  // Both presets pick one window out of an ordered sequence, so both get the
  // same steppers rather than a second idiom for the same gesture.
  const stepping = preset === 'day' || preset === 'cutoff'

  return (
    <div className="flex items-center gap-1">
      {stepping && (
        <button
          type="button"
          onClick={() => (preset === 'day' ? stepDay(-1) : stepCutoff(-1))}
          disabled={preset === 'cutoff' && !hasOlderCutoff}
          className="h-9 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          aria-label={preset === 'day' ? 'Previous day' : 'Previous cutoff'}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      <Select value={preset} onValueChange={v => setPreset((v as DatePreset | null) ?? 'day')}>
        <SelectTrigger className="h-9 bg-card border-border gap-1.5 min-w-[9rem]">
          <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" />
          {/* The unit, not the window, in cutoff mode: the picker beside it
              already names the period, and the hook's `label` — which is that
              period's name, for page subtitles — would print it twice in a row. */}
          <span className="font-medium">{preset === 'cutoff' ? 'Cutoff period' : label}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="day">Single day</SelectItem>
          <SelectItem value="7d">Last 7 days</SelectItem>
          <SelectItem value="30d">Last 30 days</SelectItem>
          {/* Hidden when no period has started: the option would resolve to no
              window at all, which is indistinguishable from "All time" and
              tells nobody that cutoffs simply haven't been set up yet. */}
          {cutoffPeriods.length > 0 && <SelectItem value="cutoff">Cutoff period</SelectItem>}
          <SelectItem value="custom">Custom range</SelectItem>
          <SelectItem value="all">All time</SelectItem>
        </SelectContent>
      </Select>
      {preset === 'cutoff' && cutoffPeriod && (
        <Select value={cutoffPeriod.id} onValueChange={v => setCutoffPeriodId((v as string) ?? '')}>
          <SelectTrigger className="h-9 w-52 bg-card border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* A single string child, not a fragment: ui/select derives the
                trigger's label from these children and falls back to
                String(value) for anything else — which here is a raw uuid. */}
            {cutoffPeriods.map(p => (
              <SelectItem key={p.id} value={p.id}>
                {`${p.label === periodDateLabel(p) ? p.label : `${p.label} · ${periodDateLabel(p)}`}${
                  periodPhase(p) === 'current' ? ' · current' : ''
                }`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
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
      {stepping && (
        <button
          type="button"
          onClick={() => (preset === 'day' ? stepDay(1) : stepCutoff(1))}
          disabled={preset === 'day' ? isToday : !hasNewerCutoff}
          className="h-9 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          aria-label={preset === 'day' ? 'Next day' : 'Next cutoff'}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
