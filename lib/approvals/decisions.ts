'use client'

import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { FIELD_LABEL } from '@/lib/status-styles'
import { recordAuditLog } from '@/lib/audit/actions'
import type { ApprovalStatus, ClientEditRequest, PoConfirmationRequest } from '@/types'

/**
 * Deciding an approval, without holding the whole queue in memory.
 *
 * These were methods on `useEditRequests` / `usePoConfirmations`, which had to
 * fetch EVERY request just so a decision could look its own row up for the
 * audit entry. With the queue paged server-side (migration 137) that lookup is
 * impossible and unnecessary: the button lives on a card that already holds the
 * record, so the record is passed in.
 *
 * Both paths go through their RPC rather than a direct UPDATE, and both RPCs
 * report refusal by RETURN VALUE rather than by raising — so `rpcError == null`
 * is not success and both have to be checked.
 */

/**
 * `decide_client_edit_request()` reports refusals as a returned string, so each
 * one needs copy an admin can act on. Anything unlisted falls back to showing
 * the raw code — better a code than a swallowed failure.
 */
const EDIT_FAILURE_MESSAGE: Record<string, string> = {
  base_conflict:
    'This client changed since the request was made — the agent should resubmit against the current details.',
  already_decided: 'Someone already reviewed this request.',
  not_found: 'That request no longer exists.',
  role_not_eligible: 'Your account is not permitted to review this request.',
  invalid_decision: 'Unrecognised decision.',
}

const PO_FAILURE_MESSAGE: Record<string, string> = {
  already_decided: 'A manager already reviewed this PO.',
  not_found: 'That PO request no longer exists.',
  role_not_eligible: 'Your account is not permitted to review this PO.',
  invalid_decision: 'Unrecognised decision.',
}

/**
 * Turn a flat `base_conflict` into the sentence that names what happened.
 *
 * The RPC returns one code for three unrelated conditions — reassignment, a
 * lost client, a per-field mismatch — and it has to keep doing that: mobile
 * validates the code against a hardcoded list and THROWS on anything else, so
 * widening the code set is a cross-repo break. Migration 128 added
 * `explain_client_edit_conflict()` instead, read-only and additive, asked only
 * on the failure path so no successful decision pays for it.
 */
async function explainConflict(id: string): Promise<string> {
  const { data, error } = await createClient()
    .rpc('explain_client_edit_conflict', { p_request_id: id })

  if (error || !data || typeof data !== 'object') return EDIT_FAILURE_MESSAGE.base_conflict

  const detail = data as {
    reason?: string
    current_agent_name?: string | null
    po_decided_at?: string | null
    field?: string
    current_value?: string | null
  }

  switch (detail.reason) {
    case 'reassigned':
      return detail.current_agent_name
        ? `This client now belongs to ${detail.current_agent_name} — the request was filed against the previous agent's assignment.`
        : 'This client was reassigned to another agent since the request was made.'
    case 'lost':
      return 'This client has been marked as lost, so their details can no longer be changed.'
    case 'stage_already_new':
      // No date when the client reached 'new' through 040's tag-along path
      // rather than a PO — the sentence has to read correctly either way.
      return detail.po_decided_at
        ? `This client was already promoted to New by a PO approved on ${format(new Date(detail.po_decided_at), 'MMM d')} — reject this request if it is no longer needed.`
        : 'This client has already closed a deal and is now New — reject this request if it is no longer needed.'
    case 'field_changed':
      return `${FIELD_LABEL[detail.field ?? ''] ?? detail.field} is now ${detail.current_value ?? 'blank'}, which is not what this request was filed against — the agent should resubmit.`
    case 'none':
      return 'That conflict has cleared — try approving again.'
    default:
      return EDIT_FAILURE_MESSAGE.base_conflict
  }
}

/** What an audit entry needs about an edit request, and nothing more. */
export interface EditDecisionTarget {
  id: string
  clientName: string | null
  requesterName: string | null
  changes: ClientEditRequest['changes']
}

export function editTargetOf(request: ClientEditRequest): EditDecisionTarget {
  return {
    id: request.id,
    clientName: request.client?.company_name ?? null,
    requesterName: request.requester?.full_name ?? null,
    changes: request.changes,
  }
}

/**
 * The request's own `changes` are already a field-level before/after — what the
 * agent asked to change — so rendering them as the entry's diff means the log
 * shows what was actually approved, not merely that something was.
 */
function auditChanges(changes: ClientEditRequest['changes']) {
  return Object.entries(changes ?? {}).map(([field, value]) => ({
    field,
    label: field.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()),
    from: value.old == null || value.old === '' ? null : String(value.old),
    to: value.new == null || value.new === '' ? null : String(value.new),
  }))
}

