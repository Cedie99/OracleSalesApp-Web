'use client'

import { useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { Profile, UserRole } from '@/types'

/** Stable identity, so the fallback never re-triggers a downstream useMemo. */
const EMPTY: Profile[] = []

/**
 * All profiles, for the agent pickers on the Clients and Reports pages.
 *
 * Filtering by role happens in the caller rather than in the query: the role
 * column is shared with the mobile repo and already contains values this build
 * doesn't model (an `executive` row landed on 2026-07-24), so a server-side
 * `.in('role', [...])` would silently drop people the moment mobile renames a
 * role. Fetching everyone and narrowing locally keeps that visible.
 */
export function useProfiles() {
  /**
   * Cached across mounts. This list is mounted by nearly every page — as the
   * agent picker, as the name lookup behind a team column — and before the
   * cache each of those navigations re-read the whole profiles table to render
   * names it had already fetched a moment earlier.
   */
  const { data: profiles, loading, error, reload, refresh } = useCachedResource<Profile[]>(
    'profiles',
    async () => {
      const supabase = createClient()
      const { data, error: queryError } = await supabase
        .from('profiles')
        .select('id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at')
        .order('full_name')

      if (queryError) throw new Error(queryError.message)
      return (data ?? []) as Profile[]
    },
    EMPTY,
  )

  // People and their roles change on the scale of weeks, and this list is
  // mounted almost everywhere as a lookup for names — so it takes the slow lane.
  // The probe still catches a deactivation the same tick it happens.
  useAutoRefresh(reload, { watch: [{ table: 'profiles' }], intervalMs: SLOW_INTERVAL_MS })

  /** Active profiles holding any of the given roles. */
  const byRole = useCallback(
    (roles: UserRole[] | string[]) =>
      profiles.filter(p => p.is_active !== false && (roles as string[]).includes(p.role)),
    [profiles]
  )

  return { profiles, loading, error, refresh, byRole }
}
