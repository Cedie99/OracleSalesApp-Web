'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { adminScope, hasWebAccess } from '@/lib/permissions'
import { auditActionModule, type AuditLogInput } from '@/lib/audit/entries'
import type { AdminScope, UserRole } from '@/types'

/**
 * Records one admin action in `admin_audit_logs`.
 *
 * Every web write path calls this AFTER its own write succeeds. Two rules make
 * the whole thing trustworthy, and both live here rather than at the call site:
 *
 *  1. THE ACTOR IS NEVER PASSED IN. It is read from the session cookie on the
 *     server. The browser can choose to lie about what it did, but it cannot
 *     claim to be someone else — and "who" is the only column the log exists
 *     for. (This is also why the table has no INSERT policy: the row goes in on
 *     the service-role key, so nothing reachable from a browser can write one.)
 *
 *  2. IT NEVER THROWS. A failure to log must not fail, or appear to fail, the
 *     admin's actual action — they saved the client, and a broken audit table
 *     must not tell them otherwise. Failures go to the server console, where
 *     they show up in the Vercel log rather than in someone's face.
 *
 * The trade-off in (2) is the honest one for this feature: a missing entry is
 * recoverable (the mutated row is still there), a rolled-back client edit is
 * not. If the log ever needs to be provably complete rather than best-effort,
 * that is a different design — the write has to move into the same transaction
 * as the mutation, which means moving every write path onto RPCs.
 */
export async function recordAuditLog(input: AuditLogInput): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, role, admin_scope')
      .eq('user_id', user.id)
      .single()

    // Server Actions are reachable by direct POST, not only through our own UI
    // (see the warning in Next's mutating-data guide). Everyone who can act on
    // the web is a web role, so anything else calling this is either a bug or
    // someone poking at the endpoint with a mobile account's token — either
    // way it does not belong in the admin history.
    if (!profile || !hasWebAccess(profile.role as UserRole)) return

    const scope = adminScope(profile.role as UserRole, profile.admin_scope as AdminScope | null)

    const { error } = await createAdminClient()
      .from('admin_audit_logs')
      .insert({
        actor_profile_id: profile.id,
        // Snapshotted, not joined — see migration 096.
        actor_name: profile.full_name ?? 'Unknown',
        actor_role: profile.role,
        actor_scope: scope,
        action: input.action,
        // Derived from the catalog, never taken from the caller, so an entry
        // cannot be filed under a module it does not belong to.
        module: auditActionModule(input.action),
        entity_table: input.entityTable ?? null,
        entity_id: input.entityId ?? null,
        entity_label: input.entityLabel ?? null,
        summary: input.summary,
        changes: input.changes ?? [],
        metadata: input.metadata ?? null,
      })

    if (error) {
      console.error('[audit] failed to record %s: %s', input.action, error.message)
    }
  } catch (err) {
    console.error('[audit] failed to record %s:', input.action, err)
  }
}
