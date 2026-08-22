/**
 * Shared Nominatim (OpenStreetMap) reverse-geocoding — the single place the web
 * app talks to nominatim.openstreetmap.org.
 *
 * There are TWO callers now:
 *   - app/api/geocode/reverse   — an admin opening a map, wanting a human
 *     "Barangay, Municipality, Province" caption for a captured GPS pin.
 *   - app/api/geocode/derive-area — the Store Locations derive pass, wanting the
 *     municipality/province of a field pin to canonicalise against PSGC.
 *
 * Both MUST share one rate limiter. Nominatim's usage policy is max 1 request per
 * second, and a blocked IP is blocked for the WHOLE deployment — so two
 * independent throttles could together earn a ban that takes out both features.
 * This module owns the single serialized queue every caller funnels through.
 */

/**
 * Nominatim policy: max 1 request/second; a blocked IP is blocked for the whole
 * deployment. 1100ms leaves room for clock jitter.
 */
const MIN_REQUEST_GAP_MS = 1100
const NOMINATIM_TIMEOUT_MS = 5000

export interface NominatimAddress {
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

export interface ReverseResult {
  address: NominatimAddress | undefined
  displayName: string | undefined
}

/** Serialises every outbound call into one queue — see MIN_REQUEST_GAP_MS. */
let lastRequestAt = 0
let queue: Promise<unknown> = Promise.resolve()

async function callNominatim(lat: number, lng: number): Promise<ReverseResult> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lng))
  // Barangay level. Higher zooms return a building or road, which is noise for
  // both callers and is often just missing in PH data. The full address
  // hierarchy (city/state) is returned regardless of zoom via addressdetails.
  url.searchParams.set('zoom', '14')
  url.searchParams.set('addressdetails', '1')

  const response = await fetch(url, {
    headers: {
      // Required by Nominatim's usage policy.
      'User-Agent': 'OracleSalesApp-Web (oraclesalesapp-web.vercel.app)',
      'Accept-Language': 'en',
    },
    signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`)

  const body = (await response.json()) as { address?: NominatimAddress; display_name?: string }
  return { address: body.address, displayName: body.display_name }
}

/**
 * Reverse-geocode one coordinate, at most once per MIN_REQUEST_GAP_MS across ALL
 * callers, by chaining onto a single shared promise. Concurrent requests wait
 * their turn rather than being rejected.
 */
export function reverseGeocode(lat: number, lng: number): Promise<ReverseResult> {
  const result = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    return callNominatim(lat, lng)
  })
  // The queue must keep draining even when a link rejects, so the chain swallows
  // the failure. `result` still carries it to the caller.
  queue = result.catch(() => {})
  return result
}

/**
 * "Barangay, Municipality, Province" — how a Filipino reads a location out loud.
 * PH results put the province in `state` and the region ("Central Luzon") in
 * `region`. The barangay arrives under `village`/`hamlet`/`suburb` and the
 * municipality under `city`/`town`/`municipality` depending on the place — hence
 * the fallback chains. Duplicates are dropped because a chartered city can repeat
 * across two slots.
 */
export function formatPlace(address: NominatimAddress | undefined, displayName?: string): string | null {
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
  return displayName?.trim() || address.country?.trim() || null
}

/**
 * The two administrative fields the Store Locations derive pass needs: the
 * municipality/city and the province, before canonicalisation against PSGC. Same
 * fallback chains as formatPlace, but returned structured rather than joined.
 */
export function pickLocality(address: NominatimAddress | undefined): {
  municipality: string | null
  province: string | null
} {
  if (!address) return { municipality: null, province: null }
  const municipality =
    address.city || address.town || address.municipality || address.county || null
  const province = address.state || null
  return {
    municipality: municipality?.trim() || null,
    province: province?.trim() || null,
  }
}
