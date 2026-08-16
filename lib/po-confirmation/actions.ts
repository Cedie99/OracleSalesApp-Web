'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { hasWebAccess } from '@/lib/permissions'
import type { PoConfirmationRequest, CustomerType, MeetingOutcome, UserRole } from '@/types'

/**
 * Reading PO confirmation requests on behalf of an admin.
 *
 * Same shape, and the same reason, as lib/tag-along/actions.ts: the service
 * role is not an optimisation here, it is the only way the read returns rows.
 * Migration 039 gave `po_confirmation_requests` exactly one SELECT policy:
 *
 *     USING (requester_id = current_profile_id()
 *            OR is_manager_of_profile(requester_id))
 *
 * An admin is neither the requester nor a team-scoped sales_manager of one, so
 * a browser-side query matches zero rows — and RLS denies by returning an empty
 * set, not an error. That is exactly the reported symptom: a client sitting at
 * In Progress with its PO pending on the manager's phone, and an admin looking
 * at a confidently empty Approvals page. The notification bell even deep-links
 * `po_confirmation_request` to /approvals (components/header.tsx), so the
 * admin was being sent to a page that structurally could not show it.
 *
 * As in the tag-along case, widening RLS was the alternative and service role
 * is the narrower change: it grants nothing to any signed-in user, and this app
 * is superadmin/admin-only at the route layer.
 *
 * READ-ONLY on purpose. `decide_po_confirmation()` (039) gates on
 * `is_manager_of_profile()`, and 039's own comment — "Decisions go through the
 * RPC below only" — is the discipline that keeps one owner per decision.
 * Managers decide on mobile; web shows admins what is being waited on.
 */

/**
 * Server Functions are reachable as public endpoints, so the caller is
 * re-authorised here rather than trusted from the page that called it.
 */
async function requireWebAccess(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return 'Not authenticated.'

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()

  if (!hasWebAccess(profile?.role as UserRole | undefined)) {
    return 'Not authorised to read PO confirmation records.'
  }
  return null
}

interface JoinedProfile {
  full_name: string | null
  role?: string | null
  team_id?: string | null
}

interface JoinedClient {
  company_name: string | null
  customer_type: string | null
  office_address: string | null
}

/**
 * The close-deal meeting the PO came out of. Mobile's manager screen prints the
 * raw `meeting_id` UUID here; a date, outcome and who was met is the same
 * reference in a form an admin can actually check against.
 */
interface JoinedMeeting {
  meeting_date: string | null
  outcome: string | null
  contact_person: string | null
}

/** PostgREST returns an embedded to-one as an object, but types it as an array. */
const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

const PO_COLUMNS = `
  id, client_id, cycle_id, meeting_id, requester_id, po_photo_path,
  status, decided_by, decided_at, decision_note, created_at, updated_at,
  requester:profiles!requester_id ( full_name, role, team_id ),
  decider:profiles!decided_by ( full_name, role ),
  client:clients!client_id ( company_name, customer_type, office_address ),
  meeting:meetings!meeting_id ( meeting_date, outcome, contact_person )
`

/**
 * Every PO confirmation request, newest first, with the requesting agent and
 * the client resolved.
 *
 * Unfiltered by status for the same reason the tag-along fetch is: the caller
 * decides the slice. The Approvals page wants the pending ones; an audit view
 * would want the decided ones.
 */
export async function fetchPoConfirmations(): Promise<{
  requests: PoConfirmationRequest[]
  error: string | null
}> {
  const authError = await requireWebAccess()
  if (authError) return { requests: [], error: authError }

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('po_confirmation_requests')
    .select(PO_COLUMNS)
    .order('created_at', { ascending: false })

  if (error) return { requests: [], error: error.message }

  const requests = (data ?? []).map(row => {
    const r = row as Record<string, unknown>
    const requester = one<JoinedProfile>(r.requester)
    const decider = one<JoinedProfile>(r.decider)
    const client = one<JoinedClient>(r.client)
    const meeting = one<JoinedMeeting>(r.meeting)
    return {
      ...(r as unknown as PoConfirmationRequest),
      requester_name: requester?.full_name ?? null,
      requester_role: (requester?.role as UserRole | null) ?? null,
      // Lets the Approvals page group the requester picker by team, the same
      // way Clock Records and Dashboard group theirs.
      requester_team_id: requester?.team_id ?? null,
      // Who actually decided it, resolved here rather than left as a UUID.
      // This is the ONLY cross-platform record of the decider: a manager
      // approving on mobile writes `decided_by` but never reaches
      // admin_audit_logs, which is web-only by design (see lib/audit/actions.ts,
      // which drops anything without hasWebAccess).
      decider_name: decider?.full_name ?? null,
      decider_role: (decider?.role as UserRole | null) ?? null,
      company_name: client?.company_name ?? null,
      customer_type: (client?.customer_type as CustomerType | null) ?? null,
      office_address: client?.office_address ?? null,
      meeting_date: meeting?.meeting_date ?? null,
      meeting_outcome: (meeting?.outcome as MeetingOutcome | null) ?? null,
      meeting_contact_person: meeting?.contact_person ?? null,
    }
  })

  return { requests, error: null }
}
