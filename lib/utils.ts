import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A span of minutes as "45 min" / "1 hr 20 min", for time a person spent
 * somewhere — a meeting's start-to-end capture, a truck's dwell at a stop.
 *
 * Spelled out rather than the compact "45m" this used to render. That form sat
 * two lines from a GPS gap formatted by `formatDistanceMeters` as "40 m", so one
 * meeting showed two numbers whose units differed by a single space — and a
 * reader who couldn't tell the two "m"s apart couldn't tell how LONG the meeting
 * ran from how FAR the agent moved during it. The extra characters are worth it:
 * these render in captions with room to spare, and the confusion was real enough
 * to be reported.
 *
 * Null in, null out, deliberately: across all three modules an unrecorded
 * duration is common (most meetings predate the capture pair, a stop can close
 * out with only one timestamp) and it is NOT a zero-length visit. Callers get a
 * null they have to render as an absence rather than a "0m" that reads as a fact.
 */
export function formatDurationMinutes(mins: number | null | undefined): string | null {
  if (mins == null) return null
  // A rounded-down zero, NOT an absent one — callers pass null for that. Both
  // sources round to the minute, so this is a visit under half a minute, and
  // printing it as "0 min" beside a start and end that differ ("Started 3:01 →
  // ended 3:02 · 0 min") reads as a contradiction rather than as a brief stop.
  if (mins === 0) return 'under 1 min'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/**
 * A distance in metres as "40 m" / "1.2 km", for the gap between two captured
 * GPS fixes.
 *
 * Rounded to whole metres below a kilometre and never to more precision than
 * that: consumer GPS is accurate to roughly 5-10 m outdoors and worse indoors,
 * so "38.4 m" would claim a certainty the reading doesn't have. Null in, null
 * out — an uncomputable distance is not a distance of zero.
 */
export function formatDistanceMeters(metres: number | null | undefined): string | null {
  if (metres == null) return null
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`
}
