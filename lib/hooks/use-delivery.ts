'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { recordAuditLog } from '@/lib/audit/actions'
import { singleChange } from '@/lib/audit/entries'
import { peso } from '@/lib/money'
import { REMITTANCE_STATUS_LABEL } from '@/lib/status-styles'
import type {
  Client, CodPayment, CodRemittance, Profile, PurchaseOrder, RemittanceStatus,
} from '@/types'

/**
 * Live Delivery data (migration 044) — the Collection twin of use-collection.ts,
 * deliberately parallel. Same reasoning throughout; see that file for the notes
 * on explicit columns and on coercing NUMERIC.
 */

// Structured address columns ride along with the legacy free-text one — see the
// twin note in use-collection.ts.
const CLIENT_JOIN = `
  id, company_name, contact_person, contact_position, contact_number,
  office_address, address_line1, address_line2, landmark,
  customer_type, sales_channel, assigned_agent_id, status,
  city, province, lost_at, reassignable_at, created_at, updated_at
`

const PROFILE_JOIN = `id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at`

const PO_COLUMNS = `
  id, po_number, client_id, client_name, area, status, scheduled_for, listed_by, listed_at,
  cod, cod_due, claimed_by, claimed_at, claimed_by_name,
  driver_id, truck_plate, sequence_no, receiver_name,
  receiver_signature_url, time_in, time_out, proof_url, backload_photo_url,
  gps_lat, gps_lng, remarks, cod_amount, cod_method, cod_photo_url, cod_remitted,
  created_at,
  client:clients!client_id ( ${CLIENT_JOIN} ),
  driver:profiles!driver_id ( ${PROFILE_JOIN} )
`

// The store's default map pin (migration 114), selected ON TOP of PO_COLUMNS and
// kept apart so the fetch can fall back without it — the collection twin of that
// file's ADDITIONAL_COLUMNS, and for the same deploy-ordering reason: 114 ships
// in this repo and CI applies it on merge, but the Vercel build and the
// migration push race. Without the fallback that window is a dead page, because
// PostgREST rejects the ENTIRE select on one unknown column.
const COORDINATE_COLUMNS = `client_lat, client_lng`

/** True when a select failed only because 114's columns aren't there yet. */
function isMissingCoordinateColumn(error: { message?: string } | null): boolean {
  return !!error?.message && /client_lat|client_lng/.test(error.message)
}

const COD_REMITTANCE_COLUMNS = `
  id, driver_id, amount_remitted, amount_collected, status, receiver_name,
  receiver_signature_url, po_ids, submitted_at, created_at,
  driver:profiles!driver_id ( ${PROFILE_JOIN} )
`

// The COD installments behind a partial PO (migration 073). Fetched in one pass
// and grouped onto their POs rather than joined into PO_COLUMNS, so the query can
// tolerate the table not existing yet — during the window before 073 deploys.
// The delivery twin of use-collection.ts's PAYMENT_COLUMNS. See loadCodPayments.
const COD_PAYMENT_COLUMNS = `
  id, po_id, driver_id, amount, payment_method, payment_photo_url,
  gps_lat, gps_lng, remarks, paid_at, created_at,
  driver:profiles!driver_id ( ${PROFILE_JOIN} )
`

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeCodPayment(row: Record<string, unknown>): CodPayment {
  return {
    ...(row as unknown as CodPayment),
    amount: num(row.amount) ?? 0,
    gps_lat: num(row.gps_lat),
    gps_lng: num(row.gps_lng),
    driver: one<Profile>(row.driver),
  }
}

/**
 * Every COD installment, grouped by the PO it belongs to (newest first). One
 * query, not one per PO. Tolerates the pre-073 window: if `cod_payments` doesn't
 * exist yet the select errors and we return an empty map, so the page shows no
 * installment history rather than falling over — the same deploy-order-proofing
 * use-collection.ts's loadPayments uses.
 */
async function loadCodPayments(
  supabase: ReturnType<typeof createClient>,
): Promise<Map<string, CodPayment[]>> {
  const byPo = new Map<string, CodPayment[]>()
  const { data, error } = await supabase
    .from('cod_payments')
    .select(COD_PAYMENT_COLUMNS)
    .order('paid_at', { ascending: false })

  if (error || !data) return byPo
  for (const raw of data) {
    const payment = normalizeCodPayment(raw as Record<string, unknown>)
    const list = byPo.get(payment.po_id)
    if (list) list.push(payment)
    else byPo.set(payment.po_id, [payment])
  }
  return byPo
}

function one<T>(value: unknown): T | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return (v as T | null) ?? undefined
}

