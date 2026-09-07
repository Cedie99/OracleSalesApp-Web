'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { Client, Meeting } from '@/types'

/**
 * The Sales map's Visited lens, from the server.
 *
 * Opening Maps used to download every client and every meeting in the company
 * to draw about twenty pins. The map was never the problem: the default view is
 * ONE DAY's visits, and a pin is a client plotted at their most recent located
 * visit within the active filters. `get_sales_map_visited()` (migration 138)
 * decides which handful qualify and returns only those, with their records.
 *
 * The Needs Attention lens is NOT here. Its signals rest on quota usage folded
 * from the cutoff attribution ledger, which is deferred — so that lens keeps
 * its client-side data and loads it only when someone opens the tab.
 */

export interface VisitedRow {
  client: Client
  /** Meetings in the date window for this client, newest first. */
  meetings: Meeting[]
  /** Id of the meeting the pin sits on; null when none of them carry a fix. */
  plotMeetingId: string | null
  lastVisit: string | null
  /** True when the scoped agent reached this account by tagging along. */
  viaTagAlong: boolean
}

export interface SalesMapFilters {
  /** Null when the box holds a raw lat/lng — that is a "go here", not a filter. */
  search: string | null
  /** 'all' | MapStatus */
  status: string
  /** 'all' | team id */
  teamId: string
  /** 'all' | 'unassigned' | agent id */
  agentId: string
  /** 'all' | 'f2f' | 'online' */
  type: string
  range: { start: Date; end: Date } | null
}

const EMPTY: VisitedRow[] = []

export function useSalesMapVisited(filters: SalesMapFilters) {
  const args = {
    p_search: filters.search?.trim() || null,
    p_status: filters.status,
    p_team_id: filters.teamId === 'all' ? null : filters.teamId,
    p_agent_id:
      filters.agentId === 'all' || filters.agentId === 'unassigned' ? null : filters.agentId,
    p_unassigned: filters.agentId === 'unassigned',
    p_type: filters.type,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
  }

  const key = `sales-map-visited:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<VisitedRow[]>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_sales_map_visited', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY) as VisitedRow[]
    },
    EMPTY,
  )

  useAutoRefresh(reload, { watch: [{ table: 'meetings' }, { table: 'clients' }] })

  return { visited: data, loading, error, refresh, reload }
}
