/**
 * Claim helpers shared by Collection and Delivery (migration 046).
 *
 * A claim is the "On the way" state: a collector or driver has said they are
 * heading to this stop. It is a **hard lock** — nobody else may work it — and
 * each person may hold **exactly one** at a time. That one-claim limit is what
 * keeps a hard lock from turning the published day list into back-door
 * assignment: you cannot reserve the profitable half of a list, so a claim means
 * only "I am driving to this one stop right now".
 *
 * Claims never expire. They are cleared by the claimer, or by an admin from the
 * web board — which is what `isStaleClaim` below exists to make visible.
 */

/** The claim fields, identical on `CollectionVisit` and `PurchaseOrder`. */
export interface Claimable {
  claimed_by: string | null
  claimed_at: string | null
  claimed_by_name: string | null
  scheduled_for: string
  status: string
}

/**
 * Someone is en route. Note this stays true on a worked row — a claim survives
 * completion as history, and the database frees the person's slot via an index
 * scoped to pending rows rather than by clearing the column.
 */
export function isClaimed(row: Claimable): boolean {
  return row.claimed_by != null
}

/** Held right now, i.e. locking the stop AND occupying the claimer's one slot. */
export function isActiveClaim(row: Claimable): boolean {
  return row.claimed_by != null && row.status === 'pending'
}

/**
 * A claim still holding a stop whose day has already passed.
 *
 * The business rule is whole-day only — a stop is worked, rescheduled or failed
 * on its own day — so in principle this cannot happen. In practice nothing
 * enforces it: there is no scheduled job anywhere in the migrations that closes
 * out a day, so a stop claimed at 4pm and never worked stays `pending` with the
 * claim on it. Because claims never expire and each person may hold only one,
 * that collector cannot take anything the next morning until an admin clears it.
 *
 * Hence this flag: the admin has the power to fix it, so the board has to make
 * it visible rather than leave them to notice.
 */
export function isStaleClaim(row: Claimable): boolean {
  if (!isActiveClaim(row)) return false
  const day = new Date(row.scheduled_for)
  const today = new Date()
  // Compare calendar days, not instants — a claim made this morning on today's
  // list is not stale at 11pm.
  return day.setHours(0, 0, 0, 0) < today.setHours(0, 0, 0, 0)
}

/**
 * How many of these are stuck behind a stale claim.
 *
 * Exists because a stale claim is, by definition, on a day the admin has already
 * stopped looking at — the boards sort newest first, so the one row that needs
 * acting on is the one furthest from the top. A count on the day header drags it
 * back into view.
 */
export function staleClaimCount(rows: Claimable[]): number {
  return rows.filter(isStaleClaim).length
}

/** "12m" / "3h" / "2d" — how long the stop has been held. */
export function claimAge(row: Claimable, now: Date = new Date()): string | null {
  if (!row.claimed_at) return null
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(row.claimed_at).getTime()) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
