/**
 * Collection-module helpers shared by the Collection Admin page and its
 * components (F-007).
 *
 * The mental model these encode: the admin publishes **one collection list per
 * day** — every store, with what it owes — and collectors on mobile work that
 * shared list down. No store is assigned to a particular collector; whoever
 * gets there collects it, and their name lands on the record at that moment.
 * Everything below either builds a day's list or reports on one.
 */
import type { CollectionVisit, Remittance } from '@/types'
import { peso } from '@/lib/money'
import { PAYMENT_METHOD_LABEL } from '@/lib/status-styles'
import { groupByWorkerDay, tripColor, workerColors, type Trip, type TripStop } from '@/lib/trips'

/** Remitted minus collected. Negative means the collector handed over less. */
export function remittanceVariance(r: Remittance): number {
  return r.amount_remitted - r.amount_collected
}

/**
 * The camera captures a collected visit must carry, in the order the collector
 * takes them. Counter used to be a third entry here; the 2026-07-26 wireframe
 * change turned it into a payment method whose proof rides on the shared
 * payment photo, so there are two captures now, not three.
 */
export const VISIT_PROOFS = [
  { key: 'payment_photo_url', label: 'Payment photo' },
  { key: 'delivery_receipt_photo_url', label: 'Delivery receipt' },
] as const satisfies readonly { key: keyof CollectionVisit; label: string }[]

export interface ProofState {
  label: string
  url: string | null
}

/**
 * Proof state for a visit. Only meaningful once the visit is collected — the
 * phone blocks "✓ Collected" until both exist, so a gap here means the record
 * either predates the rule or arrived through a path that skipped it. Pending
 * and rescheduled visits legitimately have none.
 */
export function visitProofs(visit: CollectionVisit): ProofState[] {
  return VISIT_PROOFS.map(p => ({ label: p.label, url: visit[p.key] as string | null }))
}

/** True when a collected visit is missing at least one required capture. */
export function hasMissingProof(visit: CollectionVisit): boolean {
  return visit.status === 'collected' && visitProofs(visit).some(p => !p.url)
}

/** A collector who worked at least one store on a given day's list. */
export interface DayContributor {
  id: string
  name: string
  avatarUrl: string | null
  /** Stores this collector closed out on the day. */
  count: number
  /** What they brought in, which is what their remittance is reconciled against. */
  collected: number
}

