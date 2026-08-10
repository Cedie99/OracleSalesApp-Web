import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAuthorizedCronRequest } from '@/lib/cron-secret'
import { reassignableFrom } from '@/lib/lost-opportunity'

export const dynamic = 'force-dynamic'

const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6

/**
 * Row 10: auto-move a client to Lost Opportunity after 6 months of no
 * progress.
 *
 * The schema has no "last activity" timestamp on `clients` — the existing
 * progress indicator (lib/client-progress.ts) is a binary flag with no time
 * dimension, so it can't answer "how long since." A meeting is the only
 * activity signal this app records, so "no progress" is read here as: no
 * meeting logged in the last 6 months, falling back to `created_at` for a
 * client that never had one.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const cutoff = Date.now() - SIX_MONTHS_MS

  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('id, created_at')
    .eq('status', 'active')

  if (clientsError) {
    return NextResponse.json({ error: clientsError.message }, { status: 500 })
  }
  if (!clients || clients.length === 0) {
    return NextResponse.json({ ok: true, movedToLost: 0, ids: [] })
  }

  const { data: meetings, error: meetingsError } = await supabase
    .from('meetings')
    .select('client_id, meeting_date')
    .in('client_id', clients.map(c => c.id))

  if (meetingsError) {
    return NextResponse.json({ error: meetingsError.message }, { status: 500 })
  }

  const lastActivity = new Map<string, number>()
  for (const m of meetings ?? []) {
    const t = new Date(m.meeting_date).getTime()
    if (t > (lastActivity.get(m.client_id) ?? 0)) lastActivity.set(m.client_id, t)
  }

  const staleIds = clients
    .filter(c => (lastActivity.get(c.id) ?? new Date(c.created_at).getTime()) < cutoff)
    .map(c => c.id)

  if (staleIds.length === 0) {
    return NextResponse.json({ ok: true, movedToLost: 0, ids: [] })
  }

  const now = new Date()
  const { data: updated, error: updateError } = await supabase
    .from('clients')
    .update({
      status: 'lost',
      lost_at: now.toISOString(),
      // Same one-month cooling-off the manual "mark lost" flow uses (see
      // handleEdit in app/(admin)/clients/page.tsx) — one rule either way.
      // Belt-and-braces: this is an UPDATE, so handle_lost_opportunity() fires
      // and overwrites the value anyway. Sending the right one keeps the two
      // from silently disagreeing if that trigger is ever dropped.
      reassignable_at: reassignableFrom(now).toISOString(),
      inactive_reason: 'Auto-lost: no meeting activity for 6+ months',
      updated_at: now.toISOString(),
    })
    .in('id', staleIds)
    .select('id')

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, movedToLost: updated?.length ?? 0, ids: updated?.map(c => c.id) ?? [] })
}
