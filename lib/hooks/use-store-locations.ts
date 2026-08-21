'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import type { OfficePinSource } from '@/types'

/**
 * A store has TWO locations, and the product deliberately keeps them apart:
 *
 *  - `registered` — the client's permanent office pin (clients.office_lat/lng,
 *    migration 052), set by a sales agent / RSR. This is the "where the store
 *    is on paper" location.
 *  - `updated` — the CURRENT pin a Collection/Delivery officer set on the ground
 *    (client_locations.is_current, migration 113) because the store had
 *    relocated. Null when nobody has ever set one.
 *
 * migration 114's denormalized `client_lat`/`client_lng` on visits/POs collapse
 * these two into one COALESCE'd value for the phone's map; this hook keeps them
 * SEPARATE so every web surface can show both, which is the whole requirement.
 */
export interface StorePin {
  lat: number
  lng: number
}

export interface RegisteredLocation extends StorePin {
  source: OfficePinSource | null
  updatedAt: string | null
}

export interface UpdatedLocation extends StorePin {
  label: string | null
  /** Denormalized name of the officer who set it, for display (client_locations.set_by_name). */
  setByName: string | null
  capturedAt: string | null
}

export interface StoreLocation {
  registered: RegisteredLocation | null
  updated: UpdatedLocation | null
}

const EMPTY: StoreLocation = { registered: null, updated: null }

/** Great-circle metres between two pins — for the "moved ~N" hint. */
export function metresBetween(a: StorePin, b: StorePin): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

interface UseStoreLocationsResult {
  /** Keyed by client_id. A client with no pins at all is simply absent. */
  locations: Map<string, StoreLocation>
  loading: boolean
  error: string
  /** The two locations for one client, or an all-null placeholder when unknown. */
  get: (clientId: string | null | undefined) => StoreLocation
}

/**
 * Batch-reads both locations for a set of clients, in two queries (office pins
 * from `clients`, current field pins from `client_locations`). One hook serves
 * every store-appearing surface: a page collects the client ids it is showing
 * and passes them in. Re-runs live via useAutoRefresh so a field officer's new
 * pin appears on the admin's screen without a reload.
 *
 * Web admin RLS (migration 113 + the clients policies) permits reading both
 * tables, so no per-page scoping is needed here.
 */
export function useStoreLocations(clientIds: (string | null | undefined)[]): UseStoreLocationsResult {
  const [locations, setLocations] = useState<Map<string, StoreLocation>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // A stable, de-duplicated key so the effect doesn't refire on every render
  // when a parent passes a freshly-built array of the same ids.
  const ids = useMemo(
    () => Array.from(new Set(clientIds.filter((id): id is string => !!id))).sort(),
    [clientIds],
  )
  const idsKey = ids.join(',')

  const load = useCallback(async () => {
    if (ids.length === 0) {
      setLocations(new Map())
      setError('')
      setLoading(false)
      return
    }
    const supabase = createClient()

    const [officeRes, fieldRes] = await Promise.all([
      supabase
        .from('clients')
        .select('id, office_lat, office_lng, office_pin_source, office_pin_updated_at')
        .in('id', ids),
      supabase
        .from('client_locations')
        .select('client_id, lat, lng, label, set_by_name, captured_at')
        .in('client_id', ids)
        .eq('is_current', true),
    ])

    if (officeRes.error || fieldRes.error) {
      setError(officeRes.error?.message ?? fieldRes.error?.message ?? 'Could not load store locations.')
      setLoading(false)
      return
    }

    const next = new Map<string, StoreLocation>()
    const ensure = (id: string) => {
      const existing = next.get(id)
      if (existing) return existing
      const fresh: StoreLocation = { registered: null, updated: null }
      next.set(id, fresh)
      return fresh
    }

    for (const row of officeRes.data ?? []) {
      const lat = row.office_lat as number | null
      const lng = row.office_lng as number | null
      if (lat == null || lng == null) continue
      ensure(row.id as string).registered = {
        lat,
        lng,
        source: (row.office_pin_source as OfficePinSource | null) ?? null,
        updatedAt: (row.office_pin_updated_at as string | null) ?? null,
      }
    }

    for (const row of fieldRes.data ?? []) {
      const lat = row.lat as number | null
      const lng = row.lng as number | null
      if (lat == null || lng == null) continue
      ensure(row.client_id as string).updated = {
        lat,
        lng,
        label: (row.label as string | null) ?? null,
        setByName: (row.set_by_name as string | null) ?? null,
        capturedAt: (row.captured_at as string | null) ?? null,
      }
    }

    setLocations(next)
    setError('')
    setLoading(false)
  }, [ids])

  useEffect(() => {
    // load() only setStates after its await (empty-ids branch aside); the rule
    // can't see through the useCallback to prove that — same suppression as
    // use-clients. idsKey stands in for the `ids` array whose identity changes
    // each render but whose contents don't.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  // A field officer setting a pin, or an agent moving the office pin, should
  // surface here without a manual refresh — same cadence as the C&D boards.
  useAutoRefresh(load, {
    watch: [{ table: 'client_locations' }, { table: 'clients' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  const get = useCallback(
    (clientId: string | null | undefined): StoreLocation =>
      (clientId ? locations.get(clientId) : undefined) ?? EMPTY,
    [locations],
  )

  return { locations, loading, error, get }
}
