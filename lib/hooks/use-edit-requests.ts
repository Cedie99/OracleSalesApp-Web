'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { subscribeToNotifications } from '@/lib/realtime/notification-feed'
import { recordAuditLog } from '@/lib/audit/actions'
import type { ClientEditRequest, Client, Profile, ApprovalStatus } from '@/types'

/** Explicit column list — see the note in use-clients.ts for why not `*`. */
const EDIT_REQUEST_COLUMNS = `
  id, client_id, requested_by, changes, status, reviewed_by, reviewed_at, created_at,
  client:clients!client_id ( id, company_name, customer_type, sales_channel, status ),
  requester:profiles!requested_by ( id, user_id, full_name, role, team_id, avatar_url, created_at ),
  reviewer:profiles!reviewed_by ( id, user_id, full_name, role, team_id, avatar_url, created_at )
`

const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

function normalizeRequest(row: Record<string, unknown>): ClientEditRequest {
  return {
    ...(row as unknown as ClientEditRequest),
    changes: (row.changes as ClientEditRequest['changes'] | null) ?? {},
    client: one<Client>(row.client),
    requester: one<Profile>(row.requester),
    reviewer: one<Profile>(row.reviewer),
  }
}

/**
 * Client detail-change requests awaiting review.
 *
 * The table is real but currently empty (0 rows as of 2026-07-24) — mobile has
 * not shipped the flow that writes to it. So the Approvals page, its sidebar
 * badge, and the dashboard's "Pending Approvals" card will all legitimately
 * read zero. That is the true state, not a wiring failure.
 */
export function useEditRequests() {
  const [requests, setRequests] = useState<ClientEditRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('client_edit_requests')
      .select(EDIT_REQUEST_COLUMNS)
      .order('created_at', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setRequests((data ?? []).map(row => normalizeRequest(row as Record<string, unknown>)))
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // Feeds the Approvals count in the sidebar, which is mounted on every page —
  // so like the bell, it refreshes at the fast cadence. Watching `updated_at`
  // rather than `created_at` is deliberate: a second admin approving a request
  // is exactly the change this badge must notice, and that is an UPDATE.
  useAutoRefresh(load, {
    watch: [{ table: 'client_edit_requests' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  /**
   * ...and the arrival of a new request is instant, without a second socket.
   *
   * `client_edit_requests` is not in the realtime publication — `notifications`
   * is the only table that is (083). It does not need to be: inserting a pending
   * request fires `trg_notify_edit_request` in the same transaction, so an
   * `edit_request_submitted` notification is already on its way down the socket
   * the bell is holding open. Hearing it and re-reading costs nothing new.
   *
   * Re-reading rather than trusting the payload is the point — the notification
   * carries a title and a message, not the joined client and requester this
   * queue renders.
   *
   * The other direction, a request being APPROVED, emits no notification (083
   * deliberately only rings for pending ones), so the pill's decrement still
   * comes from the 30-second poll above. That is the right trade: an admin
   * needs to know work arrived, not to watch a colleague's number tick down.
   */
  useEffect(() => {
    return subscribeToNotifications(row => {
      if (row.type === 'edit_request_submitted') void load()
    })
  }, [load])

  /** Approve or reject a request, stamping the reviewer and review time. */
  const review = useCallback(
    async (id: string, status: Exclude<ApprovalStatus, 'pending'>, reviewerProfileId: string | null) => {
      // Captured before the write, because `load()` below replaces the row and
      // the log needs to name what was decided, not what it became.
      const target = requests.find(r => r.id === id)

      const { error: updateError } = await createClient()
        .from('client_edit_requests')
        .update({
          status,
          reviewed_by: reviewerProfileId,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id)

      if (updateError) return updateError.message

      const clientName = target?.client?.company_name ?? 'a client'
      const requester = target?.requester?.full_name
      void recordAuditLog({
        action: status === 'approved' ? 'edit_request.approved' : 'edit_request.rejected',
        entityTable: 'client_edit_requests',
        entityId: id,
        entityLabel: clientName,
        summary:
          `${status === 'approved' ? 'Approved' : 'Rejected'} the edit request for ${clientName}` +
          (requester ? ` from ${requester}` : ''),
        // The request's own `changes` are already a field-level before/after —
        // what the agent asked to change. Rendering them as the entry's diff
        // means the log shows what was actually approved, not just that
        // something was.
        changes: Object.entries(target?.changes ?? {}).map(([field, value]) => ({
          field,
          label: field.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()),
          from: value.old == null || value.old === '' ? null : String(value.old),
          to: value.new == null || value.new === '' ? null : String(value.new),
        })),
      })

      await load()
      return null
    },
    [load, requests]
  )

  return { requests, loading, error, refresh, review }
}
