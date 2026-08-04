/**
 * The trip model shared by Collection and Delivery maps.
 *
 * The office asked to "track the trips of the collectors and drivers within that
 * day" (2026-07-27). Both modules already publish one shared list per day and
 * record who worked each entry at the moment they worked it — so a trip is not
 * something anyone plans or stores. It is derived after the fact: take a day's
 * list, group the worked entries by whoever worked them, order each group by
 * when it closed out, and that ordering IS the route they drove.
 *
 * Collection and Delivery produce these from different nouns (stores vs stops,
 * amount collected vs COD) but the shape is identical, which is what lets one
 * map view serve both. Sales deliberately produces none — see `TripPath` in
 * components/maps/field-map.tsx.
 */

/** How a finished stop reads on the map and in the list. */
export type TripStopTone = 'done' | 'problem' | 'open'

export const TRIP_TONE_COLOR: Record<TripStopTone, string> = {
  done: '#34d399',
  problem: '#f87171',
  open: '#94a3b8',
}

export interface TripStopDetail {
  label: string
  value: string
}

export interface TripStop {
  id: string
  /**
   * 1-based position in this worker's own run, ALWAYS derived from the stop's
   * position inside its (worker, day) group — never read off a stored counter.
   *
   * A run resets at the start of every day for every person: two collectors on
   * Monday's list each have a #1, and each of them has a #1 again on Tuesday.
   * That is the only numbering the office reads, because the number answers
   * "which stop of this day was it?" and nothing else.
   *
   * Delivery does carry a stored `sequence_no`, but it cannot be shown: the
   * phone assigns it as `MAX(sequence_no) + 1` over the driver's whole history
   * with no day filter, so it keeps climbing across days (a driver's second day
   * starts at #4). It survives here only as an ordering key — within one day it
   * still increases in true visit order — while the number on screen comes from
   * the position. Collection has no such column and derives order from
   * `visited_at`; both modules then number identically.
   */
  sequence: number
  /** Store or customer name. */
  label: string
  /** Address (Collection) or area (Delivery). */
  sublabel: string
  /** Null when no photo was captured, so no fix came with it. */
  lat: number | null
  lng: number | null
  /** When the stop closed out. Null while nobody has reached it. */
  at: string | null
  /**
   * When the worker ARRIVED, in the modules that record it.
   *
   * Delivery does — `time_in` off the trip report — so its stops read as a
   * window ("9:58 – 10:12 AM"). Collection does not: the phone stamps a single
   * `visited_at` when the payment photo is taken, and there is no second
   * timestamp to pair it with, so this is always null there and the UI shows
   * one time rather than inventing a window.
   */
  startedAt: string | null
  /**
   * Minutes spent at the stop — Delivery's dwell. Null wherever both ends
   * aren't recorded, which is every Collection stop; never 0-as-unknown, so a
   * null must render as an absence rather than as an instant visit.
   */
  durationMinutes: number | null
  tone: TripStopTone
  statusLabel: string
  /** Peso figure for the row, pre-formatted, or null where money isn't involved. */
  amountLabel: string | null
  /** True when a closed-out stop is missing a capture its app should have blocked on. */
  missingProof: boolean
  details: TripStopDetail[]
}

export interface Trip {
  /**
   * `${workerId}|${day}` — one trip is one worker's run on one day.
   *
   * Keying on the pair rather than on the worker matters as soon as the view
   * shows more than a single day: grouping by worker alone would chain Monday's
   * last stop to Tuesday's first and draw a line across a night the truck spent
   * parked. A week of a driver's work is seven trips, not one.
   */
  id: string
  workerId: string
  /** `yyyy-MM-dd` of the run. */
  day: string
  workerName: string
  avatarUrl: string | null
  /** What this person is called in their module: "Collector" or "Driver". */
  workerRole: string
  /** Stable per worker across the day's trips, so the line and its pins match. */
  color: string
  /** Every stop this worker closed out, in the order they worked them. */
  stops: TripStop[]
  /** The subset carrying coordinates — what can actually be drawn. */
  located: TripStop[]
  /** e.g. "₱48,200 collected" — the headline figure on the worker card. */
  totalLabel: string
  /** First and last stop times, for the "08:32 – 15:15" range on the card. */
  startedAt: string | null
  endedAt: string | null
}

/**
 * Colours assigned per WORKER, not per trip — so a driver keeps one colour
 * across every day on screen and the legend stays readable over a week.
 *
 * Picked to stay legible on the satellite basemap (the map's default) as well as
 * the light one, and to avoid the greens and reds that already mean
 * done/problem on the stop tones — a worker's colour identifies WHO, never how
 * it went.
 */
export const TRIP_COLORS = [
  '#38bdf8', // sky
  '#f59e0b', // amber
  '#c084fc', // violet
  '#fb7185', // rose
  '#2dd4bf', // teal
  '#a3e635', // lime
] as const

export function tripColor(index: number): string {
  return TRIP_COLORS[index % TRIP_COLORS.length]
}

export interface WorkerDayGroup<T> {
  workerId: string
  day: string
  rows: T[]
}

/**
 * Split rows into one bucket per (worker, day), dropping anything nobody has
 * worked yet.
 *
 * Shared by both builders because the grouping rule is the part that has to
 * agree between them — Collection and Delivery differ in what a stop IS, not in
 * what makes two stops part of the same run. Rows with no worker are skipped
 * rather than pooled: an unworked store belongs to the day's list, not to
 * anyone's route, and the views list those separately.
 */
export function groupByWorkerDay<T>(
  rows: T[],
  getWorkerId: (row: T) => string | null,
  getDay: (row: T) => string
): WorkerDayGroup<T>[] {
  const buckets = new Map<string, WorkerDayGroup<T>>()

  for (const row of rows) {
    const workerId = getWorkerId(row)
    if (!workerId) continue
    const day = dayKey(getDay(row))
    const key = `${workerId}|${day}`
    const existing = buckets.get(key)
    if (existing) existing.rows.push(row)
    else buckets.set(key, { workerId, day, rows: [row] })
  }

  // Newest day first, then by worker, so the list reads the way the day boards
  // do. Colours are assigned separately (see `workerColors`) precisely so this
  // ordering can change without a worker's colour moving with it.
  return [...buckets.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.workerId.localeCompare(b.workerId)
  )
}

/**
 * One colour per worker, stable across every day on screen.
 *
 * Assigned from the sorted id list rather than from encounter order so a worker
 * doesn't change colour when a filter removes an earlier day's run.
 */
export function workerColors(workerIds: string[]): Map<string, string> {
  const unique = [...new Set(workerIds)].sort()
  return new Map(unique.map((id, i) => [id, tripColor(i)]))
}

/** Minutes between the first and last stop of a run. Null unless both exist. */
export function tripDurationMinutes(trip: Trip): number | null {
  if (!trip.startedAt || !trip.endedAt) return null
  const mins =
    (new Date(trip.endedAt).getTime() - new Date(trip.startedAt).getTime()) / 60000
  return Math.max(0, Math.round(mins))
}

/**
 * Stops that carry coordinates, in trip order — the exact points a route line is
 * drawn through.
 *
 * Unlocated stops are skipped rather than interpolated. A collector's #3 with no
 * fix means the phone never captured one, and inventing a position for it would
 * put a pin somewhere nobody went; the line simply runs #2 → #4 and the stop is
 * still listed, flagged as having no location.
 */
export function tripPoints(trip: Trip): { lat: number; lng: number }[] {
  return trip.located.map(s => ({ lat: s.lat!, lng: s.lng! }))
}

/** `yyyy-MM-dd` for a day-keyed ISO timestamp. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10)
}
