import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { reverseGeocode, formatPlace } from '@/lib/geocode/nominatim'

export const dynamic = 'force-dynamic'

/**
 * Reverse geocoding for captured GPS — "15.0262, 120.6848" into
 * "Santo Niño, San Fernando, Pampanga".
 *
 * Exists because a meeting stores coordinates and nothing else. The sales map
 * used to print the client's REGISTERED address beside the pin, which read as a
 * caption for it: a meeting recorded in Pampanga sat under the words "122,
 * Hagonoy Bulacan" and a tester reported the map as broken. It was not — the pin
 * was right and the text was answering a different question. This route gives
 * that text a real source.
 *
 * Server-side rather than fetched straight from the map component, for three
 * reasons that all point the same way:
 *
 *  1. Nominatim's usage policy REQUIRES a User-Agent identifying the
 *     application. A browser will not let you set that header.
 *  2. The cache is shared. Agents record repeatedly from the same few places
 *     (see the 14.8761,120.9961 cluster all over the meetings table), so one
 *     admin opening the map warms it for everyone.
 *  3. The 1 req/sec limit is enforceable in one place. Per-browser throttling
 *     would still let five admins hammer it in parallel and earn a block.
 */

/**
 * Place names do not change, so entries never expire — the cap is only here to
 * stop an unbounded Map on a long-lived server. Coordinates are rounded to 4dp
 * (~11m) before they become a key, which is far finer than the barangay-level
 * answer we ask for and turns "the same shop, twenty visits" into one entry.
 */
const CACHE_LIMIT = 5000
const cache = new Map<string, string | null>()

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

/**
 * The Nominatim call, its 1-req/s throttle, and the address parsing now live in
 * lib/geocode/nominatim.ts so this route and the Store Locations derive pass
 * share ONE rate limiter (a blocked IP is blocked for the whole deployment). The
 * local `cache` above still holds this route's formatted labels.
 */
async function labelFor(lat: number, lng: number): Promise<string | null> {
  const { address, displayName } = await reverseGeocode(lat, lng)
  return formatPlace(address, displayName)
}

export async function GET(request: Request) {
  // Every map surface sits behind admin auth already; this check stops the route
  // being an open geocoding proxy for anyone who finds the URL.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const lat = Number(searchParams.get('lat'))
  const lng = Number(searchParams.get('lng'))

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 })
  }

  const key = cacheKey(lat, lng)
  if (cache.has(key)) {
    return NextResponse.json({ label: cache.get(key) ?? null, cached: true })
  }

  try {
    const label = await labelFor(lat, lng)
    // A null answer is cached too: coordinates Nominatim cannot name will not
    // become nameable on a retry, and re-asking burns the rate limit.
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, label)
    return NextResponse.json({ label, cached: false })
  } catch (error) {
    // Deliberately NOT cached — a timeout or a 429 is about this moment, not
    // about these coordinates.
    const message = error instanceof Error ? error.message : 'Reverse geocoding failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
