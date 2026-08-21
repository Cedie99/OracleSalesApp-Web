'use client'

import { useEffect, useState } from 'react'

/**
 * Resolves a SET of municipality names to map areas — see
 * `app/api/geocode/city/route.ts` for why the answer is an area rather than a
 * point, and why the network call is server-side.
 *
 * The plural is the whole reason this is a separate hook from
 * `useReverseGeocode`. That one answers about the single pin the admin clicked;
 * this one answers about every city on screen at once, because the circles are
 * the picture — resolving them one click at a time would mean the map is only
 * ever complete for places already visited.
 *
 * The cost is bounded by geography, not by row count: a day's not-worked list is
 * dozens of stores across a handful of towns, and the towns are what get looked
 * up. At 1 request/second (Nominatim's policy) that is a few seconds on the
 * first ever load and instant forever after, since municipal boundaries do not
 * move and both caches — this module's and the route's — are permanent.
 */

export interface CityPlace {
  lat: number
  lng: number
  radiusMeters: number
  label: string
  /**
   * The town's real administrative boundary, Leaflet-ready. Absent where OSM has
   * no shape for it, and the caller draws a `radiusMeters` circle instead. See
   * the route for both.
   */
  outline?: [number, number][][]
}

/**
 * Module-level and permanent, for the same reasons as the reverse hook's: two
 * lenses asking about the same town share one request, and flipping tabs does
 * not re-fetch anything. Lives as long as the tab.
 */
const cache = new Map<string, CityPlace | null>()
const inFlight = new Map<string, Promise<CityPlace | null>>()

/** Matches the route's normalisation so both sides agree on "same place". */
function cacheKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

async function fetchPlace(name: string): Promise<CityPlace | null> {
  const key = cacheKey(name)

  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const response = await fetch(`/api/geocode/city?q=${encodeURIComponent(name)}`)
      if (!response.ok) return null
      const body = (await response.json()) as { place?: CityPlace | null }
      const place = body.place ?? null
      cache.set(key, place)
      return place
    } catch {
      // Offline, or the route is down. Not cached, so it retries on next render
      // with these names.
      return null
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, request)
  return request
}

export interface CityPlacesResult {
  /** Resolved places, keyed by the ORIGINAL name the caller passed in. */
  places: Map<string, CityPlace>
  /** True while at least one name is still outstanding. */
  loading: boolean
}

/**
 * Pass the municipality names to resolve ("Tanza, Cavite"). Names that cannot be
 * resolved are simply absent from the result — a caller drawing circles draws
 * one fewer, which is the honest outcome for a place nobody can find.
 *
 * Requests are issued SEQUENTIALLY. The route serialises them anyway (one shared
 * 1 req/sec queue), so firing them in parallel would only mean every circle
 * appears at once after the last one lands instead of filling in as they
 * resolve.
 */
export function useCityPlaces(names: string[]): CityPlacesResult {
  // Sorted + joined so the effect depends on the SET of names rather than on the
  // array identity, which is rebuilt on every render of the caller.
  const key = [...new Set(names.map(cacheKey))].sort().join('|')

  /**
   * A bare counter, bumped as each name lands, purely to make a mutation of the
   * module-level Map observable to React. The resolved DATA is never held in
   * state: a changed name set is then answered during render straight from the
   * cache, rather than by a setState in the effect body — same reasoning as
   * `useReverseGeocode`, and the same lint rule
   * (`react-hooks/set-state-in-effect`) forbidding the alternative.
   */
  const [, bumpVersion] = useState(0)

  // Read straight from the shared cache during render: anything already known is
  // drawn on the first paint, with no loading flash for towns seen before.
  const places = new Map<string, CityPlace>()
  let pending = 0
  for (const name of names) {
    const hit = cache.get(cacheKey(name))
    if (hit) places.set(name, hit)
    else if (hit === undefined) pending += 1
  }

  useEffect(() => {
    if (!key) return
    let active = true

    void (async () => {
      for (const name of key.split('|')) {
        if (!active) return
        if (cache.get(name) !== undefined) continue
        await fetchPlace(name)
        // Re-render as each one lands, so the circles fill in progressively
        // rather than all appearing after the slowest lookup.
        if (active) bumpVersion(v => v + 1)
      }
    })()

    return () => {
      active = false
    }
  }, [key])

  return { places, loading: pending > 0 }
}
