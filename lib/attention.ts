import { addMonths, differenceInCalendarDays } from 'date-fns'
import type { Client, Meeting } from '@/types'
import type { ClientQuotaUsage } from '@/lib/cutoff'

/**
 * Accounts that need somebody to do something, and why.
 *
 * This replaced the Maps "visit quota" lens, which reported one fact — whether
 * a client had gone past its per-cutoff visit cap — and reported it as a whole
 * tab. That was a colour scheme, not a lens: its pins were the same pins the
 * Visited list already plotted, only recoloured, and `components/reports/
 * cutoff-quota-report.tsx` already covers the same ledger per team, per agent
 * and per client, with an Excel export the map could never match.
 *
 * The cap is kept here as ONE signal among three. The other two are the client
 * lifecycle's own clocks, agreed with the client at the 2026-07-03 meeting and
 * recorded as ADR-006 / F-001 in the vault:
 *
 *   1-month info deadline → auto-delete if never completed
 *   2-month meeting window from completion (reporting-only, no auto-consequence)
 *   6-month max lifespan from completion → Lost Opportunity
 *   manager-approved edit to New exits the lifecycle
 *
 * The 1-month deadline is deliberately NOT a signal here: `app/api/cron/
 * prospect-cleanup/route.ts` sweeps those daily, so a row would clear itself
 * within a day of appearing and only ever describe work nobody has to do.
 *
 * Nothing in this file invents a duration. The team's own 4-month follow-up
 * rule was explicitly discarded by the client (vault Decisions.md, ADR-006's
 * rejected alternatives), so a "stale follow-up" signal keyed off
 * `MeetingOutcome.follow_up` would be enforcing a rule that was struck down —
 * and the schema has no next-meeting date to key it off anyway.
 */

/** Two months from info completion, per ADR-006. Reporting-only by design. */
export const MEETING_WINDOW_MONTHS = 2

/** Six months from info completion, after which the account is Lost. */
export const MAX_LIFESPAN_MONTHS = 6

/**
 * How far ahead of the 6-month wall an account starts asking for attention.
 *
 * A month, so the warning arrives one whole cutoff before the deadline — a
 * supervisor reviewing at payroll time sees it while there are still two review
 * cycles left to act in, rather than the morning it expires.
 */
export const EXPIRY_WARNING_DAYS = 30

export type AttentionKind = 'expiring' | 'over_limit' | 'window_lapsed'

/**
 * Worst first, and "worst" means most preventable rather than most broken.
 *
 * `expiring` outranks `over_limit` because it is the only one still in the
 * future: an account past its cap has already had the visits and nothing done
 * today un-does them, while an account approaching its 6-month wall can still
 * be saved. `window_lapsed` ranks last because ADR-006 attaches no consequence
 * to it at all — it is a prompt, not a problem.
 */
export const ATTENTION_RANK: Record<AttentionKind, number> = {
  expiring: 0,
  over_limit: 1,
  window_lapsed: 2,
}

export interface AttentionFlag {
  kind: AttentionKind
  /**
   * Days until the deadline, negative once it has passed. Null for `over_limit`,
   * which is a count against a ceiling and has no clock.
   */
  daysLeft: number | null
  /** The fact, in one line, for the list row and the pin popup. */
  detail: string
}

/**
 * Stages the ADR-006 clocks still run on.
 *
 * `new` and `existing` are excluded because reaching them IS the exit: rule 4
 * says a manager-approved edit to New leaves the lifecycle, and the Jan-1
 * rollover then moves New → Existing as a normal, healthy end state. Warning
 * that an established customer is about to expire would be reporting a rule
 * that does not apply to it.
 *
 * `status` is checked too: an account already Lost or deleted cannot be warned
 * about becoming Lost.
 */
export function inLifecycle(client: Client): boolean {
  if (client.status !== 'active') return false
  return client.customer_type === 'prospect' || client.customer_type === 'in_progress'
}

/**
 * Both lifecycle clocks anchor on info completion, never on creation.
 *
 * Null until Phase B of mobile's two-phase create lands (migration 013), and a
 * client that never completes is the 1-month delete job's problem rather than
 * this module's — so no anchor means no lifecycle flags, not a fallback to
 * `created_at`.
 */
