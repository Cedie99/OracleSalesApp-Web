import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAuthorizedCronRequest } from '@/lib/cron-secret'

export const dynamic = 'force-dynamic'

/**
 * Row 10: auto-move a client to Lost Opportunity after 6 months of no
 * progress.
 *
 * All of the logic lives in `sweep_lost_opportunities()` (migration 111); this
 * route only authenticates the cron and reports what the function did.
 *
 * WHY IT MOVED. The previous version did the loss as a raw UPDATE on `clients`
 * — status, lost_at, reassignable_at, inactive_reason — and never touched
 * `client_cycles`. That is half a loss. `claim_lost_opportunity()` (037) matches
 * on `client_cycles.end_reason = 'lost'`, so a client lost this way could never
 * be claimed, while mobile's list (which reads `clients`) still advertised it as
 * claimable. 037's diagnosis block falls all the way through for such a row and
 * returns `already_claimed`, i.e. every agent who tried was told "Another agent
 * already claimed this client." 082 owns the real transition and 111 calls it.
 *
 * The selection also moved into SQL, which retires this route's three scaling
 * hazards: an unpaginated read of every active client, a second unpaginated read
 * of their meetings passed back as one `IN` list, and a read-then-write with no
 * transaction around it.
 *
 * SCOPE. 111 sweeps `prospect` and `in_progress` only. The old query had no
 * customer_type filter, so a won account left unvisited for six months was
 * pushed into a pool where another agent could claim it. Losing a real customer
 * stays a human decision (082's meeting outcome, 088's declaration, or an
 * admin).
 *
 * SCHEDULING. Vercel Cron runs in UTC and this is a destructive batch, so the
 * vercel.json entry must resolve to the small hours in Manila (UTC+8, no DST) —
 * see the note on prospect-cleanup, which has the same requirement.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await createAdminClient().rpc('sweep_lost_opportunities')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const result = (data ?? {}) as { swept?: number; ids?: string[] }
  return NextResponse.json({
    ok: true,
    movedToLost: result.swept ?? 0,
    ids: result.ids ?? [],
  })
}