function normalizePo(
  row: Record<string, unknown>,
  paymentsByPo?: Map<string, CodPayment[]>,
): PurchaseOrder {
  return {
    ...(row as unknown as PurchaseOrder),
    cod_due: num(row.cod_due),
    cod_amount: num(row.cod_amount),
    sequence_no: num(row.sequence_no),
    gps_lat: num(row.gps_lat),
    gps_lng: num(row.gps_lng),
    // Absent while the pre-114 fallback select is in play; null then reads as
    // "no default pin known", which is how the maps page already treats it.
    client_lat: num(row.client_lat),
    client_lng: num(row.client_lng),
    client: one<Client>(row.client),
    driver: one<Profile>(row.driver),
    // COD installments behind a partial PO (migration 073). Empty until 073 is
    // live — loadCodPayments yields an empty map on the missing table — which
    // reads the same as a PO paid in one go: no history to show.
    cod_payments: paymentsByPo?.get(row.id as string) ?? [],
  }
}

function normalizeCodRemittance(row: Record<string, unknown>): CodRemittance {
  return {
    ...(row as unknown as CodRemittance),
    amount_remitted: num(row.amount_remitted) ?? 0,
    amount_collected: num(row.amount_collected) ?? 0,
    driver: one<Profile>(row.driver),
  }
}

/** What the admin fills in when putting a PO on a delivery day's trip list. */
export interface NewPurchaseOrder {
  poNumber: string
  clientId: string
  /**
   * The selected client's `company_name`, denormalized onto the row (migration
   * 045) because the driver's phone has no RLS read on `clients`.
   */
  clientName: string
  /** Admin-entered on the form — unlike collection, which derives it from the city. */
  area: string
  /** `yyyy-MM-dd` from the date input. */
  scheduledFor: string
  cod: boolean
  codDue: number | null
  listedBy: string | null
}

