'use client'

import { createClient } from '@/lib/supabase/client'
import { fetchAllPages } from '@/lib/supabase/paginate'
import {
  VISIT_COLUMNS, ADDITIONAL_COLUMNS, REMITTANCE_COLUMNS,
} from '@/lib/hooks/use-collection'
import {
  PO_COLUMNS, COORDINATE_COLUMNS, COD_REMITTANCE_COLUMNS,
} from '@/lib/hooks/use-delivery'
import type {
  CodRemittance, CollectionVisit, Profile, PurchaseOrder, Remittance,
} from '@/types'

/**
 * The rows behind the Collection and Delivery exports, fetched ON DEMAND.
 *
 * They used to arrive through the pages' mounted hooks, so opening Reports
 * downloaded visits, purchase orders and both remittance tables whether or not
 * anyone pressed Download. The cards are served by the counts RPCs in migration
 * 140 now, and this runs only from a click.
 *
 * These read the SAME column lists the boards use, imported rather than copied,
 * so a column added for the board reaches the export without a second edit.
 *
 * Note what is NOT needed here: `normalizeVisit`/`normalizePo` fold each row's
 * payments into it, and no export column reads them. That is why these are
 * plain fetchers rather than a reuse of the hooks' normalizers — the only
 * shaping an export needs is numeric coercion, below.
 */

const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

/**
 * PostgREST can serialise NUMERIC as a string. A money column arriving as text
 * lands in the spreadsheet as text — right-aligned nowhere, and unusable in a
 * SUM — so every amount is coerced at this boundary.
 */
const num = (v: unknown): number => Number(v ?? 0)
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

export interface OpsReportFilters {
  /** 'all', or a collector / driver profile id. */
  personId: string
  /** Resolved window; null means all time. */
  range: { start: Date; end: Date } | null
}

function within(value: string | null | undefined, range: OpsReportFilters['range']) {
  if (!range) return true
  if (!value) return false
  const t = new Date(value).getTime()
  return t >= range.start.getTime() && t <= range.end.getTime()
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export async function fetchCollectionReportRows(filters: OpsReportFilters): Promise<{
  visits: CollectionVisit[]
  remittances: Remittance[]
}> {
  const supabase = createClient()

  // `columns` is a runtime string, so PostgREST's row type cannot be inferred
  // from it — hence the cast, as in the hooks these column lists come from.
  const readVisits = (columns: string) =>
    fetchAllPages<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await supabase
        .from('collection_visits')
        .select(columns)
        .order('scheduled_for', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
      return { data: data as Record<string, unknown>[] | null, error }
    })

  let visitRows: Record<string, unknown>[] = []
  try {
    visitRows = await readVisits(`${VISIT_COLUMNS}, ${ADDITIONAL_COLUMNS}`)
  } catch {
    // Pre-068 fallback, same as the board's: retry without the additional
    // columns rather than fail the export outright.
    visitRows = await readVisits(VISIT_COLUMNS)
  }

  const remittanceRows = await fetchAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from('remittances')
      .select(REMITTANCE_COLUMNS)
      .order('submitted_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  )

  const visits = visitRows
    .map(row => ({
      ...(row as unknown as CollectionVisit),
      amount_due: num(row.amount_due),
      amount_collected: numOrNull(row.amount_collected),
      client: one<CollectionVisit['client']>(row.client),
      collector: one<Profile>(row.collector),
    }))
    .filter(v => filters.personId === 'all' || v.collector_id === filters.personId)
    .filter(v => within(v.scheduled_for, filters.range))

  const remittances = remittanceRows
    .map(row => ({
      ...(row as unknown as Remittance),
      amount_collected: num(row.amount_collected),
      amount_remitted: num(row.amount_remitted),
      collector: one<Profile>(row.collector),
    }))
    .filter(r => filters.personId === 'all' || r.collector_id === filters.personId)
    .filter(r => within(r.submitted_at, filters.range))

  return { visits, remittances }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export async function fetchDeliveryReportRows(filters: OpsReportFilters): Promise<{
  orders: PurchaseOrder[]
  remittances: CodRemittance[]
}> {
  const supabase = createClient()

  const readOrders = (columns: string) =>
    fetchAllPages<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select(columns)
        .order('scheduled_for', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
      return { data: data as Record<string, unknown>[] | null, error }
    })

  let orderRows: Record<string, unknown>[] = []
  try {
    orderRows = await readOrders(`${PO_COLUMNS}, ${COORDINATE_COLUMNS}`)
  } catch {
    // Pre-114 fallback, same as the board's.
    orderRows = await readOrders(PO_COLUMNS)
  }

  const remittanceRows = await fetchAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from('cod_remittances')
      .select(COD_REMITTANCE_COLUMNS)
      .order('submitted_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  )

  const orders = orderRows
    .map(row => ({
      ...(row as unknown as PurchaseOrder),
      cod_due: numOrNull(row.cod_due),
      cod_amount: numOrNull(row.cod_amount),
      client: one<PurchaseOrder['client']>(row.client),
      driver: one<Profile>(row.driver),
    }))
    .filter(po => filters.personId === 'all' || po.driver_id === filters.personId)
    .filter(po => within(po.scheduled_for, filters.range))

  const remittances = remittanceRows
    .map(row => ({
      ...(row as unknown as CodRemittance),
      amount_collected: num(row.amount_collected),
      amount_remitted: num(row.amount_remitted),
      driver: one<Profile>(row.driver),
    }))
    .filter(r => filters.personId === 'all' || r.driver_id === filters.personId)
    .filter(r => within(r.submitted_at, filters.range))

  return { orders, remittances }
}
