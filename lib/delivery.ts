/**
 * Delivery-module helpers shared by the Delivery Admin page and its components
 * (F-007). The Collection-side twin of this file is lib/collection.ts, and the
 * two are deliberately parallel — same shape of work, different nouns.
 *
 * The mental model these encode: the admin publishes **one trip list per
 * delivery day** — every customer and the area they are in, plus a COD amount
 * where there is one — and drivers on mobile work that list down. No PO is
 * assigned to a particular driver; whoever reaches the stop delivers it, and
 * their name, their truck's plate, and the stop's position in their run all land
 * on the record at that moment.
 *
 * **One day, one outcome.** A PO belongs to its delivery day and ends there:
 * delivered, or failed with the goods riding back. No countdown, no follow-up
 * window, no auto-delete. If the office wants another attempt, an admin lists it
 * again on a later day — nothing rolls forward by itself.
 */
import type { CodRemittance, PurchaseOrder } from '@/types'
import { peso } from '@/lib/money'
import { groupByWorkerDay, tripColor, workerColors, type Trip, type TripStop } from '@/lib/trips'

/**
 * How many customers the paper trip ticket holds in the current process,
 * grouped by area. Not a hard limit anywhere — the office works this way today,
 * so a day's list running past it is worth surfacing before a driver discovers
 * it on the road.
 */
export const TRIP_CAP = 15

/** Terminal outcomes — the stop is finished for that day either way. */
export function isClosed(po: PurchaseOrder): boolean {
  return po.status === 'delivered' || po.status === 'failed'
}

export interface ProofState {
  label: string
  url: string | null
  /**
   * Whether the driver's app blocks on this one. Required captures missing means
   * something went wrong; an expected-but-optional capture missing is worth
   * showing as a gap without calling it a fault.
   */
  required: boolean
}

/**
 * The captures a PO carries, which depend on how it ended.
 *
 * Delivered: the proof photo, the COD payment photo when there is money
 * involved, and the receiving party's signature. The signature is the paper Trip
 * Report's per-row "COMPANY REPRESENTATIVE'S SIGNATURE" — signed at every stop
 * on the sheet, so it belongs in the proof set even though 2026-07-25 made it
 * non-blocking on the phone. The receiver's NAME is not here: that is the part
 * customers genuinely refuse, and its absence is normal.
 *
 * Failed: the backload photo of what came back, which the driver's app refuses
 * to log a failed delivery without, plus the signature of whoever turned the
 * load away.
 *
 * Stops nobody has reached have nothing captured yet, legitimately.
 */
export function poProofs(po: PurchaseOrder): ProofState[] {
  if (po.status === 'delivered') {
    const proofs: ProofState[] = [
      { label: 'Proof of delivery', url: po.proof_url, required: true },
    ]
    if (po.cod) proofs.push({ label: 'COD payment', url: po.cod_photo_url, required: true })
    proofs.push({ label: 'Receiver signature', url: po.receiver_signature_url, required: false })
    return proofs
  }
  if (po.status === 'failed') {
    return [
      { label: 'Backload proof', url: po.backload_photo_url, required: true },
      { label: 'Receiver signature', url: po.receiver_signature_url, required: false },
    ]
  }
  return []
}

/** True when a closed-out PO is missing a capture its app should have blocked on. */
export function hasMissingProof(po: PurchaseOrder): boolean {
  return poProofs(po).some(p => p.required && !p.url)
}

/**
 * Minutes the truck spent at the stop — TIME-OUT minus TIME-IN off the trip
 * report. Null until both ends exist, never 0-as-unknown.
 */
export function dwellMinutes(po: PurchaseOrder): number | null {
  if (!po.time_in || !po.time_out) return null
  const mins = (new Date(po.time_out).getTime() - new Date(po.time_in).getTime()) / 60000
  return Math.max(0, Math.round(mins))
}

/** Remitted minus collected. Negative means the driver handed over less. */
export function codVariance(r: CodRemittance): number {
  return r.amount_remitted - r.amount_collected
}

/** COD money a driver is still holding — collected at a stop, not yet remitted. */
export function isHeldCod(po: PurchaseOrder): boolean {
  return po.cod && po.status === 'delivered' && !po.cod_remitted
}

/** A driver who ran at least one stop on a given day's trip list. */
export interface DayDriver {
  id: string
  name: string
  avatarUrl: string | null
  /** Stops this driver closed out on the day. */
  count: number
  /** Plates they ran, in the order first seen. Usually one. */
  plates: string[]
  /** COD they took in, which is what their remittance is reconciled against. */
  codCollected: number
}