/**
 * Approve or reject one client-edit request.
 *
 * Goes through `decide_client_edit_request()` (056/080/102) and NOT a direct
 * UPDATE. That RPC is the only thing that applies an approved request's values
 * onto `public.clients` — no trigger does it — so the direct UPDATE this once
 * issued flipped the badge to "Approved" and silently dropped the actual edit.
 * It also skipped the reassignment, lost-client and per-field guards.
 *
 * No reviewer id is passed: the RPC stamps `reviewed_by` from
 * `current_profile_id()` server-side.
 *
 * @returns null on success, or a message to show the admin.
 */
export async function reviewEditRequest(
  target: EditDecisionTarget,
  status: Exclude<ApprovalStatus, 'pending'>,
): Promise<string | null> {
  const { data: outcome, error: rpcError } = await createClient()
    .rpc('decide_client_edit_request', {
      p_request_id: target.id,
      p_decision: status,
      // The web page has no note field; managers supply one on mobile.
      p_note: null,
    })

  if (rpcError) return rpcError.message
  if (outcome !== status) {
    if (outcome === 'base_conflict') return explainConflict(target.id)
    return EDIT_FAILURE_MESSAGE[outcome as string] ?? `Decision failed (${outcome}).`
  }

  const clientName = target.clientName ?? 'a client'
  void recordAuditLog({
    action: status === 'approved' ? 'edit_request.approved' : 'edit_request.rejected',
    entityTable: 'client_edit_requests',
    entityId: target.id,
    entityLabel: clientName,
    summary:
      `${status === 'approved' ? 'Approved' : 'Rejected'} the edit request for ${clientName}` +
      (target.requesterName ? ` from ${target.requesterName}` : ''),
    changes: auditChanges(target.changes),
  })

  return null
}

/**
 * Approve several requests in one gesture.
 *
 * There is no bulk RPC and this deliberately does not add one:
 * `decide_client_edit_request()` re-checks the base-conflict, reassignment and
 * lost-client guards per request against the CURRENT client row (102), and
 * those checks are the whole reason a stale request must not be applied. A
 * set-based RPC would either duplicate that logic or skip it. So a bulk approve
 * is N independent decisions, each of which can refuse on its own — which makes
 * partial success the normal outcome, not an edge case.
 *
 * Sequential rather than Promise.all: each call takes a `for update` row lock
 * and then writes `public.clients`, and two requests from the same agent
 * frequently target the SAME client. Firing those concurrently has them racing
 * to read the base value the other is about to change, turning a clean
 * 'base_conflict' into an order-dependent one. Bulk sizes here are a screen's
 * worth of cards, so the round-trips are affordable.
 */
export async function reviewEditRequests(
  targets: EditDecisionTarget[],
): Promise<{ approved: string[]; failures: { id: string; name: string; message: string }[] }> {
  const approved: string[] = []
  const failures: { id: string; name: string; message: string }[] = []

  for (const target of targets) {
    const message = await reviewEditRequest(target, 'approved')
    if (message) {
      // The bulk toast de-duplicates by message, so a specific reason here is
      // what lets "3 skipped" resolve into three distinct causes rather than
      // one generic line repeated.
      failures.push({ id: target.id, name: target.clientName ?? 'a client', message })
      continue
    }
    approved.push(target.id)
  }

  return { approved, failures }
}

/**
 * Approve or reject a PO confirmation.
 *
 * The RPC returns `{ok, code}` and does NOT raise on refusal, so a failed
 * decision arrives with `rpcError == null`. Approving is what unblocks the
 * client: `promote_on_po_confirmed` (040) re-runs `advance_in_progress_to_new()`
 * in the same transaction.
 */
export async function decidePoConfirmation(
  target: PoConfirmationRequest,
  status: Exclude<ApprovalStatus, 'pending'>,
): Promise<string | null> {
  const { data, error: rpcError } = await createClient()
    .rpc('decide_po_confirmation', {
      p_request_id: target.id,
      p_decision: status,
      p_note: null,
    })

  if (rpcError) return rpcError.message

  const result = data as { ok?: boolean; code?: string } | null
  if (!result?.ok) {
    return PO_FAILURE_MESSAGE[result?.code ?? ''] ?? `Decision failed (${result?.code}).`
  }

  const clientName = target.company_name ?? 'a client'
  void recordAuditLog({
    action: status === 'approved' ? 'po_confirmation.approved' : 'po_confirmation.rejected',
    entityTable: 'po_confirmation_requests',
    entityId: target.id,
    entityLabel: clientName,
    summary:
      `${status === 'approved' ? 'Approved' : 'Rejected'} the PO confirmation for ${clientName}` +
      (target.requester_name ? ` from ${target.requester_name}` : '') +
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
      client_id: target.client_id ?? null,
      cycle_id: target.cycle_id ?? null,
      meeting_id: target.meeting_id ?? null,
      po_photo_path: target.po_photo_path ?? null,
      requester_id: target.requester_id ?? null,
    },
  })

  return null
}
