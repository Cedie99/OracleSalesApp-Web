'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchPoConfirmations } from '@/lib/po-confirmation/actions'
import { recordAuditLog } from '@/lib/audit/actions'
import type { PoConfirmationRequest, ApprovalStatus } from '@/types'

const EMPTY: PoConfirmationRequest[] = []

/**
 * `decide_po_confirmation()` reports refusals in its jsonb `code` rather than
 * by raising, so each one needs copy an admin can act on. Mirrors the map in
 * use-edit-requests.ts.
 */
const DECISION_FAILURE_MESSAGE: Record<string, string> = {
  already_decided: 'A manager already reviewed this PO.',
  not_found: 'That PO request no longer exists.',
  role_not_eligible: 'Your account is not permitted to review this PO.',
  invalid_decision: 'Unrecognised decision.',
}

/**
 * PO confirmation requests — the last gate on `in_progress -> new`.
 *
 * Reads and writes take different paths, because 039 gates them separately:
 *
 *   - READ goes through a Server Function, because RLS hides this table from
 *     admins entirely (039's SELECT policy covers only the requester and their
 *     manager). See the header of lib/po-confirmation/actions.ts.
 *   - DECIDE goes through `decide_po_confirmation()` from the browser, because
 *     that RPC is SECURITY DEFINER — RLS is not consulted — and migration 103
 *     added the admin/superadmin arm to its internal eligibility check.
 *
 * Managers approve these on mobile; admins are the fallback when a manager
 * cannot act.
 */
export function usePoConfirmations() {
  const [requests, setRequests] = useState<PoConfirmationRequest[]>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const { requests: rows, error: fetchError } = await fetchPoConfirmations()
    if (fetchError) {
      setError(fetchError)
      setRequests(EMPTY)
    } else {
      setError('')
      setRequests(rows)
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
   * Approve or reject a PO confirmation.
   *
   * The RPC returns `{ok, code}` and does NOT raise on refusal, so a failed
   * decision arrives with `rpcError == null` — both have to be checked before
   * this counts as decided. Approving is what unblocks the client: the
   * `promote_on_po_confirmed` trigger (040) re-runs
   * `advance_in_progress_to_new()` in the same transaction.
   */
  const decide = useCallback(
    async (id: string, status: Exclude<ApprovalStatus, 'pending'>) => {
      // Captured before the write, because `load()` below replaces the row.
      const target = requests.find(r => r.id === id)

      const { data, error: rpcError } = await createClient()
        .rpc('decide_po_confirmation', {
          p_request_id: id,
          p_decision: status,
          p_note: null,
        })

      if (rpcError) return rpcError.message

      const result = data as { ok?: boolean; code?: string } | null
      if (!result?.ok) {
        // Reload regardless: 'already_decided' means a manager got there first
        // and this queue is now showing a stale row.
        await load()
        return DECISION_FAILURE_MESSAGE[result?.code ?? ''] ?? `Decision failed (${result?.code}).`
      }

      const clientName = target?.company_name ?? 'a client'
      const requester = target?.requester_name
      void recordAuditLog({
        action: status === 'approved' ? 'po_confirmation.approved' : 'po_confirmation.rejected',
        entityTable: 'po_confirmation_requests',
        entityId: id,
        entityLabel: clientName,
        summary:
          `${status === 'approved' ? 'Approved' : 'Rejected'} the PO confirmation for ${clientName}` +
          (requester ? ` from ${requester}` : '') +
          ' — admin decision, normally the assigned manager\'s call',
        // A PO has no field diff the way an edit request does, so the status
        // transition IS the change worth recording.
        changes: [{
          field: 'status',
          label: 'Status',
          from: 'Pending',
          to: status === 'approved' ? 'Approved' : 'Rejected',
        }],
        // Enough to find the exact PO photo and cycle this decision was made
        // against, without the log having to join anything later.
        metadata: {
          client_id: target?.client_id ?? null,
          cycle_id: target?.cycle_id ?? null,
          meeting_id: target?.meeting_id ?? null,
          po_photo_path: target?.po_photo_path ?? null,
          requester_id: target?.requester_id ?? null,
        },
      })

      await load()
      return null
    },
    [load, requests]
  )

  return { requests, loading, error, refresh, decide }
}
