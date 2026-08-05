'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { hasWebAccess } from '@/lib/permissions'
import type { TagAlongRequest, UserRole } from '@/types'

/**
 * Reading tag-along requests on behalf of an admin.
 *
 * This goes through the service-role client rather than the browser's session,
 * and that is not an optimisation — it is the only way the read returns rows.
 * Migration 019 gave `tag_along_requests` exactly one SELECT policy:
 *
 *     USING (requester_id = current_profile_id() OR invitee_id = current_profile_id())
 *
 * An admin is neither the requester nor the invitee of anything, so a normal
 * client-side query matches zero rows — and RLS denies by returning an empty
 * set, not an error. Every screen built on it would have shown a confident,
 * permanently empty "no tag-alongs" list. (Mobile's Executive Tag-Along Log
 * reads this table unscoped on the assumption of a broad policy that was never
 * created; it is almost certainly empty in production for the same reason.
 * That one is Carter's to fix — flagged, not worked around here.)
 *
 * The alternative was widening RLS with a migration. Service role is the
 * narrower change: it grants nothing to any signed-in user, and this app is
 * already superadmin/admin-only at the route layer.
 */

/**
 * Server Functions are reachable as public endpoints, so the caller is
 * re-authorised here rather than trusted from the page that called it. Mirrors
 * `requireCallerIsSuperadmin` in app/(admin)/users/actions.ts, but admits plain
 * admins too: reading who tagged along is operational visibility, not user
 * management.
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
    return 'Not authorised to read tag-along records.'
  }
  return null
}

interface JoinedProfile {
  full_name: string | null
  role: string | null
}

/** PostgREST returns an embedded to-one as an object, but types it as an array. */
const one = (v: unknown): JoinedProfile | undefined =>
  (Array.isArray(v) ? v[0] : v) as JoinedProfile | undefined

const TAG_ALONG_COLUMNS = `
  id, context, requester_id, invitee_id, invitee_kind,
  related_client_id, related_meeting_id, status,
  created_at, responded_at, updated_at,
  requester:profiles!requester_id ( full_name, role ),
  invitee:profiles!invitee_id ( full_name, role )
`

/**
 * Every tag-along request, newest first, with both participants' names resolved.
 *
 * Unfiltered by design: the table holds one row per companion per record, which
 * is the same order of magnitude as `meetings` itself, and every consumer
 * (Meetings, Maps, Reports) needs a different slice of it. Filtering happens in
 * `lib/tag-along/index.ts` against the already-loaded set.
 */
export async function fetchTagAlongs(): Promise<{
  requests: TagAlongRequest[]
  error: string | null
}> {
  const authError = await requireWebAccess()
  if (authError) return { requests: [], error: authError }

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('tag_along_requests')
    .select(TAG_ALONG_COLUMNS)
    .order('created_at', { ascending: false })

  if (error) return { requests: [], error: error.message }

  const requests = (data ?? []).map(row => {
    const r = row as Record<string, unknown>
    const requester = one(r.requester)
    const invitee = one(r.invitee)
    return {
      ...(r as unknown as TagAlongRequest),
      requester_name: requester?.full_name ?? null,
      invitee_name: invitee?.full_name ?? null,
      invitee_role: (invitee?.role as UserRole | null) ?? null,
    }
  })

  return { requests, error: null }
}
