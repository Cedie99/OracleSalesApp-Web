'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTagAlongs } from '@/lib/tag-along/actions'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { tagAlongsByClient, tagAlongsByInvitee, tagAlongsByMeeting } from '@/lib/tag-along'
import type { TagAlongRequest } from '@/types'

interface UseTagAlongsResult {
  requests: TagAlongRequest[]
  /** meeting_id -> its requests. Empty lookup for a meeting with no companions. */
  byMeeting: Map<string, TagAlongRequest[]>
  /** client_id -> its requests, across both contexts. */
  byClient: Map<string, TagAlongRequest[]>
  /** invitee profile id -> what was asked of them. */
  byInvitee: Map<string, TagAlongRequest[]>
  loading: boolean
  error: string
  refresh: () => Promise<void>
}

const EMPTY: TagAlongRequest[] = []

/**
 * Every tag-along request, shaped for lookup.
 *
 * Unlike the other hooks in this folder this one does not talk to Supabase from
 * the browser — it calls a Server Function, because RLS hides this table from
 * admins entirely. See the header of lib/tag-along/actions.ts.
 *
 * The three maps are memoised off one fetch rather than exposed as three hooks,
 * so a page showing companions on both a list and a detail panel pays for the
 * read once.
 */
export function useTagAlongs(): UseTagAlongsResult {
  const [requests, setRequests] = useState<TagAlongRequest[]>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const { requests: rows, error: fetchError } = await fetchTagAlongs()
    if (fetchError) {
      setError(fetchError)
      setRequests(EMPTY)
    } else {
      setError('')
      setRequests(rows)
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

  // No `watch` here, and it must stay that way: RLS hides `tag_along_requests`
  // from admins entirely (which is why this hook goes through a Server Function
  // at all), so a probe from the browser would count zero rows forever and
  // cheerfully report "nothing has changed" until the end of time. Unprobed
  // means every tick is a real fetch, so it runs on the slow lane — the
  // refresh-on-return-to-tab path is what makes this feel current in practice.
  useAutoRefresh(load, { intervalMs: SLOW_INTERVAL_MS })

  const byMeeting = useMemo(() => tagAlongsByMeeting(requests), [requests])
  const byClient = useMemo(() => tagAlongsByClient(requests), [requests])
  const byInvitee = useMemo(() => tagAlongsByInvitee(requests), [requests])

  return { requests, byMeeting, byClient, byInvitee, loading, error, refresh }
}

/** Convenience for a single record: its requests, or an empty list. */
export function tagAlongsFor(
  map: Map<string, TagAlongRequest[]>,
  id: string | null | undefined
): TagAlongRequest[] {
  return (id && map.get(id)) || EMPTY
}