/** One delivery day's published trip list. */
export interface TripList {
  /** `yyyy-MM-dd` — stable across re-renders. */
  id: string
  /** Midnight of the delivery day, for sorting and formatting. */
  day: Date
  stops: PurchaseOrder[]
  /** Stops that ended, delivered or failed. */
  closedCount: number
  /** Stops nobody has reached yet. */
  openCount: number
  /** Stops whose goods came back — the admin's re-list-or-write-off pile. */
  failedCount: number
  /** Areas this day's run covers, the way the paper ticket groups them. */
  areas: string[]
  /** Sum of COD expected across the whole list. */
  codDue: number
  /** Sum of COD actually taken in. */
  codCollected: number
  /** COD still riding on stops nobody has closed out yet. */
  codOutstanding: number
  /** Over the ~15-customer shape of the current paper trip ticket. */
  overCap: boolean
  /**
   * Who has run the list so far. Derived after the fact from the stops that were
   * actually worked — nobody is assigned to a day up front.
   */
  drivers: DayDriver[]
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * Group POs into daily trip lists, newest day first.
 *
 * Deliberately NOT grouped by driver, for the same reason Collection isn't
 * grouped by collector: the list is published per day and any driver can take
 * any stop on it, so a per-driver board would invent a dispatch structure the
 * product doesn't have — and would strand every waiting PO, which belongs to
 * nobody yet, in an "unassigned" bucket.
 *
 * A PO re-listed after a failed day appears on both days, because those are two
 * separate attempts on two separate trip tickets. That is the point of the
 * one-day rule.
 */
export function buildTripLists(orders: PurchaseOrder[]): TripList[] {
  const byDay = new Map<string, PurchaseOrder[]>()

  for (const po of orders) {
    const key = dayKey(po.scheduled_for)
    const existing = byDay.get(key)
    if (existing) existing.push(po)
    else byDay.set(key, [po])
  }

  const lists: TripList[] = []

  for (const [id, stops] of byDay) {
    const open = stops.filter(po => !isClosed(po))
    lists.push({
      id,
      day: new Date(id + 'T00:00:00'),
      stops: [...stops].sort(stopOrder),
      closedCount: stops.length - open.length,
      openCount: open.length,
      failedCount: stops.filter(po => po.status === 'failed').length,
      areas: [...new Set(stops.map(po => po.area))].sort(),
      codDue: stops.reduce((sum, po) => sum + (po.cod_due ?? 0), 0),
      codCollected: stops.reduce((sum, po) => sum + (po.cod_amount ?? 0), 0),
      codOutstanding: open.reduce((sum, po) => sum + (po.cod_due ?? 0), 0),
      overCap: stops.length > TRIP_CAP,
      drivers: buildDrivers(stops),
    })
  }

  return lists.sort((a, b) => b.day.getTime() - a.day.getTime())
}

function buildDrivers(stops: PurchaseOrder[]): DayDriver[] {
  const byDriver = new Map<string, DayDriver>()

  for (const po of stops) {
    // Waiting stops have no driver yet — that is the point of the shared list.
    if (!po.driver_id) continue
    const existing = byDriver.get(po.driver_id)
    if (existing) {
      existing.count += 1
      existing.codCollected += po.cod_amount ?? 0
      if (po.truck_plate && !existing.plates.includes(po.truck_plate)) {
        existing.plates.push(po.truck_plate)
      }
    } else {
      byDriver.set(po.driver_id, {
        id: po.driver_id,
        name: po.driver?.full_name ?? 'Unknown',
        avatarUrl: po.driver?.avatar_url ?? null,
        count: 1,
        plates: po.truck_plate ? [po.truck_plate] : [],
        codCollected: po.cod_amount ?? 0,
      })
    }
  }

  return [...byDriver.values()].sort((a, b) => b.count - a.count)
}

/**
 * Delivered stops first, then the failed ones the admin has to decide about,
 * then whatever is still waiting.
 *
 * Closed-out stops group by driver before sorting on the sequence number,
 * because the sequence counts a single driver's own run. Two drivers on one
 * day's list each have a #1, and interleaving them would read as a broken
 * ordering rather than as two runs.
 */
function stopOrder(a: PurchaseOrder, b: PurchaseOrder): number {
  const rank = (po: PurchaseOrder) =>
    po.status === 'delivered' ? 0 : po.status === 'failed' ? 1 : 2
  const byRank = rank(a) - rank(b)
  if (byRank !== 0) return byRank
  if (a.sequence_no !== null && b.sequence_no !== null) {
    const byDriver = (a.driver?.full_name ?? '').localeCompare(b.driver?.full_name ?? '')
    if (byDriver !== 0) return byDriver
    return a.sequence_no - b.sequence_no
  }
  return a.po_number.localeCompare(b.po_number)
}

/** Share of the day's stops that have been closed out, 0–100. */
export function tripProgress(list: TripList): number {
  return list.stops.length === 0 ? 0 : Math.round((list.closedCount / list.stops.length) * 100)
}

// --- Trips (Maps page) -----------------------------------------------------

/**
 * One delivery day's stops regrouped into per-driver routes for the map. The
 * Collection-side twin is `collectionTrips`, and the two stay parallel.
 *
 * `buildTripLists` above refuses to group by driver, for the good reason that
 * the published list belongs to the day rather than to anyone. This groups by
 * driver precisely because the question has changed — not "how is the day
 * going?" but "where did Marlon's truck actually go?".
 *
 * Ordering prefers `sequence_no`, which the driver's own app assigns at each
 * stop and is therefore the truck's real order. `time_out` is the fallback for
 * rows that predate sequence capture; it agrees with the sequence wherever both
 * exist. Stops nobody has reached have neither, and belong to no trip.
 */
export function deliveryTrips(orders: PurchaseOrder[]): Trip[] {
  const groups = groupByWorkerDay(orders, po => po.driver_id, po => po.scheduled_for)
  const colors = workerColors(groups.map(g => g.workerId))

  return groups.map(({ workerId, day, rows }) => {
    const ordered = [...rows].sort(byRunOrder)
    // The driver's own sequence number is what the paper trip report carries, so
    // show theirs rather than renumbering from the array position — a gap in it
    // is information (a stop that never closed out), not an error.
    const stops = ordered.map((po, i) => deliveryStop(po, po.sequence_no ?? i + 1))
    const cod = ordered.reduce((sum, po) => sum + (po.cod_amount ?? 0), 0)
    const anyCod = ordered.some(po => po.cod)
    const times = ordered.map(po => po.time_out).filter((t): t is string => !!t)
    const plates = [...new Set(ordered.map(po => po.truck_plate).filter(Boolean))]

    return {
      id: `${workerId}|${day}`,
      workerId,
      day,
      workerName: ordered[0].driver?.full_name ?? 'Unknown',
      avatarUrl: ordered[0].driver?.avatar_url ?? null,
      // The plate is how the office identifies a run, so it rides in the role
      // line rather than being dropped for lack of a field of its own.
      workerRole: plates.length > 0 ? `Driver · ${plates.join(', ')}` : 'Driver',
      color: colors.get(workerId) ?? tripColor(0),
      stops,
      located: stops.filter(s => s.lat != null && s.lng != null),
      totalLabel: anyCod ? `${peso(cod)} COD` : 'No COD',
      startedAt: times[0] ?? null,
      endedAt: times[times.length - 1] ?? null,
    }
  })
}

function byRunOrder(a: PurchaseOrder, b: PurchaseOrder): number {
  if (a.sequence_no !== null && b.sequence_no !== null) return a.sequence_no - b.sequence_no
  if (!a.time_out) return 1
  if (!b.time_out) return -1
  return new Date(a.time_out).getTime() - new Date(b.time_out).getTime()
}

const PO_STATUS_LABEL: Record<PurchaseOrder['status'], string> = {
  delivered: 'Delivered',
  failed: 'Failed — backloaded',
  pending: 'Waiting',
}

function deliveryStop(po: PurchaseOrder, sequence: number): TripStop {
  const dwell = dwellMinutes(po)
  const details = [
    { label: 'PO number', value: po.po_number },
    { label: 'Truck', value: po.truck_plate ?? '—' },
    { label: 'Dwell', value: dwell != null ? `${dwell} min` : '—' },
    { label: 'Received by', value: po.receiver_name ?? 'Not given' },
  ]
  if (po.cod) {
    details.push({
      label: 'COD',
      value:
        po.cod_amount != null
          ? `${peso(po.cod_amount)} of ${peso(po.cod_due ?? 0)}`
          : `${peso(po.cod_due ?? 0)} due`,
    })
  }
  if (po.remarks) details.push({ label: 'Remarks', value: po.remarks })

  return {
    id: po.id,
    sequence,
    label: po.client?.company_name ?? 'Unknown customer',
    sublabel: po.area,
    lat: po.gps_lat,
    lng: po.gps_lng,
    at: po.time_out,
    tone: po.status === 'delivered' ? 'done' : po.status === 'failed' ? 'problem' : 'open',
    statusLabel: PO_STATUS_LABEL[po.status],
    amountLabel: po.cod_amount != null ? peso(po.cod_amount) : null,
    missingProof: hasMissingProof(po),
    details,
  }
}
