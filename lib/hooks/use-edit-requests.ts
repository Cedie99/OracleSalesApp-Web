'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { recordAuditLog } from '@/lib/audit/actions'
import type { ClientEditRequest, Client, Profile, ApprovalStatus } from '@/types'

/** Explicit column list — see the note in use-clients.ts for why not `*`. */
const EDIT_REQUEST_COLUMNS = `
  id, client_id, requested_by, changes, status, reviewed_by, reviewed_at, review_note, created_at,
  client:clients!client_id ( id, company_name, customer_type, sales_channel, status ),
  requester:profiles!requested_by ( id, user_id, full_name, role, team_id, avatar_url, created_at ),
  reviewer:profiles!reviewed_by ( id, user_id, full_name, role, team_id, avatar_url, created_at )
`

const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

/**
 * `decide_client_edit_request()` reports refusals as a returned string rather
 * than an error, so each one needs copy an admin can act on. Anything not
 * listed here falls back to showing the raw code — better a code than a
 * swallowed failure.
 */
const DECISION_FAILURE_MESSAGE: Record<string, string> = {
  base_conflict:
    'This client changed since the request was made — the agent should resubmit against the current details.',
  already_decided: 'Someone already reviewed this request.',
  not_found: 'That request no longer exists.',
  role_not_eligible: 'Your account is not permitted to review this request.',
  invalid_decision: 'Unrecognised decision.',
}

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
 * Mobile has since shipped the flow that writes here (ADR-052), so an empty
 * queue is no longer automatically "the true state" the way the 2026-07-24
 * note used to say. It is still often correct, though, and for a reason worth
 * knowing before chasing a wiring bug: only an ALREADY-SET field that changes
 * needs approval. A prospect's first Complete Info fills blank fields, which
 * mobile applies directly and never files a request for
 * (lib/complete-info-branch.ts, 'direct_first_time'). Lifecycle movement —
 * prospect -> in_progress -> new — is server-side triggers (040) and never
 * appears here at all.
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

  /**
   * Approve or reject a request.
   *
   * Goes through `decide_client_edit_request()` (migrations 056/080/102) and
   * NOT a direct UPDATE on the table. That RPC is the only thing that applies
   * an approved request's values onto `public.clients` — no trigger does it —
   * so the direct UPDATE this used to issue flipped the badge to "Approved"
   * and silently dropped the actual edit. It also skipped the reassignment,
   * lost-client and per-field `base_conflict` guards.
   *
   * RLS is not what was stopping it: 009's admin policy is FOR ALL, so the
   * write was permitted. 055 denies managers that same UPDATE precisely so
   * every decision is forced through this function; web was the one caller
   * bypassing it.
   *
   * The RPC signals failure by RETURN VALUE, not by raising — a returned
   * 'base_conflict' arrives with `rpcError == null`. Both have to be checked
   * before this counts as decided, which is also why the audit entry is
   * written after that check rather than after the round-trip.
   */
  const review = useCallback(
    async (id: string, status: Exclude<ApprovalStatus, 'pending'>) => {
      // Captured before the write, because `load()` below replaces the row and
      // the log needs to name what was decided, not what it became.
      const target = requests.find(r => r.id === id)

      const { data: outcome, error: rpcError } = await createClient()
        .rpc('decide_client_edit_request', {
          p_request_id: id,
          p_decision: status,
          // The web page has no note field; managers on mobile supply one.
          p_note: null,
        })

      if (rpcError) return rpcError.message
      if (outcome !== status) {
        // Reload regardless: 'already_decided' means someone else got there
        // first, and the queue is now showing a stale row.
        await load()
        return DECISION_FAILURE_MESSAGE[outcome as string] ?? `Decision failed (${outcome}).`
      }

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
