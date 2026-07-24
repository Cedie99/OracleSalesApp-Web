'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
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

  /** Approve or reject a request, stamping the reviewer and review time. */
  const review = useCallback(
    async (id: string, status: Exclude<ApprovalStatus, 'pending'>, reviewerProfileId: string | null) => {
      const { error: updateError } = await createClient()
        .from('client_edit_requests')
        .update({
          status,
          reviewed_by: reviewerProfileId,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id)

      if (updateError) return updateError.message
      await load()
      return null
    },
    [load]
  )

  return { requests, loading, error, refresh, review }
}