function lifecycleAnchor(client: Client): Date | null {
  if (!client.details_completed_at) return null
  const anchor = new Date(client.details_completed_at)
  return Number.isNaN(anchor.getTime()) ? null : anchor
}

/**
 * Everything wrong with one account, worst first.
 *
 * `usage` is the server's attribution ledger folded per client — web never
 * recounts meetings against the cap, for the reason set out at the top of
 * lib/cutoff.ts. `meetings` is only ever read for existence, never counted.
 *
 * `now` is a parameter rather than a `new Date()` inside, so a caller renders
 * one consistent clock across a whole list and tests can pin it.
 */
export function clientAttention(
  client: Client,
  meetings: Meeting[],
  usage: ClientQuotaUsage | null,
  now: Date
): AttentionFlag[] {
  const flags: AttentionFlag[] = []

  // --- The cutoff cap -------------------------------------------------------
  // Keyed on `overCap`, never on `used > cap`: the server allocates slots up to
  // the cap and classifies the rest as over_cap, so `used` can never exceed
  // `cap` and the comparison would silently never fire. See quotaState().
  if (usage && usage.overCap > 0) {
    flags.push({
      kind: 'over_limit',
      daysLeft: null,
      detail: `${usage.used + usage.overCap} visits this cutoff · ${usage.overCap} past the limit of ${usage.cap}`,
    })
  }

  // --- The ADR-006 lifecycle clocks -----------------------------------------
  const anchor = inLifecycle(client) ? lifecycleAnchor(client) : null
  if (anchor) {
    const expiresOn = addMonths(anchor, MAX_LIFESPAN_MONTHS)
    const daysToExpiry = differenceInCalendarDays(expiresOn, now)
    if (daysToExpiry <= EXPIRY_WARNING_DAYS) {
      flags.push({
        kind: 'expiring',
        daysLeft: daysToExpiry,
        detail:
          daysToExpiry < 0
            ? `${MAX_LIFESPAN_MONTHS} months past info completion — due to become a Lost Opportunity`
            : daysToExpiry === 0
              ? 'Becomes a Lost Opportunity today'
              : `Becomes a Lost Opportunity in ${daysToExpiry} ${daysToExpiry === 1 ? 'day' : 'days'}`,
      })
    }

    // The 2-month window asks only whether a meeting HAPPENED, not whether it
    // went well: ADR-006's "meeting-first exception counts as the required
    // meeting" means one recorded before info completion satisfies it too. So
    // any meeting at all, at any date, with any outcome, clears this.
    if (meetings.length === 0) {
      const windowEnds = addMonths(anchor, MEETING_WINDOW_MONTHS)
      const daysToWindow = differenceInCalendarDays(windowEnds, now)
      if (daysToWindow < 0) {
        flags.push({
          kind: 'window_lapsed',
          daysLeft: daysToWindow,
          detail: `No meeting in the ${MEETING_WINDOW_MONTHS}-month window after info completion`,
        })
      }
    }
  }

  return flags.sort(
    (a, b) =>
      ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] ||
      (a.daysLeft ?? 0) - (b.daysLeft ?? 0)
  )
}

/**
 * Order for the list: by the worst flag each account carries, then by how far
 * past its deadline it is, then alphabetically so the order is stable between
 * renders when nothing distinguishes two rows.
 */
export function compareAttention(
  a: { client: Client; flags: AttentionFlag[] },
  b: { client: Client; flags: AttentionFlag[] }
): number {
  const aTop = a.flags[0]
  const bTop = b.flags[0]
  if (!aTop || !bTop) return aTop ? -1 : bTop ? 1 : 0
  return (
    ATTENTION_RANK[aTop.kind] - ATTENTION_RANK[bTop.kind] ||
    (aTop.daysLeft ?? 0) - (bTop.daysLeft ?? 0) ||
    b.flags.length - a.flags.length ||
    a.client.company_name.localeCompare(b.client.company_name)
  )
}
