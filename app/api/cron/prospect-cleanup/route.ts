import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAuthorizedCronRequest } from '@/lib/cron-secret'

export const dynamic = 'force-dynamic'

/**
 * Row 9: auto-delete a prospect if its info wasn't filled within 1 month.
 *
 * "Delete" here means `status: 'deleted'` (soft), not a row DELETE — clients
 * can already carry that status (see types/index.ts ClientStatus), a hard
 * delete would risk orphaning any meetings already logged against the client,
 * and soft-delete keeps the action reversible.
 *
 * `details_deadline_at` is exactly the 1-month clock mobile sets when a
 * client is created bare-bones in the field; it goes null once details are
 * completed (see the field's doc comment in types/index.ts). So a prospect is
 * overdue when the deadline has passed and details still aren't done.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('clients')
    .update({
      status: 'deleted',
      inactive_reason: 'Auto-deleted: prospect details not completed within 1 month',
      updated_at: now,
    })
    .eq('customer_type', 'prospect')
    .neq('status', 'deleted')
    .is('details_completed_at', null)
    .not('details_deadline_at', 'is', null)
    .lt('details_deadline_at', now)
    .select('id, company_name')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort: the deletion above already succeeded, so a failure here
  // shouldn't read as the job having failed — it only means the admin bell
  // won't show this batch. See migration 047 for the notifications table.
  let notificationError: string | undefined
  if (data && data.length > 0) {
    const { error: notifyError } = await supabase.from('notifications').insert(
      data.map(c => ({
        type: 'prospect_auto_deleted',
        title: 'Prospect auto-deleted',
        message: `${c.company_name} was automatically deleted — prospect details weren't completed within 1 month.`,
        client_id: c.id,
      })),
    )
    if (notifyError) notificationError = notifyError.message
  }

  return NextResponse.json({
    ok: true,
    deleted: data?.length ?? 0,
    ids: data?.map(c => c.id) ?? [],
    ...(notificationError && { notificationError }),
  })
}