/** One day's published collection list — every store, whoever ends up working it. */
export interface CollectionDay {
  /** `yyyy-MM-dd` — stable across re-renders. */
  id: string
  /** Midnight of the collection day, for sorting and formatting. */
  day: Date
  stores: CollectionVisit[]
  /** Stores closed out, either collected or rescheduled. */
  workedCount: number
  pendingCount: number
  /** Sum of what the office expects across the whole list. */
  totalDue: number
  /** Sum of what actually came in. */
  totalCollected: number
  /** Stores still open, in peso terms — what the day has left to bring in. */
  outstanding: number
  /**
   * Who has worked the list so far. Derived after the fact from the stores that
   * were actually collected — nobody is assigned to a day up front.
   */
  contributors: DayContributor[]
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * Group visits into daily lists, newest day first.
 *
 * Deliberately NOT grouped by collector. The admin publishes one list per day
 * and any collector can work any store on it, so a per-collector board would be
 * inventing a routing structure the product doesn't have — and would strand
 * every pending store, which belongs to nobody yet, in an "unassigned" bucket.
 */
export function buildDays(visits: CollectionVisit[]): CollectionDay[] {
  const byDay = new Map<string, CollectionVisit[]>()

  for (const visit of visits) {
    const key = dayKey(visit.scheduled_for)
    const existing = byDay.get(key)
    if (existing) existing.push(visit)
    else byDay.set(key, [visit])
  }

  const days: CollectionDay[] = []

  for (const [id, stores] of byDay) {
    const worked = stores.filter(s => s.status !== 'pending')
    days.push({
      id,
      day: new Date(id + 'T00:00:00'),
      // Collected first, then rescheduled, then the stores still to do — the
      // same order the collector's own list decrements in.
      stores: [...stores].sort((a, b) => STORE_ORDER[a.status] - STORE_ORDER[b.status]),
      workedCount: worked.length,
      pendingCount: stores.length - worked.length,
      totalDue: stores.reduce((sum, s) => sum + s.amount_due, 0),
      totalCollected: stores.reduce((sum, s) => sum + (s.amount_collected ?? 0), 0),
      outstanding: stores
        .filter(s => s.status === 'pending')
        .reduce((sum, s) => sum + s.amount_due, 0),
      contributors: buildContributors(stores),
    })
  }

  return days.sort((a, b) => b.day.getTime() - a.day.getTime())
}

function buildContributors(stores: CollectionVisit[]): DayContributor[] {
  const byCollector = new Map<string, DayContributor>()

  for (const store of stores) {
    // Pending stores have no collector yet — that is the point of the pool.
    if (!store.collector_id) continue
    const existing = byCollector.get(store.collector_id)
    if (existing) {
      existing.count += 1
      existing.collected += store.amount_collected ?? 0
    } else {
      byCollector.set(store.collector_id, {
        id: store.collector_id,
        name: store.collector?.full_name ?? 'Unknown',
        avatarUrl: store.collector?.avatar_url ?? null,
        count: 1,
        collected: store.amount_collected ?? 0,
      })
    }
  }

  return [...byCollector.values()].sort((a, b) => b.collected - a.collected)
}

const STORE_ORDER: Record<CollectionVisit['status'], number> = {
  collected: 0,
  rescheduled: 1,
  pending: 2,
}

/** Share of the day's stores that have been closed out, 0–100. */
export function dayProgress(day: CollectionDay): number {
  return day.stores.length === 0 ? 0 : Math.round((day.workedCount / day.stores.length) * 100)
}

// --- Trips (Maps page) -----------------------------------------------------

/**
 * One day's stores regrouped into per-collector routes for the map.
 *
 * `buildDays` above answers "how is this day's list going?" and deliberately
 * refuses to group by collector. This answers a different question — "where did
 * Ramon actually go today?" — which only makes sense per person, so it groups
 * exactly the way the day board does not.
 *
 * Order comes from `visited_at`, not from anything the office set: the daily
 * list is a shared pool with no routing in it, so the sequence a collector
 * worked is only knowable after they worked it. Stores still pending have no
 * collector and no time, and belong to no trip at all.
 *
 * Stops are numbered from their position in this one group, so every collector's
 * every day starts again at #1 — the same rule `deliveryTrips` follows. See
 * `TripStop.sequence` for why neither module may show a stored counter.
 */
export function collectionTrips(visits: CollectionVisit[]): Trip[] {
  const groups = groupByWorkerDay(visits, v => v.collector_id, v => v.scheduled_for)
  const colors = workerColors(groups.map(g => g.workerId))

  return groups.map(({ workerId, day, rows }) => {
    const ordered = [...rows].sort(byVisitedAt)
    // Position in this collector's own day — resets with every group.
    const stops = ordered.map((visit, i) => collectionStop(visit, i + 1))
    const collected = ordered.reduce((sum, s) => sum + (s.amount_collected ?? 0), 0)
    const times = ordered.map(s => s.visited_at).filter((t): t is string => !!t)

    return {
      id: `${workerId}|${day}`,
      workerId,
      day,
      workerName: ordered[0].collector?.full_name ?? 'Unknown',
      avatarUrl: ordered[0].collector?.avatar_url ?? null,
      workerRole: 'Collector',
      color: colors.get(workerId) ?? tripColor(0),
      stops,
      located: stops.filter(s => s.lat != null && s.lng != null),
      totalLabel: `${peso(collected)} collected`,
      startedAt: times[0] ?? null,
      endedAt: times[times.length - 1] ?? null,
    }
  })
}

/** Undated stores sort last; they can't be placed in a sequence. */
function byVisitedAt(a: CollectionVisit, b: CollectionVisit): number {
  if (!a.visited_at) return 1
  if (!b.visited_at) return -1
  return new Date(a.visited_at).getTime() - new Date(b.visited_at).getTime()
}

const VISIT_STATUS_LABEL: Record<CollectionVisit['status'], string> = {
  collected: 'Collected',
  rescheduled: 'Rescheduled',
  pending: 'Pending',
}

function collectionStop(visit: CollectionVisit, sequence: number): TripStop {
  const details = [
    { label: 'Amount due', value: peso(visit.amount_due) },
    {
      label: 'Collected',
      value: visit.amount_collected != null ? peso(visit.amount_collected) : '—',
    },
    {
      label: 'Method',
      value: visit.payment_method ? PAYMENT_METHOD_LABEL[visit.payment_method] : '—',
    },
  ]
  if (visit.remarks) details.push({ label: 'Remarks', value: visit.remarks })

  return {
    id: visit.id,
    sequence,
    label: visit.client?.company_name ?? 'Unknown store',
    sublabel: visit.client?.office_address ?? '',
    lat: visit.gps_lat,
    lng: visit.gps_lng,
    at: visit.visited_at,
    // A reschedule is a legitimate outcome, not a failure — but it is the one
    // the admin scans for, so it gets the attention tone.
    tone: visit.status === 'collected' ? 'done' : visit.status === 'rescheduled' ? 'problem' : 'open',
    statusLabel: VISIT_STATUS_LABEL[visit.status],
    amountLabel: visit.amount_collected != null ? peso(visit.amount_collected) : null,
    missingProof: hasMissingProof(visit),
    details,
  }
}
