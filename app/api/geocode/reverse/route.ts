import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

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
 * Nominatim's policy: max 1 request/second, and a blocked IP is blocked for the
 * whole deployment. 1100ms leaves room for clock jitter.
 */
const MIN_REQUEST_GAP_MS = 1100
const NOMINATIM_TIMEOUT_MS = 5000

/**
 * Place names do not change, so entries never expire — the cap is only here to
 * stop an unbounded Map on a long-lived server. Coordinates are rounded to 4dp
 * (~11m) before they become a key, which is far finer than the barangay-level
 * answer we ask for and turns "the same shop, twenty visits" into one entry.
 */
const CACHE_LIMIT = 5000
const cache = new Map<string, string | null>()

/** Serialises every outbound call into one queue — see MIN_REQUEST_GAP_MS. */
let lastRequestAt = 0
let queue: Promise<unknown> = Promise.resolve()

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

interface NominatimAddress {
  village?: string
  hamlet?: string
  suburb?: string
  neighbourhood?: string
  city?: string
  town?: string
  municipality?: string
  county?: string
  /** In the Philippines this is the PROVINCE ("Pampanga"), not the region. */
  state?: string
  region?: string
  country?: string
}

/**
 * "Barangay, Municipality, Province" — how a Filipino reads a location out loud,
 * and the level a supervisor checks a visit against.
 *
 * Verified against live responses for two of our own meeting coordinates: PH
 * results put the province in `state` and the region ("Central Luzon") in
 * `region`, which is why `region` is not used. The barangay arrives under
 * `village` in one and is absent in the other, and the municipality under `city`
 * in one and `town` in the other — hence the fallback chains rather than fixed
 * keys. Duplicates are dropped because a chartered city ("San Fernando") can
 * repeat across two of the three slots.
 */
function formatPlace(address: NominatimAddress | undefined, displayName?: string): string | null {
  if (!address) return displayName?.trim() || null

  const barangay = address.village || address.hamlet || address.suburb || address.neighbourhood
  const municipality = address.city || address.town || address.municipality || address.county
  const province = address.state

  const parts: string[] = []
  for (const part of [barangay, municipality, province]) {
    const value = part?.trim()
    if (value && !parts.includes(value)) parts.push(value)
  }

  if (parts.length > 0) return parts.join(', ')
  // Nothing administrative matched — a sea/border fix, or a country we have no
  // shape for. The full display name beats showing nothing.
  return displayName?.trim() || address.country?.trim() || null
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lng))
  // Barangay level. Higher zooms return a building or road, which is noise for
  // "was this agent where they said" and is often just missing in PH data.
  url.searchParams.set('zoom', '14')
  url.searchParams.set('addressdetails', '1')

  const response = await fetch(url, {
    headers: {
      // Required by Nominatim's usage policy. See the note at the top.
      'User-Agent': 'OracleSalesApp-Web (oraclesalesapp-web.vercel.app)',
      'Accept-Language': 'en',
    },
    signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`)

  const body = (await response.json()) as { address?: NominatimAddress; display_name?: string }
  return formatPlace(body.address, body.display_name)
}

/**
 * Runs `reverseGeocode` at most once per MIN_REQUEST_GAP_MS across all callers,
 * by chaining onto a single promise. Concurrent requests wait their turn rather
 * than being rejected — the map asks for one pin at a time, so the queue stays
 * short, and a queued answer is better than a failed one.
 */
function enqueue(lat: number, lng: number): Promise<string | null> {
  const result = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    return reverseGeocode(lat, lng)
  })
  // The queue must keep draining even when a link in it rejects, so the chain
  // swallows the failure. `result` still carries it to the caller.
  queue = result.catch(() => {})
  return result
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
    const label = await enqueue(lat, lng)
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
