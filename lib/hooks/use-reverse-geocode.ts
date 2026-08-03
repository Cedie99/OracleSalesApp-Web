'use client'

import { useEffect, useState } from 'react'

/**
 * Turns captured GPS into a place name for display — see the note in
 * `app/api/geocode/reverse/route.ts` for why this exists and why the network
 * call is server-side.
 *
 * Lazy by design: only coordinates actually on screen are ever resolved. The
 * visited list can run to hundreds of clients and resolving every row would take
 * minutes at 1 request/second, so the list keeps showing the registered address
 * (clearly labelled as such) and only the SELECTED client's pin gets a real
 * place name.
 */

/**
 * Module-level, so flipping between two clients does not re-fetch either one,
 * and so two components asking about the same pin share a single request. Lives
 * as long as the tab — place names do not change under you.
 */
const cache = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

/** Matches the server's rounding so both sides agree on what "same place" means. */
function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

/** Fallback text, and what the coordinates read as before/if geocoding fails. */
export function formatCoords(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`
}

async function fetchPlace(lat: number, lng: number): Promise<string | null> {
  const key = cacheKey(lat, lng)

  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const response = await fetch(`/api/geocode/reverse?lat=${lat}&lng=${lng}`)
      if (!response.ok) return null
      const body = (await response.json()) as { label?: string | null }
      const label = body.label ?? null
      cache.set(key, label)
      return label
    } catch {
      // Offline, or the route is down. Not cached, so it retries on next select.
      return null
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, request)
  return request
}

export interface ReverseGeocodeResult {
  /** The place name, or null while loading and when it can't be resolved. */
  place: string | null
  loading: boolean
  /**
   * Always safe to render: the place name once known, the coordinates until
   * then. Null only when there are no coordinates to describe.
   */
  label: string | null
}

/**
 * Resolves one coordinate pair. Pass null/undefined for "nothing selected" —
 * the hook stays inert rather than the caller having to branch around it.
 */
export function useReverseGeocode(
  lat: number | null | undefined,
  lng: number | null | undefined
): ReverseGeocodeResult {
  const hasCoords = lat != null && lng != null
  const key = hasCoords ? cacheKey(lat, lng) : null

  /**
   * State carries the key it belongs to, so switching pins is answered during
   * render rather than by a setState in the effect body. That matters here
   * beyond tidiness: `react-hooks/set-state-in-effect` rejects the synchronous
   * version, and a cache hit resolving in an effect would flash "Locating…" for
   * a place we already know.
   */
  const [resolved, setResolved] = useState<{ key: string; place: string | null } | null>(null)

  const cached = key ? cache.get(key) : undefined
  const place = cached !== undefined ? cached : resolved?.key === key ? resolved.place : null
  const loading = key != null && cached === undefined && resolved?.key !== key

  useEffect(() => {
    // Nothing to resolve, or the shared cache already answered during render.
    if (!hasCoords || !key || cache.get(key) !== undefined) return

    // Cancels the state write, not the request — the response still lands in the
    // shared cache, so selecting the same pin again is instant.
    let active = true
    fetchPlace(lat, lng).then(result => {
      if (active) setResolved({ key, place: result })
    })
    return () => {
      active = false
    }
  }, [hasCoords, key, lat, lng])

  return {
    place,
    loading,
    label: place ?? (hasCoords ? formatCoords(lat, lng) : null),
  }
}
