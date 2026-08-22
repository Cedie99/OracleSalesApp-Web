'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'

/**
 * ONE client's numbered field pins, read through the get_client_locations()
 * SECURITY DEFINER RPC (migration 126) — the Store Locations Option 2 read path
 * for NON-field roles (STORE_LOCATIONS_CONTRACT.md §visibility+autoderive).
 *
 * Distinct from use-client-locations.ts, which does a whole-table direct SELECT
 * for the admin C&D boards. That select returns nothing for a sales/RSR web user
 * because migration 113's RLS keeps client_locations field-role-only; this hook
 * goes through the DEFINER RPC granted to sales/RSR/admin instead, and returns
 * the extra area/province/kind columns (123) the boards hook doesn't carry:
 *
 *  - `current`   — the store's current field pin (relocation, is_current),
 *                  carrying the DERIVED field municipality (area/province, 126).
 *  - `branches`  — additional_branch pins flagged for admin/sales triage.
 *  - `pins`      — the full numbered list (seq ASC).
 *
 * Per-client (not batch) because the surfaces that want the rich area/branch
 * detail show one store at a time (the client detail dialog).
 */
export interface ClientFieldPin {
  id: string
  seq: number
  label: string | null
  lat: number
  lng: number
  isCurrent: boolean
  kind: 'relocation' | 'additional_branch' | string
  /** Field-observed municipality, derived from the pin (126). Null until derived. */
  area: string | null
  province: string | null
  setByName: string | null
  capturedAt: string | null
}

interface RawRow {
  id: string
  seq: number
  label: string | null
  lat: number | string
  lng: number | string
  is_current: boolean
  kind: string
  area: string | null
  province: string | null
  set_by_name: string | null
  captured_at: string | null
}

export interface UseClientFieldLocationsResult {
  pins: ClientFieldPin[]
  current: ClientFieldPin | null
  branches: ClientFieldPin[]
  loading: boolean
  error: string
}

const EMPTY: ClientFieldPin[] = []

/** NUMERIC can arrive as a JSON string — coerce at the boundary (see use-collection.ts). */
function num(value: number | string): number {
  return typeof value === 'number' ? value : Number(value)
}

export function useClientFieldLocations(
  clientId: string | null | undefined,
): UseClientFieldLocationsResult {
  const [pins, setPins] = useState<ClientFieldPin[]>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!clientId) {
      setPins(EMPTY)
      setError('')
      setLoading(false)
      return
    }
    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('get_client_locations', {
      p_client_id: clientId,
    })

    if (rpcError) {
      // PGRST202 = the function isn't deployed yet. Degrade to "no field pins"
      // rather than erroring, so the UI can merge before/after migration 126.
      if (rpcError.code === 'PGRST202') {
        setPins(EMPTY)
        setError('')
        setLoading(false)
        return
      }
      setError(rpcError.message)
      setLoading(false)
      return
    }

    const rows = (data ?? []) as RawRow[]
    setPins(
      rows.map(r => ({
        id: r.id,
        seq: r.seq,
        label: r.label,
        lat: num(r.lat),
        lng: num(r.lng),
        isCurrent: r.is_current,
        kind: r.kind,
        area: r.area,
        province: r.province,
        setByName: r.set_by_name,
        capturedAt: r.captured_at,
      })),
    )
    setError('')
    setLoading(false)
  }, [clientId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  // A field officer setting a pin, or the derive pass filling in the area, should
  // surface here without a reload — same cadence as the store-location surfaces.
  useAutoRefresh(load, {
    watch: [{ table: 'client_locations' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  const current = pins.find(p => p.isCurrent && p.kind !== 'additional_branch') ?? null
  const branches = pins.filter(p => p.kind === 'additional_branch')

  return { pins, current, branches, loading, error }
}
