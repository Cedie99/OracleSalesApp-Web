/**
 * Per-person stop numbering for the Collection and Delivery **day boards**.
 *
 * The office reads a day card and asks "which of Marisa's stops was that?" —
 * a question the flat list can't answer, because the list is published per day
 * and mixes everyone's work together. This numbers each row within its own
 * person's set of stops for that day, so a card shows Marisa ①②③ and Ben ①②
 * side by side and every run restarts at ① the next morning.
 *
 * ⚠️ **This is NOT the trip numbering in `lib/trips.ts`, and the two disagree
 * on purpose.** A trip is a route that was actually driven, so it numbers only
 * worked stops in worked order. The board is a checklist, so it also numbers the
 * stop a person is currently *en route* to — which has no worked position at
 * all, and lands last in their run because it hasn't happened yet. Expect a
 * pending ④ on the board that the map does not draw. If the two ever need to
 * agree, the board is the one that changes: the map's numbering carries a
 * factual claim about where somebody went.
 *
 * ### Who a row belongs to
 *
 * In order of precedence:
 *
 *  1. **Whoever worked it** (`collector_id` / `driver_id`), written at the
 *     outcome. This wins even when a claim is still on the row, because claims
 *     deliberately survive completion as history (migration 046) — and a stop
 *     released mid-run can be finished by somebody else, in which case the
 *     person who did the work is the honest owner.
 *  2. **Whoever claimed it**, on a row still pending. A claim is a hard lock, so
 *     this is as close to ownership as an unworked stop ever gets.
 *  3. **Nobody.** An unclaimed pending stop is in the shared pool — that is the
 *     whole point of publishing one list per day — so it gets no number and no
 *     colour. Inventing an owner for it would draw the per-collector assignment
 *     structure that both `buildDays` and `buildTripLists` deliberately refuse
 *     to imply.
 */

/** One row's position inside its owner's set of stops for the day. */
export interface WorkerStopNumber {
  workerId: string
  workerName: string | null
  /** 1-based, resets per person per day. */
  sequence: number
  /** How many stops this person holds on the day, for "2 of 4" style copy. */
  total: number
  /**
   * True when the position came from a live claim rather than worked history —
   * i.e. they are on their way, not finished. Callers render these differently:
   * a number that hasn't happened yet shouldn't look like one that has.
   */
  fromClaim: boolean
}

/**
 * How to read the fields off a row. Collection and Delivery keep different
 * column names for identical concepts, so the rule lives here once and each
 * module supplies its own nouns — the same split `groupByWorkerDay` uses.
 */
export interface BoardRowAccessors<T> {
  id: (row: T) => string
  /** Who closed the row out. Null while nobody has worked it. */
  workedBy: (row: T) => string | null
  workedByName: (row: T) => string | null
  /** Who is en route. Only meaningful while the row is still pending. */
  claimedBy: (row: T) => string | null
  claimedByName: (row: T) => string | null
  /** When it closed out — the ordering signal inside one person's run. */
  at: (row: T) => string | null
}

/**
 * Number one day's rows, keyed by row id.
 *
 * ⚠️ Pass **a single day's** rows. Numbering has to restart every morning, and
 * this function has no notion of a date — feeding it a week would run one
 * person's count straight through it. Both callers do the day grouping first.
 *
 * Rows with no owner are simply absent from the returned map, so a caller that
 * looks up an unclaimed pending stop gets `undefined` and renders nothing.
 */
export function numberStopsByWorker<T>(
  rows: T[],
  get: BoardRowAccessors<T>,
): Map<string, WorkerStopNumber> {
  interface Owned { row: T; fromClaim: boolean }
  const byWorker = new Map<string, { name: string | null; owned: Owned[] }>()

  for (const row of rows) {
    const worked = get.workedBy(row)
    // Precedence, per the note above: the person who did the work outranks the
    // person who reserved it, because a claim can outlive whoever honoured it.
    const workerId = worked ?? get.claimedBy(row)
    if (!workerId) continue

    const fromClaim = !worked
    const name = (fromClaim ? get.claimedByName(row) : get.workedByName(row)) ?? null

    const bucket = byWorker.get(workerId)
    if (bucket) {
      bucket.owned.push({ row, fromClaim })
      // A worked row carries the better name: `claimed_by_name` is a snapshot
      // taken at claim time, while the worked name comes from the joined profile.
      if (!fromClaim && name) bucket.name = name
    } else {
      byWorker.set(workerId, { name, owned: [{ row, fromClaim }] })
    }
  }

  const numbers = new Map<string, WorkerStopNumber>()

  for (const [workerId, { name, owned }] of byWorker) {
    const ordered = [...owned].sort((a, b) => {
      // Everything worked comes before the stop they are still driving to —
      // it has no position in the run yet, so it can only be last.
      if (a.fromClaim !== b.fromClaim) return a.fromClaim ? 1 : -1
      const at = get.at(a.row)
      const bt = get.at(b.row)
      // A worked row with no timestamp sorts last among worked rows rather than
      // first: an absent time is unknown, and unknown shouldn't claim ①.
      if (!at && !bt) return 0
      if (!at) return 1
      if (!bt) return -1
      return at.localeCompare(bt)
    })

    ordered.forEach(({ row, fromClaim }, i) => {
      numbers.set(get.id(row), {
        workerId,
        workerName: name,
        sequence: i + 1,
        total: ordered.length,
        fromClaim,
      })
    })
  }

  return numbers
}

/**
 * Every person with stops on the board, across all days — the input to
 * `workerColors`.
 *
 * Collected board-wide rather than per day so one person keeps one colour on
 * every card. Computing it per day would recolour somebody the moment a filter
 * dropped a day they happened to sort before.
 */
export function boardWorkerIds(
  dayNumbers: Map<string, WorkerStopNumber>[],
): string[] {
  return dayNumbers.flatMap(numbers => [...numbers.values()].map(n => n.workerId))
}
