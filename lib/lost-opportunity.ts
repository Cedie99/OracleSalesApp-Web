import { addMonths } from 'date-fns'

/**
 * The Lost Opportunity cooling-off period — **one calendar month**, not 14 days
 * and not 30 days.
 *
 * History, because the old value is still scattered through this repo's git
 * log: 14 days was the original rule (`handle_lost_opportunity()` in migration
 * 001, and ADR-018 point 7, which leaned on it to keep a lost company's name
 * blocked for the duplicate check). ADR-035 (2026-07-25) replaced it with one
 * calendar month, and migration 036 applied that to the live database on
 * 2026-07-27 — the trigger expression plus a backfill of both `clients` and
 * `client_cycles`. Web never followed, so every surface here kept telling
 * admins "14 days" about rows the database had already recomputed to a month.
 *
 * A CALENDAR month, deliberately: migration 036 uses `interval '1 month'`, so
 * a client lost on Jan 31 is reassignable Feb 28, not Mar 2. `addMonths` has
 * the same clamping behaviour, which is why the arithmetic below is not
 * `now + 30 * 86400 * 1000`.
 *
 * The DATABASE is authoritative for the stored value: `handle_lost_opportunity()`
 * is a BEFORE UPDATE trigger that overwrites `reassignable_at` on the
 * active -> lost transition regardless of what the client sent. What lives here
 * is web's copy of the same rule, for the UI copy that explains the wait and for
 * the write paths that stamp the column on rows the trigger does not cover
 * (an INSERT that arrives already-lost, and a re-save of an already-lost row
 * that somehow has no timestamp).
 */
export const REASSIGN_COOLDOWN_LABEL = '1 month'

/** When a client lost at `lostAt` becomes claimable by a different agent. */
export function reassignableFrom(lostAt: Date): Date {
  return addMonths(lostAt, 1)
}
