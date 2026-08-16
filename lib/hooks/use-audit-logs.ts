'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { adminScope, hasWebAccess } from '@/lib/permissions'
import type { AdminAuditLog, AdminScope, AuditChange, NotificationModule, Profile, UserRole } from '@/types'

/** Explicit column list — see the note in use-clients.ts for why not `*`. */
const AUDIT_LOG_COLUMNS = `
  id, actor_profile_id, actor_name, actor_role, actor_scope, action, module,
  entity_table, entity_id, entity_label, summary, changes, metadata, occurred_at,
  actor:profiles!actor_profile_id ( id, user_id, full_name, role, avatar_url, created_at )
`

/**
 * How many entries one load pulls.
 *
 * Unlike every other table in this app, the log only grows — it is never
 * archived and has no delete path (migration 096). Loading it whole would get
 * slower every week and eventually stall the page, so the query is capped and
 * the UI says so when the cap is hit. Narrowing a filter is what gets you
 * further back, which is also how anyone actually uses an audit log: they are
 * looking for a person, a day, or a kind of action, not reading it end to end.
 */
export const AUDIT_LOG_LIMIT = 500

function normalizeLog(row: Record<string, unknown>): AdminAuditLog {
  const actor = Array.isArray(row.actor) ? row.actor[0] : row.actor

  return {
    ...(row as unknown as AdminAuditLog),
    // jsonb comes back parsed, but a row written before the column had its
    // default — or one hand-inserted in the SQL editor — can still be null, and
    // the detail view maps over this unconditionally.
    changes: (row.changes as AuditChange[] | null) ?? [],
    actor: (actor as Profile | null) ?? undefined,
  }
}

export interface AuditLogFilters {
  /** 'all' means every module. */
  module: NotificationModule | 'all'
  /** A single `<entity>.<verb>`, or 'all'. */
  action: string | 'all'
  /** A profile id, or 'all'. */
  actor: string | 'all'
  /** Inclusive `yyyy-MM-dd` bounds, or '' for open-ended. */
  from: string
  to: string
}

export const EMPTY_AUDIT_FILTERS: AuditLogFilters = {
  module: 'all', action: 'all', actor: 'all', from: '', to: '',
}

interface UseAuditLogsResult {
  logs: AdminAuditLog[]
  loading: boolean
  error: string
  /** True when the query hit AUDIT_LOG_LIMIT, so older entries exist beyond it. */
  truncated: boolean
  refresh: () => Promise<void>
}

/**
 * The admin activity log, newest first.
 *
 * Filtering happens in the query rather than in the page, because with a capped
 * fetch the two are not equivalent: filtering client-side would search only the
 * most recent 500 rows, so picking a person and a date last month would show
 * nothing while insisting there was nothing to show. Free-text search is the
 * one exception and stays in the page — it runs across summary, actor, and
 * target, which is not a shape PostgREST expresses without a real text index.
 */
export function useAuditLogs(filters: AuditLogFilters): UseAuditLogsResult {
  const [logs, setLogs] = useState<AdminAuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)

  const { module, action, actor, from, to } = filters

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()

    let query = supabase
      .from('admin_audit_logs')
      .select(AUDIT_LOG_COLUMNS)
      .order('occurred_at', { ascending: false })
      .limit(AUDIT_LOG_LIMIT)

    if (module !== 'all') query = query.eq('module', module)
    if (action !== 'all') query = query.eq('action', action)
    if (actor !== 'all') query = query.eq('actor_profile_id', actor)
    if (from) query = query.gte('occurred_at', `${from}T00:00:00`)
    // Through the END of the chosen day — a bare date would compare against
    // midnight and silently drop everything that happened on it.
    if (to) query = query.lte('occurred_at', `${to}T23:59:59.999`)

    const { data, error: queryError } = await query

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      const rows = (data ?? []).map(row => normalizeLog(row as Record<string, unknown>))
      setLogs(rows)
      setTruncated(rows.length === AUDIT_LOG_LIMIT)
    }
    setLoading(false)
  }, [module, action, actor, from, to])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // Deliberately probed unfiltered, unlike useMeetings: the page's filters are a
  // view onto one table, and any new entry can change what a filtered view
  // should show (a fresh row that matches, or one that pushes the 500-row cap
  // past an older one). Over-refreshing a log page costs a query; missing an
  // entry costs the answer to "who did this, and when".
  useAutoRefresh(load, { watch: [{ table: 'admin_audit_logs', column: 'occurred_at' }] })

  return { logs, loading, error, truncated, refresh }
}

/**
 * The people who can appear as an actor, for the actor filter.
 *
 * Read from `profiles` and not derived from the loaded entries, which is the
 * obvious shortcut and a broken one: the entries are already narrowed by the
 * active filters, so selecting a person would collapse the dropdown to that one
 * person and strand the user with no way back to anyone else.
 *
 * Deactivated accounts are kept. `recordAuditLog` only ever writes a web role,
 * so this is the complete set of possible actors — including the ones whose
 * access has since been revoked, which are precisely the accounts someone
 * opening an audit log tends to be looking for.
 */
export interface AuditActor {
  id: string
  name: string
  role: UserRole
  /** Narrowed scope for a plain admin; 'all' for everyone else. */
  scope: AdminScope
}

export function useAuditActors(): { actors: AuditActor[]; loading: boolean } {
  const [actors, setActors] = useState<AuditActor[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const supabase = createClient()

    supabase
      .from('profiles')
      // role and admin_scope come along so the picker can group by what someone
      // IS — a Collection Admin's entries sit under a Collection Admin heading
      // — rather than presenting one undifferentiated list of names.
      .select('id, full_name, role, admin_scope')
      .order('full_name')
      .then(({ data }) => {
        if (!active) return
        setActors(
          (data ?? [])
            .filter(p => hasWebAccess(p.role as UserRole))
            .map(p => ({
              id: p.id as string,
              name: (p.full_name as string) ?? 'Unknown',
              role: p.role as UserRole,
              scope: adminScope(p.role as UserRole, p.admin_scope as AdminScope | null),
            }))
        )
        setLoading(false)
      })

    return () => { active = false }
  }, [])

  return { actors, loading }
}
