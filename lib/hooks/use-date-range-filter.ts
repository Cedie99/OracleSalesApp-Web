import { useMemo, useState } from 'react'
import { startOfDay, endOfDay, subDays, isSameDay, format } from 'date-fns'
import { activePeriod } from '@/lib/cutoff'
import { useCutoffPeriodOptions } from '@/lib/hooks/use-cutoff'
import type { CutoffPeriod } from '@/types'

export type DatePreset = 'day' | '7d' | '30d' | 'cutoff' | 'custom' | 'all'

export interface DateRange {
  start: Date
  end: Date
}

const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  day: 'Single day',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  cutoff: 'Cutoff period',
  custom: 'Custom range',
  all: 'All time',
}

/** yyyy-MM-dd for a native <input type="date"> value. */
export const toDateInput = (d: Date) => format(d, 'yyyy-MM-dd')

/** Parse a native date input in LOCAL time so the day doesn't shift a tz. */
export const fromDateInput = (v: string) => {
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export interface DateRangeFilterState {
  preset: DatePreset
  setPreset: (p: DatePreset) => void
  anchorDay: Date
  customStart: Date
  customEnd: Date
  setCustomStart: (d: Date) => void
  setCustomEnd: (d: Date) => void
  /** Step the single-day anchor backward (-1) or forward (+1). */
  stepDay: (dir: -1 | 1) => void
  /** True when the single-day anchor is today (used to cap forward stepping). */
  isToday: boolean
  /** Selectable cutoff periods, newest first. Empty while loading, or if none exist. */
  cutoffPeriods: CutoffPeriod[]
  /** The period the `cutoff` preset resolves to — the live one until changed. */
  cutoffPeriod: CutoffPeriod | null
  setCutoffPeriodId: (id: string) => void
  /** Step to the previous (-1) or next (+1) cutoff period in time. */
  stepCutoff: (dir: -1 | 1) => void
  hasOlderCutoff: boolean
  hasNewerCutoff: boolean
  /** Resolved window; `null` means "all time" — no bound. */
  range: DateRange | null
  /** Human label for the current selection (e.g. "Today", "Last 7 days"). */
  label: string
  /** Predicate: does a date value fall inside the resolved window? */
  inRange: (date: string | number | Date) => boolean
  /** True when the selection differs from the default preset. */
  isActive: boolean
  /** Stable key that changes whenever the window changes — feed to usePagination to reset paging. */
  key: string
  /** Reset back to the default preset. */
  reset: () => void
}

/**
 * Shared date-range filter used by Maps, Reports and Clock Records so all three
 * behave identically. Parses native date inputs in LOCAL time (see fromDateInput)
 * to avoid the off-by-a-day drift a bare `new Date('yyyy-MM-dd')` (UTC) causes.
 */
export function useDateRangeFilter(opts?: {
  defaultPreset?: DatePreset
  /**
   * Day the single-day preset starts on. Defaults to today.
   *
   * Exists so a caller arriving from a deep link can open on the linked day —
   * a trip belongs to its day, so landing on today would show an empty map and
   * look like the link was broken. Read once as initial state, so changing it
   * later does not yank the window out from under someone mid-browse.
   */
  defaultAnchorDay?: Date
}): DateRangeFilterState {
  const defaultPreset = opts?.defaultPreset ?? 'all'
  const initialAnchor = opts?.defaultAnchorDay
  const [preset, setPreset] = useState<DatePreset>(defaultPreset)
  const [anchorDay, setAnchorDay] = useState<Date>(() => initialAnchor ?? new Date())
  const [customStart, setCustomStart] = useState<Date>(() => new Date())
  const [customEnd, setCustomEnd] = useState<Date>(() => new Date())
  const [cutoffPeriodId, setCutoffPeriodId] = useState<string>('')

  const { options: cutoffPeriods } = useCutoffPeriodOptions()

  /**
   * The period the `cutoff` preset means right now.
   *
   * Falls through to the live period rather than to the newest row, and only
   * then to the newest, so the filter opens on the cutoff people are working in.
   * Resolved from the id rather than storing the row, so a selection survives
   * the list arriving after first paint.
   */
  const cutoffPeriod = useMemo(
    () =>
      cutoffPeriods.find(p => p.id === cutoffPeriodId) ??
      activePeriod(cutoffPeriods) ??
      cutoffPeriods[0] ??
      null,
    [cutoffPeriods, cutoffPeriodId]
  )

  const range = useMemo<DateRange | null>(() => {
    if (preset === 'all') return null
    const now = new Date()
    if (preset === '7d') return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) }
    if (preset === '30d') return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) }
    if (preset === 'cutoff') {
      // No period to bound by means no bound — the same as "all time". Only
      // reachable in the instant before the list loads, since the control hides
      // the option when there are none.
      if (!cutoffPeriod) return null
      // starts_on/ends_on are DATE columns. Parsed in LOCAL time, not UTC, for
      // the reason fromDateInput exists: the timestamps being filtered are read
      // in the viewer's zone, so a UTC parse would drop Manila's first eight
      // hours of the cutoff's opening day into the period before.
      return {
        start: startOfDay(fromDateInput(cutoffPeriod.starts_on)),
        end: endOfDay(fromDateInput(cutoffPeriod.ends_on)),
      }
    }
    if (preset === 'custom') {
      // Tolerate the two inputs being set out of order rather than showing nothing.
      const [lo, hi] =
        customStart.getTime() <= customEnd.getTime() ? [customStart, customEnd] : [customEnd, customStart]
      return { start: startOfDay(lo), end: endOfDay(hi) }
    }
    return { start: startOfDay(anchorDay), end: endOfDay(anchorDay) }
  }, [preset, anchorDay, customStart, customEnd, cutoffPeriod])

  const label = useMemo(() => {
    // The period's own name, which for a generated period IS its date range.
    // Not the word "cutoff" — this label is pasted into page subtitles and
    // empty states, where a concrete fortnight says more than the unit does.
    if (preset === 'cutoff') return cutoffPeriod?.label ?? DATE_PRESET_LABEL.cutoff
    if (preset === 'custom') {
      const [lo, hi] =
        customStart.getTime() <= customEnd.getTime() ? [customStart, customEnd] : [customEnd, customStart]
      return isSameDay(lo, hi)
        ? format(lo, 'MMM d, yyyy')
        : `${format(lo, 'MMM d')} – ${format(hi, 'MMM d, yyyy')}`
    }
    if (preset !== 'day') return DATE_PRESET_LABEL[preset]
    return isSameDay(anchorDay, new Date()) ? 'Today' : format(anchorDay, 'MMM d, yyyy')
  }, [preset, anchorDay, customStart, customEnd, cutoffPeriod])

  const inRange = useMemo(() => {
    const start = range?.start.getTime()
    const end = range?.end.getTime()
    return (date: string | number | Date) => {
      if (start == null || end == null) return true
      const t = new Date(date).getTime()
      return t >= start && t <= end
    }
  }, [range])

  const stepDay = (dir: -1 | 1) => setAnchorDay(d => subDays(d, -dir))
  const isToday = isSameDay(anchorDay, new Date())

  // Options are newest-first, so stepping BACK in time moves FORWARD through
  // the array — hence the `- dir`, which keeps stepCutoff's sign meaning the
  // same as stepDay's rather than making the caller think about ordering.
  const cutoffIndex = cutoffPeriod ? cutoffPeriods.indexOf(cutoffPeriod) : -1
  const hasOlderCutoff = cutoffIndex >= 0 && cutoffIndex < cutoffPeriods.length - 1
  const hasNewerCutoff = cutoffIndex > 0
  const stepCutoff = (dir: -1 | 1) => {
    const next = cutoffPeriods[cutoffIndex - dir]
    if (next) setCutoffPeriodId(next.id)
  }

  const isActive = preset !== defaultPreset
  const key = range ? `${range.start.getTime()}-${range.end.getTime()}` : 'all'
  const reset = () => setPreset(defaultPreset)

  return {
    preset, setPreset, anchorDay, customStart, customEnd,
    setCustomStart, setCustomEnd, stepDay, isToday,
    cutoffPeriods, cutoffPeriod, setCutoffPeriodId, stepCutoff,
    hasOlderCutoff, hasNewerCutoff,
    range, label, inRange, isActive, key, reset,
  }
}
