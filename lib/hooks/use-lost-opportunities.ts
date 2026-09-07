'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { Client } from '@/types'

/**
 * The Lost Opportunities page, paged in Postgres.
 *
 * The page read every client and every meeting in the company, filtered to
 * `status = 'lost'`, and rendered nine cards — a 3.5 MB download to display
 * eleven rows on production. `get_lost_opportunities()` (migration 139) does
 * the filtering and returns only the window.
 */

export interface LostOpportunityRow {
  client: Client
  /**
   * Remarks from the meeting that did the losing, when there was one. The page
   * prefers `client.inactive_reason` over this — see the migration header for
   * why that precedence is the right way round.
   */
  lostMeetingRemarks: string | null
}

export interface LostOpportunityFeed {
  rows: LostOpportunityRow[]
  /** Rows behind the current filters. */
  total: number
  /** Every lost client, ignoring the filters — the header's second number. */
  lostTotal: number
}

export const LOST_PAGE_SIZE = 9

export const EMPTY_LOST_FEED: LostOpportunityFeed = { rows: [], total: 0, lostTotal: 0 }

export interface LostOpportunityFilters {
  search: string
  /** 'all' | 'ready' | 'locked' */
  status: string
  range: { start: Date; end: Date } | null
}

export function useLostOpportunities(
  filters: LostOpportunityFilters,
  page: number,
  pageSize = LOST_PAGE_SIZE,
) {
  const args = {
    p_search: filters.search.trim() || null,
    p_status: filters.status,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  }

  const key = `lost-opportunities:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<LostOpportunityFeed>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_lost_opportunities', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_LOST_FEED) as LostOpportunityFeed
    },
    EMPTY_LOST_FEED,
  )

  // A client becoming lost is a `clients` write; the reason can also arrive on
  // a meeting marked lost_opportunity, which is why both are watched.
  useAutoRefresh(reload, { watch: [{ table: 'clients' }, { table: 'meetings' }] })

  return { feed: data, loading, error, refresh, reload }
}
