import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A span of minutes as "45m" / "1h 20m", for time a person spent somewhere —
 * a meeting's start-to-end capture, a truck's dwell at a stop.
 *
 * Null in, null out, deliberately: across all three modules an unrecorded
 * duration is common (most meetings predate the capture pair, a stop can close
 * out with only one timestamp) and it is NOT a zero-length visit. Callers get a
 * null they have to render as an absence rather than a "0m" that reads as a fact.
 */
export function formatDurationMinutes(mins: number | null | undefined): string | null {
  if (mins == null) return null
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
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
