/**
 * Read every row of a query whose result can exceed PostgREST's row ceiling.
 *
 * Supabase caps a single response at `db-max-rows` (1,000 on this project) and
 * signals it by simply returning fewer rows — no error, no truncation flag. A
 * caller that does not page therefore looks correct right up until the table
 * grows past the cap, then silently starts lying: "1000 of 1000 clients" on a
 * table holding 3,139. The bulk client import made that reachable in one
 * upload, so every unbounded read has to page.
 *
 * The cap applies to a set-returning RPC exactly as it does to a table read,
 * so `.rpc()` callers need this too.
 *
 * IMPORTANT: the query must carry a total order. `.range()` paging re-runs the
 * query per page, and Postgres may return tied rows in a different order each
 * time, so a page boundary that falls inside a tie can repeat one row and drop
 * another. Ordering by a timestamp alone is not enough — a bulk insert stamps
 * every row in a statement with the same `now()`. Add a unique tiebreaker
 * (`id`) to whatever the display order is.
 */

/** PostgREST's `db-max-rows` on this project. */
export const SUPABASE_PAGE_SIZE = 1000

interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

/**
 * @param page Runs one page. Receives an inclusive `[from, to]` row range to
 *   hand to `.range()`, and must apply a totally-ordered sort.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await page(from, from + SUPABASE_PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const batch = data ?? []
    rows.push(...batch)
    // A short page means the server ran out of rows, not out of allowance.
    if (batch.length < SUPABASE_PAGE_SIZE) return rows
  }
}
