import type { ClientLocation } from '@/types'
import type { TripStop } from '@/lib/trips'

/**
 * Every place the database believes a customer might be, as one ordered list.
 *
 * A client is not a point, and this app learns where one is from three
 * independent directions that nothing previously reconciled:
 *
 *  1. `client_locations` — numbered pins a collector or driver set while
 *     standing at the store (migration 113). A customer trading from several
 *     branches accumulates one per branch, and a shop that relocates keeps its
 *     old pins as history.
 *  2. The office pin on the client record (052), reaching this file already
 *     folded into `TripStop.storeLat/storeLng` by migration 114's denormalized
 *     copy.
 *  3. The municipality on the client record. Not a point at all, and listed as
 *     an AREA so no surface can mistake it for one.
 *
 * They are presented together rather than collapsed to a winner because they
 * disagree in ways worth seeing — a store pinned in Bulacan whose record says
 * Quezon City is a real fault that only shows up when both are on screen.
 */

export type StoreLocationKind = 'pin' | 'area'

export interface StoreLocation {
  /** Stable within one stop's list, for React keys and selection. */
  id: string
  kind: StoreLocationKind
  /** "Location 2", "Registered office pin", "Quezon City". */
  label: string
  /** Who/what put it there, or null when there is nothing useful to say. */
  detail: string | null
  /** Null for an area — it has no single point, and must not be given one. */
  lat: number | null
  lng: number | null
  /** The one a new visit/PO would be stamped with (migration 114). */
  isCurrent: boolean
}

/** Coordinates match if they agree to ~1m; NUMERIC round-trips are not exact. */
function samePoint(aLat: number, aLng: number, bLat: number, bLng: number): boolean {
  return Math.abs(aLat - bLat) < 1e-5 && Math.abs(aLng - bLng) < 1e-5
}

function pinLabel(location: ClientLocation): string {
  return location.label?.trim() || `Location ${location.seq}`
}

function pinDetail(location: ClientLocation): string | null {
  const who = location.set_by_name?.trim()
  if (location.source === 'office_pin') return 'From the client record'
  if (location.source === 'admin') return who ? `Set by ${who} (admin)` : 'Set by an admin'
  if (location.source === 'migrated') return 'Carried over from an older record'
  return who ? `Set on site by ${who}` : 'Set on site'
}

/**
 * Assemble the list for one stop. Ordered current-pin first, then the remaining
 * pins by their number, then the area — most specific and most trusted at the
 * top, because that is the one someone reading this is most likely to act on.
 */
export function storeLocations(
  stop: TripStop,
  locations: ClientLocation[] | undefined
): StoreLocation[] {
  const pins = [...(locations ?? [])].sort(
    (a, b) => Number(b.is_current) - Number(a.is_current) || a.seq - b.seq
  )

  const out: StoreLocation[] = pins.map(location => ({
    id: location.id,
    kind: 'pin',
    label: pinLabel(location),
    detail: pinDetail(location),
    lat: location.lat,
    lng: location.lng,
    isCurrent: location.is_current,
  }))

  // The office pin, but ONLY when it isn't already one of the rows above.
  // `storeLat/storeLng` is COALESCE(current client_locations pin, office pin),
  // so a coordinate that matches no pin in the list can only be the office one —
  // which means this needs no extra column to identify it.
  if (
    stop.storeLat != null &&
    stop.storeLng != null &&
    !pins.some(p => samePoint(p.lat, p.lng, stop.storeLat!, stop.storeLng!))
  ) {
    out.push({
      id: `${stop.id}:office`,
      kind: 'pin',
      label: 'Registered office pin',
      detail: 'From the client record',
      lat: stop.storeLat,
      lng: stop.storeLng,
      // Nothing else is current if this is what 114 stamped onto the row.
      isCurrent: out.length === 0,
    })
  }

  if (stop.locality) {
    out.push({
      id: `${stop.id}:area`,
      kind: 'area',
      label: stop.locality,
      detail: 'Municipality on the client record — an area, not a point',
      lat: null,
      lng: null,
      isCurrent: false,
    })
  }

  return out
}
