/**
 * The account lifecycle: active → inactive → archived.
 *
 * Archived is DERIVED, never stored. It is a pure function of
 * profiles.deactivated_at (migration 095), so there is no column to drift out of
 * sync and no nightly job that can silently stop running — an account becomes
 * archived the moment the clock passes, whether or not anything ran.
 *
 * Archiving hides a user from the Users page and the assignment pickers and
 * nothing else. Their name must still render on last year's meetings,
 * collections and reports; the profile row is never deleted (see the header of
 * migration 095 for why a hard delete is not on the table).
 */

/** Inactive for this long and the account drops off the default Users list. */
export const ARCHIVE_AFTER_DAYS = 365

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type AccountStatus = 'active' | 'inactive' | 'archived'

/** The subset of a profile this module needs — satisfied by Profile and by the Users page row. */
interface AccountLike {
  is_active?: boolean | null
  deactivated_at?: string | null
}

/**
 * `now` is injectable so the rule can be tested at a boundary without freezing
 * the system clock.
 */
export function accountStatus(user: AccountLike, now: number = Date.now()): AccountStatus {
  // Defaults to active: is_active is optional on Profile, and a missing value
  // must never read as "deactivated" and hide a live user.
  if (user.is_active !== false) return 'active'

  // Inactive with no timestamp — a row written before 095, or by a writer that
  // bypassed the trigger. Treat as freshly deactivated rather than archiving an
  // account we cannot date.
  if (!user.deactivated_at) return 'inactive'

  const since = new Date(user.deactivated_at).getTime()
  if (Number.isNaN(since)) return 'inactive'

  return now - since >= ARCHIVE_AFTER_DAYS * MS_PER_DAY ? 'archived' : 'inactive'
}

export function isArchived(user: AccountLike, now?: number): boolean {
  return accountStatus(user, now) === 'archived'
}

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
}

/** e.g. "Inactive since 12 Aug 2025" — the date the archive clock started. */
export function deactivatedSinceLabel(user: AccountLike): string {
  if (!user.deactivated_at) return ''
  const date = new Date(user.deactivated_at)
  if (Number.isNaN(date.getTime())) return ''
  return `Inactive since ${date.toLocaleDateString('en-PH', {
    day: 'numeric', month: 'short', year: 'numeric',
  })}`
}
