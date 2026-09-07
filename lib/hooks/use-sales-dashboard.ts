'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { CustomerType, Meeting, MeetingOutcome } from '@/types'

/**
 * The Sales dashboard's numbers, computed by Postgres.
 *
 * The page showed roughly thirty figures — metric cards, a twelve-month trend,
 * a per-agent table, five recent meetings — and got them by downloading every
 * meeting in the company and counting in JavaScript. All of it is a COUNT or a
 * GROUP BY, so all of it moves to `get_sales_dashboard()` (migration 134).
 *
 * `profiles` and `teams` are still read client-side for the pickers. They are
 * reference data, bounded by headcount, and already shared through the resource
 * cache — so they cost nothing per navigation.
 */

/** Roles that appear in the Agent Performance table. */
export const FIELD_AGENT_ROLES = ['sales_specialist', 'rsr'] as const

export interface AgentPerformanceRow {
  agentId: string
  agentName: string
  agentRole: string
  teamId: string | null
  total: number
  successful: number
  followUp: number
  noDecision: number
  lost: number
  /** Integer percent; 0 for an agent with no meetings. */
  rate: number
}

export interface MonthlyTrendPoint {
  /** ISO timestamp of the month start. Formatted by the caller. */
  monthStart: string
  total: number
  successful: number
}

type ByType = Record<CustomerType, number>

export interface SalesDashboardData {
  metrics: {
    monthTotal: number
    closedDeals: number
    pending: number
    byType: ByType
    successfulByType: ByType
    outcomes: Record<MeetingOutcome, number>
  }
  monthlyTrend: MonthlyTrendPoint[]
  agentPerformance: AgentPerformanceRow[]
  recentMeetings: Meeting[]
}

const EMPTY_BY_TYPE: ByType = { existing: 0, new: 0, in_progress: 0, prospect: 0 }

export const EMPTY_SALES_DASHBOARD: SalesDashboardData = {
  metrics: {
    monthTotal: 0,
    closedDeals: 0,
    pending: 0,
    byType: EMPTY_BY_TYPE,
    successfulByType: EMPTY_BY_TYPE,
    outcomes: { successful: 0, follow_up: 0, no_decision: 0, lost_opportunity: 0 },
  },
  monthlyTrend: [],
  agentPerformance: [],
  recentMeetings: [],
}

/**
 * The browser's IANA zone, sent with every call.
 *
 * Load-bearing, not incidental. The component bucketed months with date-fns'
 * `isSameMonth`, which resolves in local time; a bare `date_trunc` in Postgres
 * resolves in UTC. At UTC+8 that moves every meeting logged after 16:00 UTC on
 * the last day of a month into the next one, and the card would disagree with
 * the Meetings page for no visible reason. Passing the zone keeps the boundary
 * where the reader expects it.
 */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface SalesDashboardFilters {
  /** null = all teams. */
  teamId: string | null
  /** null = all agents. Applies to the Agent Performance table only. */
  agentId: string | null
  /** Resolved window for the performance table; null means all time. */
  range: { start: Date; end: Date } | null
}

export function useSalesDashboard(filters: SalesDashboardFilters) {
  const args = {
    p_team_id: filters.teamId,
    p_agent_id: filters.agentId,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
    p_tz: browserTimeZone(),
    p_agent_roles: [...FIELD_AGENT_ROLES],
  }

  const key = `sales-dashboard:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<SalesDashboardData>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_sales_dashboard', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_SALES_DASHBOARD) as SalesDashboardData
    },
    EMPTY_SALES_DASHBOARD,
  )

  // `client_edit_requests` is watched alongside `meetings` because the Pending
  // Approvals card moves when a request is filed or decided, which never
  // touches the meetings table.
  useAutoRefresh(reload, {
    watch: [{ table: 'meetings' }, { table: 'client_edit_requests' }],
  })

  return { data, loading, error, refresh, reload }
}
