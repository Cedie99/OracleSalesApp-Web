'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import type { Profile, UserRole } from '@/types'

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
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('profiles')
      .select('id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at')
      .order('full_name')

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setProfiles((data ?? []) as Profile[])
    }
    setLoading(false)
  }, [])

  /** Re-fetch and show the spinner. Safe from event handlers, not from effects. */
  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // People and their roles change on the scale of weeks, and this list is
  // mounted almost everywhere as a lookup for names — so it takes the slow lane.
  // The probe still catches a deactivation the same tick it happens.
  useAutoRefresh(load, { watch: [{ table: 'profiles' }], intervalMs: SLOW_INTERVAL_MS })

  /** Active profiles holding any of the given roles. */
  const byRole = useCallback(
    (roles: UserRole[] | string[]) =>
      profiles.filter(p => p.is_active !== false && (roles as string[]).includes(p.role)),
    [profiles]
  )

  return { profiles, loading, error, refresh, byRole }
}
