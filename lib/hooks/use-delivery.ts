'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type {
  Client, CodPayment, CodRemittance, Profile, PurchaseOrder, RemittanceStatus,
} from '@/types'

/**
 * Live Delivery data (migration 044) — the Collection twin of use-collection.ts,
 * deliberately parallel. Same reasoning throughout; see that file for the notes
 * on explicit columns and on coercing NUMERIC.
 */

const CLIENT_JOIN = `
  id, company_name, contact_person, contact_position, contact_number,
  office_address, customer_type, sales_channel, assigned_agent_id, status,
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
    const { data, error: queryError } = await supabase
      .from('purchase_orders')
      .select(PO_COLUMNS)
      .order('scheduled_for', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      const paymentsByPo = await loadCodPayments(supabase)
      setOrders((data ?? []).map(row => normalizePo(row as Record<string, unknown>, paymentsByPo)))
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

  const createOrder = useCallback(
    async (draft: NewPurchaseOrder): Promise<string | null> => {
      const supabase = createClient()
      const { error: insertError } = await supabase.from('purchase_orders').insert({
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

      if (insertError) return insertError.message
      await load()
      return null
    },
    [load]
  )

  const removeOrder = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      const { error: deleteError } = await supabase.from('purchase_orders').delete().eq('id', id)

      if (deleteError) return deleteError.message
      await load()
      return null
    },
    [load]
  )

  /** Release a driver's claim — the delivery twin of collection's cancelClaim. */
  const cancelClaim = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      const { error: updateError } = await supabase
        .from('purchase_orders')
        .update({ claimed_by: null, claimed_at: null, claimed_by_name: null })
        .eq('id', id)

      if (updateError) return updateError.message
      await load()
      return null
    },
    [load]
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

  /**
   * The collection twin's `setStatus`, against `cod_remittances` — see the note
   * there. Same asymmetry in migration 044: drivers get INSERT and SELECT on
   * their own rows, no UPDATE, so reconciliation only ever happens from here.
   */
  const setStatus = useCallback(
    async (id: string, status: RemittanceStatus): Promise<string | null> => {
      const supabase = createClient()
      const { error: updateError } = await supabase
        .from('cod_remittances')
        .update({ status })
        .eq('id', id)

      if (updateError) return updateError.message
      await load()
      return null
    },
    [load]
  )

  return { codRemittances, loading, error, refresh, setStatus }
}
