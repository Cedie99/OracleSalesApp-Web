import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAuthorizedCronRequest } from '@/lib/cron-secret'
import { sendSms, toE164, smsConfigured } from '@/lib/collection/busybee'

export const dynamic = 'force-dynamic'

/**
 * Customer acknowledgement SMS on remittance (feature 106).
 *
 * When a collector/driver REMITS the cash they took from a store, that store
 * gets a text acknowledging the company received the payment, with the running
 * balance if they still owe. The trigger is remittance, not the field handover:
 * a payment becomes eligible the instant it is linked to a remittance
 * (086 collection_payments.remittance_id / 087 cod_payments.cod_remittance_id).
 *
 * The send goes through BusyBee, whose keys are server-only in the web app —
 * Postgres can't call it — so the DB reaches this route over HTTP two ways:
 *
 *  - POST — a Supabase Database Webhook on remittances / cod_remittances fires
 *           the moment a remittance is written, giving the customer an IMMEDIATE
 *           ack (see the POST handler at the bottom).
 *  - GET  — a daily Vercel Cron (vercel.json) sweeps up anything a missed
 *           webhook left behind. A webhook has no retry; the cron is the
 *           self-healing backstop.
 *
 * Each pass finds remitted-but-un-acknowledged payments, sends one SMS per
 * store, and stamps customer_sms_sent_at so nothing is ever texted twice. A row
 * is only stamped once its store has actually been notified (or has no dialable
 * number — a permanent skip), so a transient gateway failure is simply retried
 * next pass. That idempotent stamp is what lets the webhook and cron coexist.
 *
 * Both modules are handled: Collection (collection_payments → collection_visits)
 * and Delivery COD (cod_payments → purchase_orders). Same shape, two table sets.
 */

/** A store's worth of newly-remitted payments, ready to acknowledge as one SMS. */
interface AckGroup {
  /** visit_id / po_id — the store's open record; groups payments in this batch. */
  parentId: string
  /** Every payment row in this batch for that store, so we can stamp them all. */
  paymentIds: string[]
  /** What we're acknowledging now: the sum of THIS batch's payments. */
  paidNow: number
  /** What the store still owes on the record, after all payments so far. */
  balance: number
  company: string
  phone: string | null
}

interface ModuleOutcome {
  configured: boolean
  candidates: number
  stores: number
  sent: number
  failed: number
  /** No dialable customer number — stamped so it isn't reprocessed forever. */
  skipped: number
}

/**
 * GSM-7-safe peso, mirroring lib/collection/busybee's copy constraints: a single
 * non-GSM char (₱, an em dash, a smart quote) flips the whole SMS to UCS-2 and
 * more than halves the per-segment budget, so this uses `PHP` and plain digits.
 * lib/money's peso() prints ₱ and must NOT be used for SMS.
 */