interface UsePurchaseOrdersResult {
  orders: PurchaseOrder[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
  createOrder: (draft: NewPurchaseOrder) => Promise<string | null>
  removeOrder: (id: string) => Promise<string | null>
  cancelClaim: (id: string) => Promise<string | null>
}

/** Every listed stop, newest delivery day first, with client and driver joined. */
export function usePurchaseOrders(): UsePurchaseOrdersResult {
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const primary = await supabase
      .from('purchase_orders')
      .select(`${PO_COLUMNS}, ${COORDINATE_COLUMNS}`)
      .order('scheduled_for', { ascending: false })

    // The two selects infer different row shapes, so hold the rows at the shape
    // normalizePo already accepts rather than let the union fight itself.
    let rows = primary.data as Record<string, unknown>[] | null
    let queryError = primary.error

    // Pre-114 fallback: retry without the default-pin columns rather than fail
    // the whole page. See COORDINATE_COLUMNS.
    if (queryError && isMissingCoordinateColumn(queryError)) {
      const fallback = await supabase
        .from('purchase_orders')
        .select(PO_COLUMNS)
        .order('scheduled_for', { ascending: false })
      rows = fallback.data as Record<string, unknown>[] | null
      queryError = fallback.error
    }

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      const paymentsByPo = await loadCodPayments(supabase)
      setOrders((rows ?? []).map(row => normalizePo(row, paymentsByPo)))
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // The delivery twin of the collection board — same reasoning, same cadence.
  // COD payments are watched beside the orders for the same reason payments are
  // beside visits: the money arrives as its own row.
  useAutoRefresh(load, {
    watch: [{ table: 'purchase_orders' }, { table: 'cod_payments' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  const createOrder = useCallback(
    async (draft: NewPurchaseOrder): Promise<string | null> => {
      const supabase = createClient()
      const { data: inserted, error: insertError } = await supabase.from('purchase_orders').insert({
        po_number: draft.poNumber,
        client_id: draft.clientId,
        // Denormalized at publish time — see migration 045.
        client_name: draft.clientName,
        area: draft.area,
        status: 'pending',
        scheduled_for: new Date(`${draft.scheduledFor}T12:00:00`).toISOString(),
        listed_by: draft.listedBy,
        cod: draft.cod,
        // The CHECK constraint rejects a money figure on a non-COD PO, so this
        // must be null rather than 0 when the toggle is off.
        cod_due: draft.cod ? draft.codDue : null,
      })
        .select('id')
        .single()

      if (insertError) return insertError.message

      // The CHECK constraint keeps codDue null on a non-COD order, so the two
      // flags always agree — but the log renders both from one value rather
      // than trusting that, since a mismatch would print "COD ₱null".
      const codLabel = draft.cod && draft.codDue != null ? peso(draft.codDue) : null

      void recordAuditLog({
        action: 'purchase_order.listed',
        entityTable: 'purchase_orders',
        entityId: inserted?.id ?? null,
        entityLabel: `PO ${draft.poNumber} — ${draft.clientName}`,
        summary:
          `Listed PO ${draft.poNumber} for ${draft.clientName} on ${draft.scheduledFor}` +
          (codLabel ? ` (COD ${codLabel})` : ''),
        changes: [
          { field: 'scheduled_for', label: 'Scheduled for', from: null, to: draft.scheduledFor },
          { field: 'area', label: 'Area', from: null, to: draft.area },
          { field: 'cod', label: 'COD', from: null, to: codLabel ?? 'No' },
        ],
      })

      await load()
      return null
    },
    [load]
  )

  const removeOrder = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      // Read before the delete — see the note on collection's removeVisit.
      const target = orders.find(o => o.id === id)

      const { error: deleteError } = await supabase.from('purchase_orders').delete().eq('id', id)

      if (deleteError) return deleteError.message

      void recordAuditLog({
        action: 'purchase_order.removed',
        entityTable: 'purchase_orders',
        entityId: id,
        entityLabel: target ? `PO ${target.po_number} — ${target.client_name}` : null,
        summary: `Removed PO ${target?.po_number ?? ''} from the delivery list`.replace(/\s+/g, ' '),
        metadata: target
          ? {
              po_number: target.po_number,
              client_name: target.client_name,
              scheduled_for: target.scheduled_for,
              status: target.status,
              cod_due: target.cod_due,
              claimed_by_name: target.claimed_by_name,
            }
          : null,
      })

      await load()
      return null
    },
    [load, orders]
  )

  /** Release a driver's claim — the delivery twin of collection's cancelClaim. */
  const cancelClaim = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      const target = orders.find(o => o.id === id)

      const { error: updateError } = await supabase
        .from('purchase_orders')
        .update({ claimed_by: null, claimed_at: null, claimed_by_name: null })
        .eq('id', id)

      if (updateError) return updateError.message

      const driver = target?.claimed_by_name
      void recordAuditLog({
        action: 'purchase_order.claim_released',
        entityTable: 'purchase_orders',
        entityId: id,
        entityLabel: target ? `PO ${target.po_number} — ${target.client_name}` : null,
        summary:
          `Released ${driver ? `${driver}'s` : 'the'} claim on ` +
          `PO ${target?.po_number ?? ''}`.trimEnd(),
        changes: singleChange('claimed_by_name', 'Claimed by', driver ?? null, null),
      })

      await load()
      return null
    },
    [load, orders]
  )

  return { orders, loading, error, refresh, createOrder, removeOrder, cancelClaim }
}

interface UseCodRemittancesResult {
  codRemittances: CodRemittance[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
  setStatus: (id: string, status: RemittanceStatus) => Promise<string | null>
}

/** COD handed over by drivers, most recent first. */
export function useCodRemittances(): UseCodRemittancesResult {
  const [codRemittances, setCodRemittances] = useState<CodRemittance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('cod_remittances')
      .select(COD_REMITTANCE_COLUMNS)
      .order('submitted_at', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setCodRemittances(
        (data ?? []).map(row => normalizeCodRemittance(row as Record<string, unknown>))
      )
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  useAutoRefresh(load, {
    watch: [{ table: 'cod_remittances' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  /**
   * The collection twin's `setStatus`, against `cod_remittances` — see the note
   * there. Same asymmetry in migration 044: drivers get INSERT and SELECT on
   * their own rows, no UPDATE, so reconciliation only ever happens from here.
   */
  const setStatus = useCallback(
    async (id: string, status: RemittanceStatus): Promise<string | null> => {
      const supabase = createClient()
      const target = codRemittances.find(r => r.id === id)

      const { error: updateError } = await supabase
        .from('cod_remittances')
        .update({ status })
        .eq('id', id)

      if (updateError) return updateError.message

      const driver = target?.driver?.full_name ?? 'a driver'
      void recordAuditLog({
        action: 'cod_remittance.status_changed',
        entityTable: 'cod_remittances',
        entityId: id,
        entityLabel: `${driver} — ${peso(target?.amount_remitted ?? 0)}`,
        summary:
          `Marked ${driver}'s ${peso(target?.amount_remitted ?? 0)} COD remittance as ` +
          `${REMITTANCE_STATUS_LABEL[status]}`,
        changes: singleChange(
          'status',
          'Status',
          target ? REMITTANCE_STATUS_LABEL[target.status] : null,
          REMITTANCE_STATUS_LABEL[status],
        ),
        metadata: target
          ? {
              amount_remitted: target.amount_remitted,
              amount_collected: target.amount_collected,
              variance: target.amount_remitted - target.amount_collected,
            }
          : null,
      })

      await load()
      return null
    },
    [load, codRemittances]
  )

  return { codRemittances, loading, error, refresh, setStatus }
}
