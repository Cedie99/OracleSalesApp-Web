'use client'

import { useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { Team } from '@/types'

/** Stable identity, so the fallback never re-triggers a downstream useMemo. */
const EMPTY: Team[] = []

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
  // Cached across mounts — see the note in use-profiles.ts. Teams are the
  // smallest and least volatile set the app reads, and one of the most often
  // re-read: every page that groups anything by team mounts this.
  const { data: teams, loading, error, reload, refresh } = useCachedResource<Team[]>(
    'teams',
    async () => {
      const supabase = createClient()
      const { data, error: queryError } = await supabase
        .from('teams')
        .select('id, name, kind, manager_id, created_at')
        .order('name')

      if (queryError) throw new Error(queryError.message)
      return (data ?? []) as Team[]
    },
    EMPTY,
  )

  // Reference data, like profiles — slow lane.
  useAutoRefresh(reload, { watch: [{ table: 'teams' }], intervalMs: SLOW_INTERVAL_MS })

  /** Display name for a team id, falling back to an em-dash. */
  const teamName = useCallback(
    (teamId: string | null | undefined) => teams.find(t => t.id === teamId)?.name ?? '—',
    [teams]
  )

  return { teams, loading, error, refresh, teamName }
}