function pesoSms(n: number): string {
  return `PHP ${n.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function collectionAckBody(paidNow: number, balance: number): string {
  const ack = `Oracle Sales: We acknowledge your payment of ${pesoSms(paidNow)}.`
  return balance <= 0
    ? `${ack} Your account is now fully paid. Salamat po!`
    : `${ack} Remaining balance: ${pesoSms(balance)}. Salamat po!`
}

function deliveryAckBody(paidNow: number, balance: number): string {
  const ack = `Oracle Sales: We acknowledge your COD payment of ${pesoSms(paidNow)} for your delivered order.`
  return balance <= 0
    ? `${ack} Your order is now fully paid. Salamat po!`
    : `${ack} Remaining balance: ${pesoSms(balance)}. Salamat po!`
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Send one SMS per store and stamp the rows we handled. A store is stamped when
 * it is texted OR when it has no dialable number (permanent — don't reprocess);
 * a transient send failure is left unstamped to retry next pass.
 */
async function notifyGroups(
  supabase: AdminClient,
  table: 'collection_payments' | 'cod_payments',
  groups: AckGroup[],
  buildBody: (paidNow: number, balance: number) => string,
): Promise<Pick<ModuleOutcome, 'sent' | 'failed' | 'skipped'>> {
  const now = new Date().toISOString()
  let sent = 0
  let failed = 0
  let skipped = 0

  const stamp = async (ids: string[]) => {
    await supabase.from(table).update({ customer_sms_sent_at: now }).in('id', ids)
  }

  for (const g of groups) {
    const to = toE164(g.phone)
    if (!to) {
      // Store row carries no mobile we can dial. This can never succeed, so
      // stamp it — otherwise every future pass re-selects and re-skips it.
      skipped++
      await stamp(g.paymentIds)
      continue
    }

    const res = await sendSms({ to, body: buildBody(g.paidNow, g.balance) })
    if (res.ok) {
      sent++
      await stamp(g.paymentIds)
    } else {
      // Transient (gateway/credits/network): leave unstamped so the next pass
      // retries. The row stays in the poll's partial index until it lands.
      failed++
    }
  }

  return { sent, failed, skipped }
}

/** Collection: remitted collection_payments not yet acknowledged. */
async function runCollection(supabase: AdminClient): Promise<ModuleOutcome> {
  const base: ModuleOutcome = {
    configured: smsConfigured(), candidates: 0, stores: 0, sent: 0, failed: 0, skipped: 0,
  }

  const { data, error } = await supabase
    .from('collection_payments')
    .select(`
      id,
      amount,
      visit_id,
      collection_visits!inner (
        amount_due,
        amount_collected,
        clients!inner ( company_name, contact_number )
      )
    `)
    .not('remittance_id', 'is', null)
    .is('customer_sms_sent_at', null)

  if (error) throw new Error(`collection query: ${error.message}`)

  interface Row {
    id: string
    amount: number | string
    visit_id: string
    collection_visits: {
      amount_due: number | string | null
      amount_collected: number | string | null
      clients: { company_name: string | null; contact_number: string | null }
    }
  }
  const rows = (data ?? []) as unknown as Row[]
  base.candidates = rows.length

  const groups = new Map<string, AckGroup>()
  for (const r of rows) {
    const v = r.collection_visits
    const due = Number(v.amount_due ?? 0)
    const collected = Number(v.amount_collected ?? 0)
    let g = groups.get(r.visit_id)
    if (!g) {
      g = {
        parentId: r.visit_id,
        paymentIds: [],
        paidNow: 0,
        balance: Math.max(0, due - collected),
        company: v.clients.company_name ?? 'your store',
        phone: v.clients.contact_number,
      }
      groups.set(r.visit_id, g)
    }
    g.paymentIds.push(r.id)
    g.paidNow += Number(r.amount)
  }

  base.stores = groups.size
  const counts = await notifyGroups(supabase, 'collection_payments', [...groups.values()], collectionAckBody)
  return { ...base, ...counts }
}

/** Delivery COD: remitted cod_payments not yet acknowledged. */
async function runDelivery(supabase: AdminClient): Promise<ModuleOutcome> {
  const base: ModuleOutcome = {
    configured: smsConfigured(), candidates: 0, stores: 0, sent: 0, failed: 0, skipped: 0,
  }

  const { data, error } = await supabase
    .from('cod_payments')
    .select(`
      id,
      amount,
      po_id,
      purchase_orders!inner (
        cod_due,
        cod_amount,
        clients!inner ( company_name, contact_number )
      )
    `)
    .not('cod_remittance_id', 'is', null)
    .is('customer_sms_sent_at', null)

  if (error) throw new Error(`delivery query: ${error.message}`)

  interface Row {
    id: string
    amount: number | string
    po_id: string
    purchase_orders: {
      cod_due: number | string | null
      cod_amount: number | string | null
      clients: { company_name: string | null; contact_number: string | null }
    }
  }
  const rows = (data ?? []) as unknown as Row[]
  base.candidates = rows.length

  const groups = new Map<string, AckGroup>()
  for (const r of rows) {
    const po = r.purchase_orders
    const due = Number(po.cod_due ?? 0)
    const collected = Number(po.cod_amount ?? 0)
    let g = groups.get(r.po_id)
    if (!g) {
      g = {
        parentId: r.po_id,
        paymentIds: [],
        paidNow: 0,
        balance: Math.max(0, due - collected),
        company: po.clients.company_name ?? 'your store',
        phone: po.clients.contact_number,
      }
      groups.set(r.po_id, g)
    }
    g.paymentIds.push(r.id)
    g.paidNow += Number(r.amount)
  }

  base.stores = groups.size
  const counts = await notifyGroups(supabase, 'cod_payments', [...groups.values()], deliveryAckBody)
  return { ...base, ...counts }
}

/**
 * The scan-and-send pass, shared by both ways in:
 *
 *  - GET  — the daily Vercel Cron (vercel.json), the self-healing backstop.
 *  - POST — a Supabase Database Webhook on remittances / cod_remittances, so a
 *           remittance fires the ack IMMEDIATELY instead of waiting for the cron.
 *
 * Both authenticate the same way (`Authorization: Bearer $CRON_SECRET`) — Vercel
 * Cron sends that header automatically, and the webhook is configured to send it
 * too. Both run the identical broad scan of remitted-but-un-acked payments; the
 * webhook's row payload is ignored on purpose, because the `customer_sms_sent_at`
 * stamp already makes the pass idempotent — firing early, late, or twice can
 * never double-text a store. That is exactly what lets the webhook and the cron
 * safely coexist: the webhook delivers instantly, the cron sweeps up anything a
 * missed webhook left behind (a webhook has no retry of its own).
 */
async function runPass(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Nothing to lose by returning early: with no provider wired, no row is
  // stamped, so every candidate is picked up unchanged once BusyBee is set.
  if (!smsConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'SMS not configured' })
  }

  const supabase = createAdminClient()

  try {
    const [collection, delivery] = await Promise.all([
      runCollection(supabase),
      runDelivery(supabase),
    ])
    return NextResponse.json({ ok: true, collection, delivery })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'remittance-sms failed' },
      { status: 500 },
    )
  }
}

/** Daily Vercel Cron backstop (vercel.json). */
export async function GET(request: Request) {
  return runPass(request)
}

/** Supabase Database Webhook on remittance-submit — the immediate path. */
export async function POST(request: Request) {
  return runPass(request)
}
