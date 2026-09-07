'use client'

import { useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import { tagAlongsByMeeting } from '@/lib/tag-along'
import type {
  Client, MeetingCutoffAttribution, TagAlongRequest,
} from '@/types'

/**
 * The slice of data one cutoff period touches.
 *
 * The quota report used to mount four whole-table reads — clients, meetings,
 * the tag-along ledger and the entire attribution table — even though it only
 * ever renders ONE period, which it knows before it needs any of them.
 * `get_cutoff_quota_data()` (migration 141) returns exactly that period's slice.
 *
 * The arithmetic is untouched and stays in lib/cutoff.ts. This changes what is
 * fetched, not how the quota is computed — see the migration header for why
 * that line is drawn there.
 */

/** Only the meeting columns the report reads. Not a whole `Meeting`. */
export interface QuotaMeeting {
  id: string
  meeting_date: string
  outcome: string
  photo_url: string | null
  end_photo_url: string | null
  start_captured_at: string | null
  client_status_at_meeting: string | null
}

export interface CutoffQuotaData {
  attributions: MeetingCutoffAttribution[]
  meetings: QuotaMeeting[]
  /** Only `id`, `company_name` and the agent — what the export names. */
  clients: Client[]
  tagAlongs: TagAlongRequest[]
  unattributedMeetingCount: number
}

export const EMPTY_CUTOFF_QUOTA_DATA: CutoffQuotaData = {
  attributions: [],
  meetings: [],
  clients: [],
  tagAlongs: [],
  unattributedMeetingCount: 0,
}

export function useCutoffQuotaData(periodId: string | null) {
  const key = periodId ? `cutoff-quota-data:${periodId}` : 'cutoff-quota-data:none'

  const { data, loading, error, reload, refresh } = useCachedResource<CutoffQuotaData>(
    key,
    async () => {
      if (!periodId) return EMPTY_CUTOFF_QUOTA_DATA
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_cutoff_quota_data', { p_period_id: periodId })
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_CUTOFF_QUOTA_DATA) as CutoffQuotaData
    },
    EMPTY_CUTOFF_QUOTA_DATA,
  )

  // A closed cutoff does not move, and a live one moves on the scale of a
  // meeting being logged — slow lane. `meetings` is watched beside the ledger
  // because the unattributed count is `meetings - ledger`: a meeting logged but
  // not yet attributed moves the number without touching the ledger at all.
  useAutoRefresh(reload, {
    watch: [
      { table: 'meeting_cutoff_attributions', column: 'attributed_at' },
      { table: 'meetings' },
    ],
    intervalMs: SLOW_INTERVAL_MS,
    enabled: !!periodId,
  })

  // Shaped the way the report already consumes companions, so the component's
  // own logic is untouched.
  const byMeeting = useMemo(() => tagAlongsByMeeting(data.tagAlongs), [data.tagAlongs])

  return {
    data,
    tagAlongsByMeeting: byMeeting,
    loading: periodId ? loading : false,
    error,
    refresh,
    reload,
  }
}
