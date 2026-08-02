'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Team } from '@/types'

/**
 * The real `teams` rows.
 *
 * Prefer this over `TEAM_LABELS` in lib/teams.ts, which hardcodes names that
 * have already drifted: it calls teams 3 and 4 "RSR Team 1" / "RSR Team 2",
 * while the database has them as plain "Team 3" / "Team 4" (checked
 * 2026-07-24). The fixed UUIDs in lib/teams.ts are still correct and still
 * useful for `teamIdsForRole`; only the display names are stale.
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
      .select('id, name, manager_id, created_at')
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

  /** Display name for a team id, falling back to an em-dash. */
  const teamName = useCallback(
    (teamId: string | null | undefined) => teams.find(t => t.id === teamId)?.name ?? '—',
    [teams]
  )

  return { teams, loading, error, refresh, teamName }
}
