'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import type { ClientLocation } from '@/types'

/**
 * Every client's numbered locations (migration 113), grouped by client.
 *
 * One query for the whole table rather than one per client, for the reason
 * `loadPayments` gives in use-collection.ts: the surfaces that want these want
 * them for a whole day's list at once, and a per-row fetch would be dozens of
 * round trips to render one panel. The table is small by construction — a
 * handful of rows per customer that has ever been relocated.
 *
 * Columns are named explicitly rather than `*`; see the note in use-clients.ts.
 */

const LOCATION_COLUMNS = `
  id, client_id, seq, label, lat, lng, is_current, source,
  set_by, set_by_name, captured_at, created_at, updated_at
`

/** NUMERIC arrives as a JSON string sometimes — coerce at the boundary (see use-collection.ts). */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

export interface UseClientLocationsResult {
  /** Locations by `client_id`, each list ordered by `seq`. */
  byClient: Map<string, ClientLocation[]>
  loading: boolean
}

export function useClientLocations(): UseClientLocationsResult {
  const [byClient, setByClient] = useState<Map<string, ClientLocation[]>>(new Map())
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('client_locations')
      .select(LOCATION_COLUMNS)
      .order('seq', { ascending: true })

    const next = new Map<string, ClientLocation[]>()
    // Tolerates the window before 113 is deployed — and prod, where it is not
    // yet. A missing table errors the select, and an empty map then reads as
    // "no client has a recorded location", which is both true there and exactly
    // what the pre-113 world looked like. Same deploy-order-proofing as
    // loadPayments in use-collection.ts.
    if (!error && data) {
      for (const raw of data as Record<string, unknown>[]) {
        const row = { ...(raw as unknown as ClientLocation), lat: num(raw.lat), lng: num(raw.lng) }
        const list = next.get(row.client_id)
        if (list) list.push(row)
        else next.set(row.client_id, [row])
      }
    }
    setByClient(next)
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // A location set from the field must reach the admin board without a reload —
  // that is the whole point of 113 being a server table rather than device
  // state. Same cadence as the C&D boards it sits beside.
  useAutoRefresh(load, {
    watch: [{ table: 'client_locations' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  return { byClient, loading }
}
