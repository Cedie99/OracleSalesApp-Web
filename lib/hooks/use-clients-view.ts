'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import { QUALIFIED_AGENDA_MILESTONES } from '@/lib/client-progress'
import type { Client } from '@/types'

/**
 * The Clients page's two reads, both bounded.
 *
 * This replaces `useClients()` (every client, paged through in full) plus the
 * `useMeetings()` and `useTagAlongs()` calls the page mounted alongside it. The
 * page rendered nine cards and downloaded three whole tables to do it, because
 * the manager/agent bucket counts are aggregates over the entire filtered set.
 * Those aggregates are now `get_clients_overview()` (migration 131) and the
 * nine cards are `get_clients_page()`, so the page's cost no longer scales with
 * the table.
 *
 * The two are separate hooks on purpose: paging through an agent's clients
 * re-reads only the window, leaving the hierarchy above it untouched.
 */

export interface ClientStats {
  total: number
  existing: number
  new: number
  inProgress: number
  prospect: number
  active: number
  lost: number
}

export interface ManagerBucket {
  key: string
  label: string
  agentCount: number
  clientCount: number
  ownClientCount: number
  tagAlongCount: number
  managerClientCount: number
  stats: ClientStats
}

export interface AgentGroup {
  agentId: string
  agentName: string
  managerKey: string
  clientCount: number
}

export interface ClientsOverview {
  /** Every visible client, ignoring the filters — the default stat row. */
  stats: ClientStats
  filteredTotal: number
  visibleTotal: number
  managers: ManagerBucket[]
  agents: AgentGroup[]
}

/** A client row as the page renders it, with its progress ring precomputed. */
export interface ClientRow extends Client {
  progressPercent: number
}

export interface ClientsFilters {
  search: string
  type: string
  channel: string
  status: string
  source: string
}

export type ClientScope =
  | { kind: 'agent'; id: string }
  | { kind: 'manager'; id: string }
  | null

/** Nine cards per page, matching the grid the drill-down renders. */
export const CLIENTS_PAGE_SIZE = 9

export const EMPTY_CLIENT_STATS: ClientStats = {
  total: 0, existing: 0, new: 0, inProgress: 0, prospect: 0, active: 0, lost: 0,
}

const EMPTY_STATS = EMPTY_CLIENT_STATS

const EMPTY_OVERVIEW: ClientsOverview = {
  stats: EMPTY_STATS,
  filteredTotal: 0,
  visibleTotal: 0,
  managers: [],
  agents: [],
}

/**
 * Filters go into the cache key, so switching a dropdown back to a value you
 * used a moment ago renders instantly from cache rather than re-querying.
 */
function filterArgs(filters: ClientsFilters) {
  return {
    p_search: filters.search.trim() || null,
    p_type: filters.type,
    p_channel: filters.channel,
    p_status: filters.status,
    p_source: filters.source,
  }
}

/** The hierarchy: manager buckets, the agents under them, and every count. */
export function useClientsOverview(filters: ClientsFilters) {
  const args = filterArgs(filters)
  const key = `clients-overview:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<ClientsOverview>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_clients_overview', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_OVERVIEW) as ClientsOverview
    },
    EMPTY_OVERVIEW,
  )

  // The probe is what keeps the background refresh affordable: the RPC walks
  // clients, meetings and the tag-along ledger, so it should only re-run when
  // one of them has genuinely moved. `meetings` is watched because a meeting
  // logged on mobile changes a manager's own-client count without touching the
  // clients table at all.
  useAutoRefresh(reload, { watch: [{ table: 'clients' }, { table: 'meetings' }] })

  return { overview: data, loading, error, refresh, reload }
}

/**
 * One screen of client rows for the drilled-into agent or manager.
 *
 * Disabled (and never queried) while nothing is selected — the page shows the
 * hierarchy then, not a table.
 */
export function useClientsPage(
  filters: ClientsFilters,
  scope: ClientScope,
  page: number,
  pageSize = CLIENTS_PAGE_SIZE,
) {
  // Not memoised, and it does not need to be: `args` is only read to build the
  // cache key and inside the loader, which useCachedResource reaches through a
  // ref. The one value that must be stable across renders is `key`, and that is
  // a string.
  const args = {
    ...filterArgs(filters),
    p_scope_kind: scope?.kind ?? 'agent',
    p_scope_id: scope?.id ?? null,
    // Passed in rather than hardcoded in SQL so lib/client-progress.ts stays
    // the single source of truth for what a milestone is. See the note on
    // get_clients_page() in migration 131.
    p_milestones: [...QUALIFIED_AGENDA_MILESTONES],
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  }

  const key = scope ? `clients-page:${JSON.stringify(args)}` : 'clients-page:none'

  const { data, loading, error, reload, refresh } = useCachedResource<{
    rows: ClientRow[]
    total: number
    stats: ClientStats
  }>(
    key,
    async () => {
      if (!scope) return { rows: [], total: 0, stats: EMPTY_STATS }
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_clients_page', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? { rows: [], total: 0, stats: EMPTY_STATS }) as {
        rows: ClientRow[]
        total: number
        stats: ClientStats
      }
    },
    { rows: [], total: 0, stats: EMPTY_STATS },
  )

  useAutoRefresh(reload, {
    watch: [{ table: 'clients' }, { table: 'meetings' }],
    enabled: !!scope,
  })

  return {
    rows: data.rows,
    total: data.total,
    stats: data.stats,
    loading: scope ? loading : false,
    error,
    refresh,
    reload,
  }
}
