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
