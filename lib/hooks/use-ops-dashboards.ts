'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import { PAYMENT_METHODS } from '@/lib/status-styles'
import { METHODS_WITH_RECEIPT_PHOTO } from '@/lib/collection'
import type {
  CollectionVisitStatus, DeliveryStatus, PaymentMethod, RemittanceStatus,
} from '@/types'

/**
 * The Collection and Delivery dashboards' numbers, computed by Postgres.
 *
 * Both boards are metric cards, a fourteen-day trend, a per-person performance
 * table and five recent rows — every figure a COUNT, SUM or GROUP BY — and both
 * used to derive all of it in JavaScript from every visit / purchase order and
 * every remittance in the database. Migration 135 computes them instead.
 *
 * These aggregate MONEY, so the two rules the TypeScript flags as easy to get
 * wrong are passed to the RPC rather than reimplemented in SQL: which payment
 * methods require a receipt photo, and which methods the breakdown recognises.
 * One definition each, so drift is impossible rather than merely unlikely.
 */

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface OpsDashboardFilters {
  /** Resolved window; null means all time. */
  range: { start: Date; end: Date } | null
}

function rangeArgs(filters: OpsDashboardFilters) {
  return {
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
    p_tz: browserTimeZone(),
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectionDashboardData {
  stats: {
    listed: number
    collectedCount: number
    rescheduledCount: number
    pendingCount: number
    partialCount: number
    totalDue: number
    totalCollected: number
    outstanding: number
    stillHeld: number
    missingProof: number
  }
  variance: number
  /** `day` is an ISO date; the label is formatted by the caller. */
  dailyTrend: { day: string; due: number; collected: number }[]
  byMethod: Record<PaymentMethod, { count: number; amount: number }>
  collectorPerformance: {
    id: string
    name: string
    avatarUrl: string | null
    stores: number
    collected: number
    rescheduled: number
  }[]
  topRemittances: {
    id: string
    collectorName: string | null
    amountRemitted: number
    storeCount: number
    status: RemittanceStatus
    variance: number
  }[]
  recentVisits: {
    id: string
    status: CollectionVisitStatus
    visitedAt: string | null
    amountCollected: number
    clientName: string | null
    collectorName: string | null
  }[]
}

const EMPTY_BY_METHOD = Object.fromEntries(
  PAYMENT_METHODS.map(m => [m, { count: 0, amount: 0 }]),
) as Record<PaymentMethod, { count: number; amount: number }>

export const EMPTY_COLLECTION_DASHBOARD: CollectionDashboardData = {
  stats: {
    listed: 0, collectedCount: 0, rescheduledCount: 0, pendingCount: 0, partialCount: 0,
    totalDue: 0, totalCollected: 0, outstanding: 0, stillHeld: 0, missingProof: 0,
  },
  variance: 0,
  dailyTrend: [],
  byMethod: EMPTY_BY_METHOD,
  collectorPerformance: [],
  topRemittances: [],
  recentVisits: [],
}

export function useCollectionDashboard(filters: OpsDashboardFilters) {
  const args = {
    ...rangeArgs(filters),
    p_methods: [...PAYMENT_METHODS],
    p_receipt_methods: [...METHODS_WITH_RECEIPT_PHOTO],
  }
  const key = `collection-dashboard:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<CollectionDashboardData>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_collection_dashboard', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_COLLECTION_DASHBOARD) as CollectionDashboardData
    },
    EMPTY_COLLECTION_DASHBOARD,
  )

  // An operational board somebody sits and watches while the field works, so it
  // takes the fast lane — the same cadence the Collection page itself uses.
  // `remittances` is watched alongside the visits because "still held" and the
  // variance both move when money is handed over, which never touches a visit.
  useAutoRefresh(reload, {
    watch: [{ table: 'collection_visits' }, { table: 'remittances' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  return { data, loading, error, refresh, reload }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryDashboardData {
  stats: {
    listed: number
    deliveredCount: number
    failedCount: number
    pendingCount: number
    partialCount: number
    codDue: number
    codCollected: number
    codHeld: number
    missingProof: number
    /** Null when no stop has both a time-in and a time-out. */
    avgDwell: number | null
  }
  variance: number
  dailyTrend: { day: string; delivered: number; failed: number }[]
  byArea: { area: string; stops: number; failed: number }[]
  driverPerformance: {
    id: string
    name: string
    avatarUrl: string | null
    plates: string[]
    stops: number
    delivered: number
    failed: number
    cod: number
    avgDwell: number | null
    rate: number
  }[]
  topRemittances: {
    id: string
    driverName: string | null
    amountRemitted: number
    stopCount: number
    status: RemittanceStatus
    variance: number
  }[]
  recentStops: {
    id: string
    status: DeliveryStatus
    timeOut: string | null
    area: string
    clientName: string | null
    driverName: string | null
  }[]
}

export const EMPTY_DELIVERY_DASHBOARD: DeliveryDashboardData = {
  stats: {
    listed: 0, deliveredCount: 0, failedCount: 0, pendingCount: 0, partialCount: 0,
    codDue: 0, codCollected: 0, codHeld: 0, missingProof: 0, avgDwell: null,
  },
  variance: 0,
  dailyTrend: [],
  byArea: [],
  driverPerformance: [],
  topRemittances: [],
  recentStops: [],
}

export function useDeliveryDashboard(filters: OpsDashboardFilters) {
  const args = rangeArgs(filters)
  const key = `delivery-dashboard:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<DeliveryDashboardData>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_delivery_dashboard', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_DELIVERY_DASHBOARD) as DeliveryDashboardData
    },
    EMPTY_DELIVERY_DASHBOARD,
  )

  useAutoRefresh(reload, {
    watch: [{ table: 'purchase_orders' }, { table: 'cod_remittances' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  return { data, loading, error, refresh, reload }
}
