'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ClockRecord, Profile } from '@/types'

/** Explicit column list — see the note in use-clients.ts for why not `*`. */
const CLOCK_RECORD_COLUMNS = `
  id, agent_id, type, action, gps_lat, gps_lng, photo_url, event_name,
  timestamp, created_at,
  agent:profiles!agent_id ( id, user_id, full_name, role, team_id, avatar_url, created_at )
`

const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

/**
 * Clock in/out records.
 *
 * The table is real but currently empty (0 rows as of 2026-07-24) — mobile has
 * not shipped the clock screens. An empty page here is the true state, not a
 * wiring failure. Per [[project-clock-records-priority]] this surface was never
 * a supervisor requirement, so it is not worth blocking anything on.
 */
export function useClockRecords() {
  const [records, setRecords] = useState<ClockRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('clock_records')
      .select(CLOCK_RECORD_COLUMNS)
      .order('timestamp', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setRecords(
        (data ?? []).map(row => {
          const r = row as Record<string, unknown>
          return { ...(r as unknown as ClockRecord), agent: one<Profile>(r.agent) }
        })
      )
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { records, loading, error, refresh }
}
