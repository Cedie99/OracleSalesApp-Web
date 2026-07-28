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
 * Vercel Cron schedules run in UTC, so the vercel.json entry for this route
 * (`1 0 1 1 *`) fires at 00:01 UTC on Jan 1, not 12:01 AM in the app's local
 * timezone — adjust the hour there if that drift matters.
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
