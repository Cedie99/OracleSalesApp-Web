import type { CustomerType, CutoffCalendar, QuotaPolicy } from '@/types'

/**
 * Cutoff-period arithmetic.
 *
 * A "cutoff" is the ~15-day payroll period the sales team's visit rules are
 * measured against. The boundaries are NOT hardcoded here — they are derived
 * from an admin-configured `CutoffCalendar`, which is the whole point (see the
 * note on that type). Every function returns null when there is nothing
 * configured, so an unset calendar disables quota features instead of silently
 * falling back to a guess.
 *
 * All of this is pure, so it stays testable and can move behind a real query
 * without changing a caller.
 */

export interface CutoffPeriod {
  /** Inclusive start instant. */
  start: Date
  /**
   * EXCLUSIVE end instant — equal to the next period's start. Comparisons must
   * use `< end`, never `<= end`, or a visit logged at the boundary midnight
   * lands in both periods.
   */
  end: Date
  /** Display label, e.g. "Aug 1 – Aug 15". */
  label: string
}

/** How a client's visit count stands against its cap. */
export type QuotaState = 'exempt' | 'under' | 'at' | 'over'

// --- Timezone-aware date math ----------------------------------------------
//
// The calendar carries its own timezone (default Asia/Manila) because a cutoff
// boundary is a local-midnight event, not a UTC one — an admin in Manila
// setting "the 16th" means 00:00 PHT, which is 16:00 UTC on the 15th. Getting
// this wrong shifts every period by 8 hours and misfiles visits logged in the
// evening. Done with Intl rather than a date library because the project has no
// timezone dependency installed and this needs only two operations.

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 rather than hour12:false — the latter can render midnight as "24" on
    // some engines, which would push the day forward by one.
    hourCycle: 'h23',
  }).formatToParts(instant)

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** How far `timeZone` is ahead of UTC at this instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** The UTC instant of local midnight on a calendar date in `timeZone`. */
function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day)
  // Two passes: the first offset is sampled at the wrong instant whenever the
  // guess lands on the far side of a DST transition. Manila has no DST so one
  // pass would do today, but the timezone is admin-configurable.
  let ms = target - offsetMs(new Date(target), timeZone)
  ms = target - offsetMs(new Date(ms), timeZone)
  return new Date(ms)
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 }
}

// --- Calendar selection ------------------------------------------------------

function inEffect(
  row: { effective_from: string; effective_until: string | null; is_active: boolean },
  on: Date
): boolean {
  if (!row.is_active) return false
  // effective_from/_until are DATE columns — plain 'YYYY-MM-DD' with no zone.
  // Compared as UTC midnights, which is precise enough for a window that spans
  // months; the boundary that actually matters is the anchor day, not this.
  const t = on.getTime()
  if (Date.parse(`${row.effective_from}T00:00:00Z`) > t) return false
  if (row.effective_until && Date.parse(`${row.effective_until}T00:00:00Z`) <= t) return false
  return true
}

/**
 * The calendar governing `on`, or null when nothing is configured for that date.
 * Latest `effective_from` wins, so a future calendar can be staged ahead of
 * time and takes over on its own start date.
 */
export function activeCalendar(
  calendars: CutoffCalendar[],
  on: Date = new Date()
): CutoffCalendar | null {
  return (
    calendars
      .filter(c => inEffect(c, on))
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
  )
}

// --- Period derivation -------------------------------------------------------

/**
 * The cutoff period containing `instant`, or null if the calendar has no usable
 * anchors.
 *
 * Periods are derived by pairing consecutive anchor days: anchors [1, 16] in
 * August yield Aug 1–15 and Aug 16–31, because the second period runs until the
 * next anchor, which is Sep 1. That is what makes month length irrelevant and
 * why no calendar rows need maintaining.
 */
export function cutoffPeriodFor(instant: Date, calendar: CutoffCalendar): CutoffPeriod | null {
  const anchors = [...new Set(calendar.anchor_days)]
    .filter(d => Number.isInteger(d) && d >= 1 && d <= 28)
    .sort((a, b) => a - b)
  if (anchors.length === 0) return null

  const tz = calendar.timezone
  const { year, month, day } = zonedParts(instant, tz)

  // Start at the latest anchor on or before today; if today precedes every
  // anchor, we are still inside the period that opened last month.
  let startYear = year
  let startMonth = month
  let startDay = anchors.filter(a => a <= day).pop()
  if (startDay === undefined) {
    ;({ year: startYear, month: startMonth } = addMonths(year, month, -1))
    startDay = anchors[anchors.length - 1]
  }

  // End at the next anchor, rolling into next month past the last one.
  const index = anchors.indexOf(startDay)
  let endYear = startYear
  let endMonth = startMonth
  let endDay: number
  if (index < anchors.length - 1) {
    endDay = anchors[index + 1]
  } else {
    ;({ year: endYear, month: endMonth } = addMonths(startYear, startMonth, 1))
    endDay = anchors[0]
  }

  const start = zonedMidnightUtc(startYear, startMonth, startDay, tz)
  const end = zonedMidnightUtc(endYear, endMonth, endDay, tz)
  return { start, end, label: periodLabel(start, end, tz) }
}

/**
 * The period immediately before or after `period`.
 *
 * Deliberately does not repeat the anchor arithmetic: one millisecond outside a
 * half-open period is by definition inside the adjacent one, so probing that
 * instant through cutoffPeriodFor gives the neighbour for free and stays correct
 * for any anchor configuration.
 */
export function shiftPeriod(
  period: CutoffPeriod,
  calendar: CutoffCalendar,
  direction: -1 | 1
): CutoffPeriod | null {
  // `end` is exclusive, so it is already the first instant of the next period.
  const probe = direction < 0 ? new Date(period.start.getTime() - 1) : period.end
  return cutoffPeriodFor(probe, calendar)
}

function periodLabel(start: Date, end: Date, timeZone: string): string {
  // `end` is exclusive, so the last day shown is one millisecond earlier.
  const lastDay = new Date(end.getTime() - 1)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' })
  return `${fmt.format(start)} – ${fmt.format(lastDay)}`
}

/** True when an ISO timestamp falls inside the period. Half-open: [start, end). */
export function isWithinPeriod(isoDate: string, period: CutoffPeriod): boolean {
  const t = Date.parse(isoDate)
  return t >= period.start.getTime() && t < period.end.getTime()
}

// --- Visit cap ---------------------------------------------------------------

/**
 * How many visits a client of this type may receive per cutoff, or null when
 * uncapped.
 *
 * Null is the answer for prospects by design, not by oversight: an agent needs
 * to work a prospect as many times as it takes to qualify it. Only new and
 * existing accounts carry a ceiling.
 */
export function visitCapFor(
  customerType: CustomerType,
  policies: QuotaPolicy[],
  on: Date = new Date()
): number | null {
  const row = policies.find(
    p =>
      p.policy_kind === 'client_visit_cap' &&
      inEffect(p, on) &&
      (p.applies_to?.includes(customerType) ?? false)
  )
  return row?.target_value ?? null
}

/**
 * Where a client sits against its cap.
 *
 * 'under' covers zero visits too. The rule agreed on 2026-08-02 is a CEILING,
 * not a target — nobody is in trouble for not having visited an account yet, so
 * this deliberately does not distinguish "not started" from "one to go". If the
 * rule ever becomes "exactly 2 expected", that is the line to change.
 */
export function quotaState(visits: number, cap: number | null): QuotaState {
  if (cap == null) return 'exempt'
  if (visits > cap) return 'over'
  if (visits === cap) return 'at'
  return 'under'
}
