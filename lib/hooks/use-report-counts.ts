'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'

/**
 * The figures on the Reports cards.
 *
 * The page used to mount six full-table hooks on open, for two unrelated
 * reasons: to print these numbers, and so the Download buttons COULD work if
 * pressed. Only the first is aggregation. The counts come from
 * `get_sales_report_counts()` (migration 136); the exports fetch their rows on
 * the click instead (see lib/reports/sales-rows.ts).
 */

/** Roles the team filter resolves membership from. */
export const REPORT_AGENT_ROLES = ['sales_specialist', 'sales_manager', 'rsr'] as const

export interface SalesReportCounts {
  meetings: {
    /** Records, one per attendee — a meeting with a manager along is two. */
    count: number
    successful: number
    followUp: number
    noDecision: number
    lost: number
  }
  clients: { count: number; active: number; lost: number; prospects: number }
  clock: { count: number; office: number; event: number; clockIn: number }
}

export const EMPTY_SALES_REPORT_COUNTS: SalesReportCounts = {
  meetings: { count: 0, successful: 0, followUp: 0, noDecision: 0, lost: 0 },
  clients: { count: 0, active: 0, lost: 0, prospects: 0 },
  clock: { count: 0, office: 0, event: 0, clockIn: 0 },
}

export interface SalesReportCountFilters {
  /** 'all', or a profile id. */
  agentId: string
  /** 'all', or a team id. */
  teamId: string
  range: { start: Date; end: Date } | null
}

export function useSalesReportCounts(filters: SalesReportCountFilters) {
  const args = {
    p_agent_id: filters.agentId === 'all' ? null : filters.agentId,
    p_team_id: filters.teamId === 'all' ? null : filters.teamId,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
    p_agent_roles: [...REPORT_AGENT_ROLES],
  }

  const key = `sales-report-counts:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<SalesReportCounts>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_sales_report_counts', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_SALES_REPORT_COUNTS) as SalesReportCounts
    },
    EMPTY_SALES_REPORT_COUNTS,
  )

  // Reports are a reading surface rather than a board anyone watches move, so
  // this takes the slow lane. The probe still catches a change the same tick.
  useAutoRefresh(reload, {
    watch: [{ table: 'meetings' }, { table: 'clients' }, { table: 'clock_records' }],
    intervalMs: SLOW_INTERVAL_MS,
  })

  return { counts: data, loading, error, refresh, reload }
}


// ---------------------------------------------------------------------------
// Collection / Delivery
// ---------------------------------------------------------------------------

export interface OpsReportCountFilters {
  /** 'all', or a collector / driver profile id. */
  personId: string
  range: { start: Date; end: Date } | null
}

interface CountBlock { count: number; reconciled: number; variance: number; remitted: number }

export interface CollectionReportCounts {
  visits: { count: number; collected: number; rescheduled: number; totalCollected: number }
  remittances: CountBlock
}

export interface DeliveryReportCounts {
  orders: { count: number; delivered: number; failed: number; codCollected: number }
  remittances: CountBlock
}

const EMPTY_REMITTANCES: CountBlock = { count: 0, reconciled: 0, variance: 0, remitted: 0 }

export const EMPTY_COLLECTION_REPORT_COUNTS: CollectionReportCounts = {
  visits: { count: 0, collected: 0, rescheduled: 0, totalCollected: 0 },
  remittances: EMPTY_REMITTANCES,
}

export const EMPTY_DELIVERY_REPORT_COUNTS: DeliveryReportCounts = {
  orders: { count: 0, delivered: 0, failed: 0, codCollected: 0 },
  remittances: EMPTY_REMITTANCES,
}

function opsArgs(filters: OpsReportCountFilters, idKey: 'p_collector_id' | 'p_driver_id') {
  return {
    [idKey]: filters.personId === 'all' ? null : filters.personId,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
  }
}

export function useCollectionReportCounts(filters: OpsReportCountFilters) {
  const args = opsArgs(filters, 'p_collector_id')
  const { data, loading, error, reload, refresh } = useCachedResource<CollectionReportCounts>(
    `collection-report-counts:${JSON.stringify(args)}`,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_collection_report_counts', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_COLLECTION_REPORT_COUNTS) as CollectionReportCounts
    },
    EMPTY_COLLECTION_REPORT_COUNTS,
  )

  useAutoRefresh(reload, {
    watch: [{ table: 'collection_visits' }, { table: 'remittances' }],
    intervalMs: SLOW_INTERVAL_MS,
  })

  return { counts: data, loading, error, refresh, reload }
}

export function useDeliveryReportCounts(filters: OpsReportCountFilters) {
  const args = opsArgs(filters, 'p_driver_id')
  const { data, loading, error, reload, refresh } = useCachedResource<DeliveryReportCounts>(
    `delivery-report-counts:${JSON.stringify(args)}`,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_delivery_report_counts', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_DELIVERY_REPORT_COUNTS) as DeliveryReportCounts
    },
    EMPTY_DELIVERY_REPORT_COUNTS,
  )

  useAutoRefresh(reload, {
    watch: [{ table: 'purchase_orders' }, { table: 'cod_remittances' }],
    intervalMs: SLOW_INTERVAL_MS,
  })

  return { counts: data, loading, error, refresh, reload }
}
