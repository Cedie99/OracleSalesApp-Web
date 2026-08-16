import type { AuditChange, NotificationModule } from '@/types'

/**
 * The catalog of admin actions the web app logs.
 *
 * This is the list to check when you add a write path: if the new action is not
 * here, it is almost certainly not being logged either. The database stores
 * `action` as free text (migration 096) precisely so adding a row here is the
 * only step — no migration, no coordination with the mobile repo.
 *
 * `module` decides which lens the entry files under and how it is tinted; it
 * matches notifications.module, where 'system' means "not any one business
 * function" — user administration and the quota/cutoff settings.
 */
export const AUDIT_ACTIONS = {
  // --- Sales ---------------------------------------------------------------
  'client.created': { label: 'Created client', module: 'sales' },
  'client.updated': { label: 'Edited client', module: 'sales' },
  'client.marked_lost': { label: 'Marked as lost opportunity', module: 'sales' },
  'client.reinstated': { label: 'Reinstated lost client', module: 'sales' },
  'client.reassigned': { label: 'Reassigned client', module: 'sales' },
  'edit_request.approved': { label: 'Approved edit request', module: 'sales' },
  'edit_request.rejected': { label: 'Rejected edit request', module: 'sales' },
  // Normally a manager's call on mobile; an admin deciding one here is the
  // fallback path, so it is worth having in the history explicitly.
  'po_confirmation.approved': { label: 'Approved PO confirmation', module: 'sales' },
  'po_confirmation.rejected': { label: 'Rejected PO confirmation', module: 'sales' },

  // --- Collection ----------------------------------------------------------
  'collection_visit.listed': { label: 'Listed store for collection', module: 'collection' },
  'collection_visit.listed_additional': { label: 'Listed additional store', module: 'collection' },
  'collection_visit.removed': { label: 'Removed store from list', module: 'collection' },
  'collection_visit.claim_released': { label: 'Released collector claim', module: 'collection' },
  'remittance.status_changed': { label: 'Reconciled remittance', module: 'collection' },

  // --- Delivery ------------------------------------------------------------
  'purchase_order.listed': { label: 'Listed purchase order', module: 'delivery' },
  'purchase_order.removed': { label: 'Removed purchase order', module: 'delivery' },
  'purchase_order.claim_released': { label: 'Released driver claim', module: 'delivery' },
  'cod_remittance.status_changed': { label: 'Reconciled COD remittance', module: 'delivery' },

  // --- User administration (superadmin only, but logged like everything else)
  'user.created': { label: 'Created user', module: 'system' },
  'user.updated': { label: 'Edited user', module: 'system' },
  'user.activated': { label: 'Activated account', module: 'system' },
  'user.deactivated': { label: 'Deactivated account', module: 'system' },
  'user.password_reset': { label: 'Reset password', module: 'system' },
  'user.avatar_updated': { label: 'Changed profile photo', module: 'system' },
  'user.avatar_removed': { label: 'Removed profile photo', module: 'system' },
  'team.created': { label: 'Created team', module: 'system' },

  // --- Settings ------------------------------------------------------------
  'cutoff_period.created': { label: 'Created cutoff period', module: 'system' },
  'cutoff_period.status_changed': { label: 'Changed cutoff status', module: 'system' },
  'holiday.created': { label: 'Added holiday', module: 'system' },
  'holiday.removed': { label: 'Removed holiday', module: 'system' },
  'standing_targets.applied': { label: 'Applied standing targets', module: 'system' },
} as const satisfies Record<string, { label: string; module: NotificationModule }>

export type KnownAuditAction = keyof typeof AUDIT_ACTIONS

/**
 * How an action reads in the log.
 *
 * Falls back to a humanised form of the raw string for the same reason
 * `roleLabel` does: this app is one of two writing to a shared database, and an
 * entry from a build that knows about an action this one does not must render
 * as readable text, never as a blank cell or a crash.
 */
export function auditActionLabel(action: string): string {
  const known = AUDIT_ACTIONS[action as KnownAuditAction]
  if (known) return known.label
  return action
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** The module an action files under, for entries written before/after this build. */
export function auditActionModule(action: string): NotificationModule {
  return AUDIT_ACTIONS[action as KnownAuditAction]?.module ?? 'system'
}

/** Every known action, grouped by module, for the log page's filter. */
export function auditActionsByModule(): Record<NotificationModule, { action: string; label: string }[]> {
  const grouped: Record<NotificationModule, { action: string; label: string }[]> = {
    sales: [], collection: [], delivery: [], system: [],
  }
  for (const [action, { label, module }] of Object.entries(AUDIT_ACTIONS)) {
    grouped[module as NotificationModule].push({ action, label })
  }
  return grouped
}

/**
 * What a call site hands to `recordAuditLog`.
 *
 * Note what is NOT here: the actor and the module. The actor is resolved from
 * the session inside the action — a caller must never be able to name who an
 * entry belongs to — and the module is derived from `action` through the
 * catalog above, so an entry cannot be filed under the wrong lens.
 *
 * It lives in this module rather than beside the action because a 'use server'
 * file's exports are all treated as callable endpoints.
 */
export interface AuditLogInput {
  action: KnownAuditAction
  /** The table the target lives in — 'clients', 'profiles', 'collection_visits'. */
  entityTable?: string
  entityId?: string | null
  /** How the target should read: a company name, a PO number, a person's name. */
  entityLabel?: string | null
  /** One sentence, already composed. This is the line the log shows. */
  summary: string
  changes?: AuditChange[]
  metadata?: Record<string, unknown> | null
}

// --- Building the field diff ------------------------------------------------

/**
 * One field to watch, and how to render its value for a human.
 *
 * `format` exists because raw column values are unreadable in a log: a status
 * is 'in_progress', an agent is a UUID, an amount is a bare number. The log is
 * a reading surface, so the formatting happens once at write time and is stored
 * — an entry must not start reading differently because a label map changed six
 * months later.
 */
export interface AuditField<T> {
  field: keyof T & string
  label: string
  format?: (value: unknown) => string | null
}

/** Default rendering for a value with no `format` — enough for text and numbers. */
function defaultFormat(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

/**
 * The formatted differences between two versions of a row.
 *
 * Comparison is done on the FORMATTED values, not the raw ones, so a change
 * nobody can see is not a change worth logging — `null` -> `''` on a nullable
 * text column is the common case, and it would otherwise fill the log with
 * entries reading "Contact position: — → —".
 */
export function buildChanges<T extends Record<string, unknown>>(
  before: Partial<T> | null | undefined,
  after: Partial<T>,
  fields: AuditField<T>[]
): AuditChange[] {
  const changes: AuditChange[] = []

  for (const { field, label, format } of fields) {
    const render = format ?? defaultFormat
    const from = before ? render(before[field]) : null
    const to = render(after[field])
    if (from === to) continue
    changes.push({ field, label, from, to })
  }

  return changes
}

/**
 * A single before/after pair, for actions where the "row" is one value — a
 * remittance status, an account's active flag.
 */
export function singleChange(
  field: string,
  label: string,
  from: string | null,
  to: string | null
): AuditChange[] {
  return from === to ? [] : [{ field, label, from, to }]
}
