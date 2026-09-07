'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { hasWebAccess } from '@/lib/permissions'
import type { UserRole } from '@/types'

/**
 * How many approvals are waiting — as two integers, not two tables.
 *
 * The sidebar renders a count pill on the Approvals row, and it is mounted on
 * every page in the admin layout. It used to get that number by calling
 * `useEditRequests()` and `usePoConfirmations()`, which between them fetch
 * EVERY edit request and EVERY PO confirmation — each with three joins, each
 * including every historically decided row — and re-fetch them on the 30-second
 * live cadence. Two full joined tables, on every page, forever, to render two
 * numbers that are almost always single digits.
 *
 * This is that same question asked properly: `count: 'exact', head: true`
 * sends no rows at all, just the count in a `Content-Range` header.
 *
 * BOTH counts go through this one Server Function rather than one here and one
 * from the browser. The PO half has no choice — migration 039 scopes
 * `po_confirmation_requests` SELECT to the requester and their manager, so an
 * admin's browser query matches zero rows and RLS reports that as an empty set
 * rather than an error (the same trap documented at length in
 * lib/po-confirmation/actions.ts). Given one server round-trip is unavoidable,
 * putting the edit-request count in the same call makes it one round-trip
 * instead of two.
 *
 * Deliberately UNFILTERED by anything but `status = 'pending'`. The Approvals
 * page's own tab count applies that page's search/kind/agent/date filters; the
 * pill is the standing "there is work waiting" signal and must not move when
 * someone types in a search box on another screen.
 */

/**
 * Server Functions are reachable as public endpoints, so the caller is
 * re-authorised here rather than trusted from the component that called it.
 * A third local copy of the check in lib/tag-along/actions.ts and
 * lib/po-confirmation/actions.ts, kept local for the same reason they are:
 * every service-role read states its own authorisation where it can be read
 * beside the query it is guarding.
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
    return 'Not authorised to read approval counts.'
  }
  return null
}

export interface PendingApprovalCounts {
  editRequests: number
  poConfirmations: number
  /** The pill's number — what the sidebar actually renders. */
  total: number
  error: string | null
}

const EMPTY: PendingApprovalCounts = {
  editRequests: 0,
  poConfirmations: 0,
  total: 0,
  error: null,
}

export async function fetchPendingApprovalCounts(): Promise<PendingApprovalCounts> {
  const authError = await requireWebAccess()
  if (authError) return { ...EMPTY, error: authError }

  const supabase = createAdminClient()

  // Independent, so issued together — the sidebar is on the critical path of
  // every page load and these must not serialise.
  const [edits, pos] = await Promise.all([
    supabase
      .from('client_edit_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('po_confirmation_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
  ])

  // A failure on either side returns zero for that half rather than failing the
  // whole call: a pill that under-reports is a great deal better than a sidebar
  // that cannot render. The error still travels so the caller can log it.
  const error = edits.error?.message ?? pos.error?.message ?? null
  const editRequests = edits.count ?? 0
  const poConfirmations = pos.count ?? 0

  return {
    editRequests,
    poConfirmations,
    total: editRequests + poConfirmations,
    error,
  }
}
