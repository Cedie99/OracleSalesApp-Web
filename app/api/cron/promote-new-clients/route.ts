import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAuthorizedCronRequest } from '@/lib/cron-secret'

export const dynamic = 'force-dynamic'

/**
 * Row 11: Jan 1 at 12:01 AM, batch-convert "New" clients to "Existing".
 *
 * Scoped to `status: 'active'` — lost/deleted clients keep whatever
 * customer_type they had when archived; this job is about the active
 * roster's year-over-year label, not rewriting history.
 *
 * SCHEDULING. Vercel Cron runs in UTC; the business rule is stated in Manila
 * time (vault Context.md: "After December 31, 11:59 PM each year ... run on
 * January 1"). Manila is UTC+8 year-round — no DST — so 12:01 AM Jan 1 Manila
 * is 4:01 PM Dec 31 UTC, and vercel.json carries `1 16 31 12 *`. That entry
 * naming December is correct and deliberate: do not "fix" it back to a January
 * day-of-month, which would fire at 8:01 AM Manila instead.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('clients')
    .update({ customer_type: 'existing', updated_at: new Date().toISOString() })
    .eq('customer_type', 'new')
    .eq('status', 'active')
    .select('id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, promoted: data?.length ?? 0, ids: data?.map(c => c.id) ?? [] })
}
