import { useMemo, useState } from 'react'
import { startOfDay, endOfDay, subDays, isSameDay, format } from 'date-fns'

export type DatePreset = 'day' | '7d' | '30d' | 'custom' | 'all'

export interface DateRange {
  start: Date
  end: Date
}

const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  day: 'Single day',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
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
export function useDateRangeFilter(opts?: { defaultPreset?: DatePreset }): DateRangeFilterState {
  const defaultPreset = opts?.defaultPreset ?? 'all'
  const [preset, setPreset] = useState<DatePreset>(defaultPreset)
  const [anchorDay, setAnchorDay] = useState<Date>(() => new Date())
  const [customStart, setCustomStart] = useState<Date>(() => new Date())
  const [customEnd, setCustomEnd] = useState<Date>(() => new Date())

  const range = useMemo<DateRange | null>(() => {
    if (preset === 'all') return null
    const now = new Date()
    if (preset === '7d') return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) }
    if (preset === '30d') return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) }
    if (preset === 'custom') {
      // Tolerate the two inputs being set out of order rather than showing nothing.
      const [lo, hi] =
        customStart.getTime() <= customEnd.getTime() ? [customStart, customEnd] : [customEnd, customStart]
      return { start: startOfDay(lo), end: endOfDay(hi) }
    }
    return { start: startOfDay(anchorDay), end: endOfDay(anchorDay) }
  }, [preset, anchorDay, customStart, customEnd])

  const label = useMemo(() => {
    if (preset === 'custom') {
      const [lo, hi] =
        customStart.getTime() <= customEnd.getTime() ? [customStart, customEnd] : [customEnd, customStart]
      return isSameDay(lo, hi)
        ? format(lo, 'MMM d, yyyy')
        : `${format(lo, 'MMM d')} – ${format(hi, 'MMM d, yyyy')}`
    }
    if (preset !== 'day') return DATE_PRESET_LABEL[preset]
    return isSameDay(anchorDay, new Date()) ? 'Today' : format(anchorDay, 'MMM d, yyyy')
  }, [preset, anchorDay, customStart, customEnd])

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
  const isActive = preset !== defaultPreset
  const key = range ? `${range.start.getTime()}-${range.end.getTime()}` : 'all'
  const reset = () => setPreset(defaultPreset)

  return {
    preset, setPreset, anchorDay, customStart, customEnd,
    setCustomStart, setCustomEnd, stepDay, isToday,
    range, label, inRange, isActive, key, reset,
  }
}
