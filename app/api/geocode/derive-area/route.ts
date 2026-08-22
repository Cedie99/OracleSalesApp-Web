import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAuthorizedCronRequest } from '@/lib/cron-secret'
import { reverseGeocode, pickLocality } from '@/lib/geocode/nominatim'
import { matchPsgcLocality } from '@/lib/data/psgc-match'

export const dynamic = 'force-dynamic'
// 40 pins × ~1.1s serialized Nominatim calls ≈ 44s. Bound the function so a
// large backlog splits across passes instead of running past a timeout.
export const maxDuration = 60

/**
 * Store Locations — pin-derived municipality (STORE_LOCATIONS_CONTRACT.md
 * §visibility+autoderive, Option 3).
 *
 * A field officer drops a relocation/branch pin; the municipality label must
 * FOLLOW that pin, not the officer's typed pick (which can contradict it). The
 * contract's literal ask is a PostGIS point-in-polygon resolve_locality() inside
 * set_client_location(), but this project has no PostGIS and no PH boundary
 * dataset. So the derivation runs HERE, in the web app layer, reusing what the
 * repo already has: Nominatim reverse geocoding (lib/geocode/nominatim.ts) and
 * the bundled canonical PSGC dataset (lib/data/psgc-match.ts). The pin's
 * coordinate is reverse-geocoded to a municipality/province, canonicalised to a
 * real PSGC name (so it is comparable to the registered clients.city), and
 * written back onto client_locations.area/province. That column already rides
 * the mobile down-sync (123), so no new sync plumbing — the derived area reaches
 * every device the next pull. This is the "area confirmed after sync" behaviour
 * the contract says to accept.
 *
 * Postgres can't call Nominatim (external HTTP, and its 1 req/s limit would make
 * set_client_location() flaky), so the DB reaches this route over HTTP two ways —
 * the same webhook-plus-cron shape as the remittance-sms feature:
 *
 *  - POST — a Supabase Database Webhook on client_locations INSERT fires the
 *           derive IMMEDIATELY, so the area appears within seconds of a pin
 *           syncing.
 *  - GET  — a daily Vercel Cron (vercel.json) sweeps up anything a missed webhook
 *           left behind, and canonicalises the pre-126 rows whose area is still
 *           the officer's typed value. A webhook has no retry; the cron is the
 *           self-healing backstop.
 *
 * Both run the identical broad scan of pins with area_resolved_at IS NULL and
 * stamp that column on every attempt — so a pin Nominatim can't name is tried
 * once (not re-hammered against the rate limit), and firing early, late, or twice
 * is idempotent. That stamp is what lets the webhook and cron safely coexist.
 * A pin that fails to resolve keeps whatever area the officer typed as a fallback.
 */

/** Bounded so one pass can't outrun maxDuration; the rest wait for the next. */
const MAX_PER_PASS = 40

interface PendingPin {
  id: string
  lat: number | null
  lng: number | null
}

async function runPass(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('client_locations')
    .select('id, lat, lng')
    .is('area_resolved_at', null)
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .order('captured_at', { ascending: true })
    .limit(MAX_PER_PASS)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const pins = (data ?? []) as PendingPin[]
  let matched = 0
  let unresolved = 0

  for (const pin of pins) {
    if (pin.lat == null || pin.lng == null) continue

    let match = null
    try {
      const { address } = await reverseGeocode(pin.lat, pin.lng)
      const { municipality, province } = pickLocality(address)
      match = matchPsgcLocality(municipality, province)
    } catch {
      // A timeout or a 429 is about this moment, not this pin — leave
      // area_resolved_at NULL so the next pass retries it.
      continue
    }

    const patch: Record<string, unknown> = { area_resolved_at: new Date().toISOString() }
    if (match) {
      // Canonical PSGC name overwrites whatever the officer typed. If the pin
      // couldn't be named, the typed value is left in place as a fallback.
      patch.area = match.name
      patch.province = match.province
      matched++
    } else {
      unresolved++
    }

    const { error: updateError } = await supabase
      .from('client_locations')
      .update(patch)
      .eq('id', pin.id)

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message, matched, unresolved },
        { status: 500 },
      )
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: pins.length,
    matched,
    unresolved,
    // Signal a full batch so the caller/operator knows a backlog remains.
    more: pins.length === MAX_PER_PASS,
  })
}

/** Daily Vercel Cron backstop (vercel.json). */
export async function GET(request: Request) {
  return runPass(request)
}

/** Supabase Database Webhook on client_locations INSERT — the immediate path. */
export async function POST(request: Request) {
  return runPass(request)
}
