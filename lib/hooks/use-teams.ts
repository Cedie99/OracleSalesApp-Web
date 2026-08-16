'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import type { Team } from '@/types'

/**
 * The real `teams` rows — the only source of team names and kinds.
 *
 * lib/teams.ts used to carry a hardcoded label map alongside the fixed UUIDs,
 * which had already drifted (it called teams 3 and 4 "RSR Team 1"/"RSR Team 2"
 * while the database had them as plain "Team 3"/"Team 4", checked 2026-07-24).
 * That map is gone as of migration 075, along with the id arrays that decided
 * which teams were sales and which were RSR; `kind` is a column now, so this
 * hook returns everything a caller needs.
 */
export function useTeams() {
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('teams')
      .select('id, name, kind, manager_id, created_at')
      .order('name')

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setTeams((data ?? []) as Team[])
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

  // Reference data, like profiles — slow lane.
  useAutoRefresh(load, { watch: [{ table: 'teams' }], intervalMs: SLOW_INTERVAL_MS })

  /** Display name for a team id, falling back to an em-dash. */
  const teamName = useCallback(
    (teamId: string | null | undefined) => teams.find(t => t.id === teamId)?.name ?? '—',
    [teams]
  )

  return { teams, loading, error, refresh, teamName }
}
