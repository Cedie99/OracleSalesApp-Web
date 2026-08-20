import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * Forward geocoding for a MUNICIPALITY — "Tanza, Cavite" into the town's
 * boundary on the map.
 *
 * The twin of ../reverse/route.ts, which turns captured GPS into words. This one
 * runs the other way, and exists for the not-worked lens on the maps page: a
 * store nobody has reached has no captured GPS by definition, and many of them
 * have no exact pin either (neither a `client_locations` relocation pin nor an
 * office pin — see migration 114). What every such record DOES carry is
 * `clients.city` / `province`.
 *
 * A city is not a point, so the answer is deliberately an AREA rather than a
 * coordinate: "this store is somewhere in Tanza" is what the record actually
 * says, where a pin would be a lie with four decimal places on it.
 *
 * The area is the town's REAL administrative boundary wherever OSM has one
 * (`polygon_geojson`) — the outline you would see drawn around Quezon City on
 * any map — with a centre-and-radius circle as the fallback for the places it
 * does not. The circle is a visibly cruder claim than the outline, which is
 * appropriate: it is what we fall back to when the true shape is unknown.
 *
 * Everything about the transport — server-side, User-Agent, one shared cache,
 * one 1 req/sec queue — is there for the reasons the reverse route documents at
 * length. Read that file first; the notes here only cover what differs.
 */

const MIN_REQUEST_GAP_MS = 1100
const NOMINATIM_TIMEOUT_MS = 5000

/**
 * Municipal boundaries do not move, so entries never expire. The cap is far
 * smaller than the reverse route's because the key space is too: this is one
 * entry per municipality the company works in, not one per captured fix.
 */
const CACHE_LIMIT = 500
const cache = new Map<string, CityPlace | null>()

/** Serialises every outbound call into one queue — see MIN_REQUEST_GAP_MS. */
let lastRequestAt = 0
let queue: Promise<unknown> = Promise.resolve()

export interface CityPlace {
  lat: number
  lng: number
  /** Half the bounding box's larger side, so the circle covers the whole town. */
  radiusMeters: number
  /** What Nominatim matched, so the UI can say which place it drew. */
  label: string
  /**
   * The municipal boundary as Leaflet-ready `[lat, lng]` rings — the outer ring
   * of each part, so an archipelagic municipality draws as its several islands.
   *
   * Absent when OSM has no boundary relation for the place, or returned only a
   * point; the caller then falls back to `radiusMeters`. Simplified server-side
   * (see SIMPLIFY_DEGREES) — a raw PH municipal boundary can run to tens of
   * thousands of vertices, which is megabytes over the wire and a map that
   * stutters on every pan.
   */
  outline?: [number, number][][]
}

/** Case- and spacing-insensitive, because "tanza,cavite" is the same town. */
function cacheKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim()
}

const EARTH_RADIUS_M = 6_371_000
const DEG = Math.PI / 180

/**
 * A radius that covers the matched place's bounding box.
 *
 * Nominatim returns `[south, north, west, east]`. Half the LARGER of the two
 * spans is used rather than an average: a circle sized to the average would cut
 * the corners off an elongated coastal municipality, and a store in the part
 * that got clipped would sit outside the very circle drawn to contain it.
 *
 * Clamped at both ends. The floor stops a place that resolves to a single node
 * (a barangay hall standing in for the town) from drawing an invisible dot; the
 * ceiling stops a bad match on a whole province from covering the map in one
 * disc and hiding every other circle under it.
 */
const MIN_RADIUS_M = 800
const MAX_RADIUS_M = 40_000

function radiusFromBoundingBox(box: [string, string, string, string], lat: number): number {
  const [south, north, west, east] = box.map(Number)
  if (![south, north, west, east].every(Number.isFinite)) return MIN_RADIUS_M

  const heightM = Math.abs(north - south) * DEG * EARTH_RADIUS_M
  const widthM = Math.abs(east - west) * DEG * EARTH_RADIUS_M * Math.cos(lat * DEG)

  const radius = Math.max(heightM, widthM) / 2
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(radius)))
}

/**
 * Douglas-Peucker tolerance in DEGREES, applied by Nominatim itself. ~0.0005° is
 * roughly 55m — far finer than the eye can tell at the zoom a whole town fits
 * on screen, and enough to cut a boundary to a few hundred points.
 */
const SIMPLIFY_DEGREES = 0.0005

/** Rings are capped so one pathological shape cannot bloat the response. */
const MAX_RINGS = 12

/** GeoJSON is [lng, lat]; Leaflet is [lat, lng]. The flip belongs on one side. */
type GeoJsonRing = [number, number][]

interface GeoJsonGeometry {
  type?: string
  coordinates?: unknown
}

interface NominatimSearchResult {
  lat?: string
  lon?: string
  display_name?: string
  boundingbox?: [string, string, string, string]
  geojson?: GeoJsonGeometry
}

function isRing(value: unknown): value is GeoJsonRing {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.every(
      point =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1])
    )
  )
}

/**
 * The OUTER ring of each part of a Polygon/MultiPolygon, flipped to [lat, lng].
 *
 * Inner rings (holes — an enclave, a lake cut out of the municipality) are
 * dropped rather than rendered: Leaflet does support them, but at the zoom a
 * whole town occupies they are a few pixels of noise, and carrying them doubles
 * the payload for a distinction nobody reading this map is making.
 *
 * Anything that is not an area (a `Point` result for a town OSM only has a node
 * for) yields nothing, and the caller falls back to the circle.
 */
function outlineFrom(geometry: GeoJsonGeometry | undefined): [number, number][][] | undefined {
  if (!geometry?.coordinates) return undefined

  const parts: GeoJsonRing[] =
    geometry.type === 'Polygon'
      ? (geometry.coordinates as unknown[]).slice(0, 1).filter(isRing)
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as unknown[])
            .map(polygon => (Array.isArray(polygon) ? polygon[0] : null))
            .filter(isRing)
        : []

  if (parts.length === 0) return undefined
  return parts.slice(0, MAX_RINGS).map(ring => ring.map(([lng, lat]) => [lat, lng] as [number, number]))
}

async function geocodeCity(query: string): Promise<CityPlace | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('q', query)
  // Every client in this system is Philippine, and the unscoped index is full of
  // collisions that would otherwise win — there is a Tanza in Cavite and a
  // Cavite City, and there are same-named towns on three other continents.
  url.searchParams.set('countrycodes', 'ph')
  url.searchParams.set('limit', '1')
  url.searchParams.set('polygon_geojson', '1')
  url.searchParams.set('polygon_threshold', String(SIMPLIFY_DEGREES))

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'OracleSalesApp-Web (oraclesalesapp-web.vercel.app)',
      'Accept-Language': 'en',
    },
    signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`)

  const body = (await response.json()) as NominatimSearchResult[]
  const hit = body[0]
  if (!hit) return null

  const lat = Number(hit.lat)
  const lng = Number(hit.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  return {
    lat,
    lng,
    // Kept even when an outline was returned: it is what the caller frames the
    // camera on, and the fallback if the outline is ever dropped downstream.
    radiusMeters: hit.boundingbox ? radiusFromBoundingBox(hit.boundingbox, lat) : MIN_RADIUS_M,
    label: hit.display_name?.trim() || query,
    outline: outlineFrom(hit.geojson),
  }
}

/** One call per MIN_REQUEST_GAP_MS across all callers — see the reverse route. */
function enqueue(query: string): Promise<CityPlace | null> {
  const result = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    return geocodeCity(query)
  })
  queue = result.catch(() => {})
  return result
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const query = (searchParams.get('q') ?? '').trim()

  // The upper bound is a guard, not a real limit: "Municipality, Province" is
  // never near it, and an unbounded string would be a free proxy for arbitrary
  // Nominatim queries.
  if (query.length < 2 || query.length > 120) {
    return NextResponse.json({ error: 'Invalid place query' }, { status: 400 })
  }

  const key = cacheKey(query)
  if (cache.has(key)) {
    return NextResponse.json({ place: cache.get(key) ?? null, cached: true })
  }

  try {
    const place = await enqueue(query)
    // A null answer is cached too: a place name Nominatim cannot resolve will
    // not resolve on a retry, and re-asking burns the rate limit.
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, place)
    return NextResponse.json({ place, cached: false })
  } catch (error) {
    // Deliberately NOT cached — a timeout or a 429 is about this moment, not
    // about this place.
    const message = error instanceof Error ? error.message : 'Geocoding failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
