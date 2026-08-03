import type { CutoffAttribution, CutoffPeriod, MeetingCutoffAttribution } from '@/types'

/**
 * Cutoff/quota helpers.
 *
 * Everything here is pure and reads from what the server already decided
 * (migrations 057-060). Web deliberately does NOT recompute attribution from
 * `meetings`: the ledger is server-authoritative, written inside the meeting
 * insert transaction, and any second opinion computed here would eventually
 * disagree with the number mobile shows the agent.
 *
 * That is a real constraint, not a preference. An earlier version of this file
 * derived periods from admin-set anchor days and counted meetings by date; both
 * are gone because the database now owns both questions.
 */

/** How a client stands against its per-period meeting cap. */
export type QuotaState = 'exempt' | 'under' | 'at' | 'over'

/** Attribution values that consumed one of a client's slots. */
export const SLOT_CONSUMING: CutoffAttribution[] = ['counted']

/**
 * Attribution values that count toward an AGENT's period target.
 *
 * Wider than the per-client pool on purpose (contract O-3): a prospect meeting
 * consumes no client slot but is still work the agent did, so it counts here.
 * Only `over_cap` is excluded from the target.
 */
export const TARGET_CONTRIBUTING: CutoffAttribution[] = ['counted', 'excluded_uncapped']

/**
 * Today as 'YYYY-MM-DD' in the VIEWER's timezone, comparable against the
 * starts_on/ends_on DATE columns as plain strings.
 *
 * Local rather than UTC because a cutoff boundary is a local-midnight event: at
 * 08:00 Manila on the 16th, UTC still says the 15th, which would show yesterday's
 * period as the live one for the first eight hours of every cutoff.
 */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

/**
 * The period actually running today.
 *
 * Both conditions matter and neither alone is enough. Status alone matches every
 * period generated ahead of time (see `generatePeriods`), and dates alone would
 * match a closed or superseded row. This mirrors migration 059's own lookup, so
 * what an admin reads as live is what the server will attribute a meeting to.
 */
export function activePeriod(
  periods: CutoffPeriod[],
  today: Date = new Date()
): CutoffPeriod | null {
  const day = localIso(today)
  return (
    periods
      .filter(p => p.status === 'active' && p.starts_on <= day && day <= p.ends_on)
      // 059 breaks its own tie with `order by starts_on desc`. Matched exactly
      // rather than trusting the non-overlap constraint to make ties impossible.
      .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0] ?? null
  )
}

/**
 * Periods an admin can review, newest first.
 *
 * Includes closed and superseded ones: the whole point of stepping back through
 * periods is to review a cutoff that has already ended. Excluded are drafts and
 * periods that have not started, for the same reason — neither can have an
 * attributed meeting, so they would read as an empty cutoff rather than as one
 * that has not happened. Without the date test a year of generated periods would
 * sit in front of the current one and the stepper would open on an empty future.
 */
export function reviewablePeriods(
  periods: CutoffPeriod[],
  today: Date = new Date()
): CutoffPeriod[] {
  const day = localIso(today)
  return periods
    .filter(p => p.status !== 'draft' && p.starts_on <= day)
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))
}

/** Where a period sits relative to today. */
export type PeriodPhase = 'ended' | 'current' | 'upcoming'

/**
 * A period's phase, from its DATES rather than its status.
 *
 * Necessary because periods are generated ahead as `active`: migration 059 needs
 * `status = 'active'` AND the date inside the range, so a period that has not
 * started attributes nothing whatever its status says. Printing the raw status
 * would show a year of "active" rows with no clue which one is running.
 */
export function periodPhase(period: CutoffPeriod, today: Date = new Date()): PeriodPhase {
  const day = localIso(today)
  if (day < period.starts_on) return 'upcoming'
  if (day > period.ends_on) return 'ended'
  return 'current'
}

// --- Generating periods from a repeating pattern -----------------------------
//
// Periods remain individual rows — the attribution trigger, the mobile SQLite
// mirror, and the audit trail all key off the row, so none of this replaces
// them. It only spares an admin from typing twenty-four of them a year, which
// was a chore certain to be skipped, and a skipped period means every meeting
// recorded in the gap is attributed to nothing at all.

/**
 * A repeating cutoff shape: which days of the month a period ENDS on.
 *
 * `[8, 23]` is this company's actual cycle (confirmed with the supervisor
 * 2026-08-03): the 24th of one month through the 8th of the next, then the 9th
 * through the 23rd.
 *
 * End days rather than start days for two reasons. It is how the rule was
 * stated, and how payroll cutoffs are stated generally. And it makes periods
 * contiguous by construction — each one begins the day after the previous ends,
 * so no arithmetic can leave a day uncovered. A start-day model cannot express
 * a period that crosses a month boundary at all, which this one does.
 *
 * Configurable rather than hardcoded because the 2026-07-31 direction is
 * explicit that no calendar-month, semi-monthly, or payroll boundary may be
 * assumed. [8, 23] is the default an admin sees, not a constant in the code.
 */
export interface PeriodPattern {
  /** Days of the month a period ends on. Ascending, distinct, 1-31. */
  endDays: number[]
  /** First month whose periods to generate, as 'YYYY-MM'. */
  fromMonth: string
  /** How many months to cover. */
  months: number
}

/** A period about to be created — no id, status, or audit columns yet. */
export interface GeneratedPeriod {
  label: string
  starts_on: string
  ends_on: string
}

/** Last day of a month. Day 0 of the next month is the last day of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The end day, clamped to a month that is too short for it.
 *
 * Unambiguous in a way a start day never was: "ends on the 31st" in February
 * plainly means the last day of February. That is why end days accept 1-31
 * while the earlier start-day model had to refuse anything past 28.
 */
function endOfDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, Math.min(day, daysInMonth(year, month))))
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

const DAY_MS = 86_400_000

/**
 * Expand a pattern into concrete period rows, ready to insert.
 *
 * Each period ends on one of the pattern's days and starts the day after the
 * previous end — which is what makes a cycle like [8, 23] work: the period
 * ending on the 8th reaches back to the 24th of the month before. Month length,
 * February, and the year boundary all fall out of real date arithmetic rather
 * than being special-cased, and no day can ever be left uncovered.
 *
 * `fromMonth` selects the months periods END in, so a September pattern of
 * [8, 23] yields Aug 24 – Sep 8 first. Rows come back in date order, which is
 * also the order they must be inserted: the non-overlap constraint rejects the
 * whole batch otherwise, and a partial batch is worse than none.
 */
export function generatePeriods(pattern: PeriodPattern): GeneratedPeriod[] {
  const ends = [...new Set(pattern.endDays)]
    .filter(d => Number.isInteger(d) && d >= 1 && d <= 31)
    .sort((a, b) => a - b)

  const [fromYear, fromMonth] = pattern.fromMonth.split('-').map(Number)
  if (ends.length === 0 || !fromYear || !fromMonth || pattern.months < 1) return []

  const rows: GeneratedPeriod[] = []
  for (let offset = 0; offset < pattern.months; offset++) {
    const zeroBased = fromYear * 12 + (fromMonth - 1) + offset
    const year = Math.floor(zeroBased / 12)
    const month = (zeroBased % 12) + 1

    ends.forEach((day, i) => {
      const end = endOfDay(year, month, day)
      // The previous boundary is the one before it in the same month, or the
      // last of the month before — that wrap is the whole point of the model.
      const prevEnd =
        i > 0
          ? endOfDay(year, month, ends[i - 1])
          : endOfDay(
              month === 1 ? year - 1 : year,
              month === 1 ? 12 : month - 1,
              ends[ends.length - 1]
            )
      const start = new Date(prevEnd.getTime() + DAY_MS)
      rows.push({ label: dateRangeLabel(start, end), starts_on: iso(start), ends_on: iso(end) })
    })
  }
  return rows
}

/** Periods in `generated` whose dates collide with one already stored. */
export function overlappingWithExisting(
  generated: GeneratedPeriod[],
  existing: CutoffPeriod[]
): GeneratedPeriod[] {
  // Only scheduled/active rows are covered by the exclusion constraint, so only
  // those can reject an insert. Closed and superseded periods overlap freely.
  const blocking = existing.filter(p => p.status === 'scheduled' || p.status === 'active')
  return generated.filter(g =>
    blocking.some(p => g.starts_on <= p.ends_on && p.starts_on <= g.ends_on)
  )
}

const MONTH_DAY_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})
const DAY_FMT = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' })

/**
 * "Jul 24 – Aug 8" across months, "Aug 9–23" within one.
 *
 * The single date-formatter for periods, used both to name a generated period
 * and to caption any period on screen. That is deliberate: a generated period is
 * named after its own range, and callers suppress the caption when it repeats
 * the name. Two formatters producing "Aug 9–23" and "Aug 9 – Aug 23" for the
 * same fortnight made that comparison silently fail.
 */
export function dateRangeLabel(start: Date, end: Date): string {
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${MONTH_DAY_FMT.format(start)}–${DAY_FMT.format(end)}`
    : `${MONTH_DAY_FMT.format(start)} – ${MONTH_DAY_FMT.format(end)}`
}

/** A stored period's dates, for surfaces with no room for the label. */
export function periodDateLabel(period: CutoffPeriod): string {
  // starts_on/ends_on are DATE columns — 'YYYY-MM-DD' with no zone. Parsed and
  // formatted as UTC so the displayed day matches the stored day exactly; doing
  // it in local time would shift the label a day west of Manila.
  return dateRangeLabel(
    new Date(`${period.starts_on}T00:00:00Z`),
    new Date(`${period.ends_on}T00:00:00Z`)
  )
}

/** What one client did against its allowance in one period. */
export interface ClientQuotaUsage {
  clientId: string
  /** Meetings that consumed a slot. Never exceeds `cap` — the server caps it. */
  used: number
  /**
   * Meetings refused a slot because the pool was full. THIS is the
   * over-visiting signal, not `used > cap`, which the server makes impossible.
   */
  overCap: number
  /** Meetings on an uncapped stage (prospect / in progress). */
  uncapped: number
  /** Meetings whose tag-along confirmation is still open, reserving nothing. */
  pending: number
  cap: number
  state: QuotaState
}

/**
 * Fold the attribution ledger into per-client usage for one period.
 *
 * Rows for other periods are ignored rather than filtered upstream, so a caller
 * can hand over the whole ledger and switch periods without refetching.
 */
export function clientQuotaUsage(
  attributions: MeetingCutoffAttribution[],
  period: CutoffPeriod
): Map<string, ClientQuotaUsage> {
  const byClient = new Map<string, ClientQuotaUsage>()

  const blank = (clientId: string): ClientQuotaUsage => ({
    clientId,
    used: 0,
    overCap: 0,
    uncapped: 0,
    pending: 0,
    cap: period.client_meeting_cap,
    state: 'under',
  })

  for (const row of attributions) {
    if (row.period_id !== period.id) continue
    const entry = byClient.get(row.client_id) ?? blank(row.client_id)
    if (row.attribution === 'counted') entry.used += 1
    else if (row.attribution === 'over_cap') entry.overCap += 1
    else if (row.attribution === 'excluded_uncapped') entry.uncapped += 1
    else if (row.attribution === 'pending_validity') entry.pending += 1
    // excluded_invalid and unattributed contribute to nothing by design.
    byClient.set(row.client_id, entry)
  }

  for (const entry of byClient.values()) {
    entry.state = quotaState(entry)
  }
  return byClient
}

/**
 * Where a client sits against its cap.
 *
 * 'exempt' means every attributed meeting was on an uncapped stage — the client
 * was a prospect throughout, so no ceiling applies. Checked before the cap
 * comparison because such a client has `used = 0`, which would otherwise read
 * as "plenty of room left" rather than "no limit here".
 *
 * 'over' keys off `overCap`, never off `used > cap`. The server allocates slots
 * up to the cap and classifies the rest as over_cap, so `used` can never exceed
 * `cap` and a comparison would silently never fire.
 */
export function quotaState(usage: Pick<ClientQuotaUsage, 'used' | 'overCap' | 'uncapped' | 'cap'>): QuotaState {
  if (usage.overCap > 0) return 'over'
  if (usage.used === 0 && usage.uncapped > 0) return 'exempt'
  if (usage.used >= usage.cap) return 'at'
  return 'under'
}

// --- Reporting buckets -------------------------------------------------------
//
// ADR-053 O-5 requires admin reporting to show meetings as distinguishable
// buckets rather than a binary counted/not-counted, and names five: Counted,
// Pending, Over-cap, Invalid, Unattributed.
//
// Six are reported here, because the schema carries six and five of them would
// not add up. `excluded_uncapped` — a meeting on a prospect or in-progress
// client — is absent from the ADR's list but is a real, valid, common outcome:
// it consumes no client slot yet still counts toward the agent's period target
// (O-3). Folding it into "Counted" would overstate slot usage, and dropping it
// would lose meetings between the total and the buckets. It gets its own row.

/** Display names for the ledger's attribution values, worst news first. */
export const ATTRIBUTION_LABEL: Record<CutoffAttribution, string> = {
  counted: 'Counted',
  over_cap: 'Over cap',
  pending_validity: 'Pending confirmation',
  excluded_uncapped: 'Uncapped stage',
  excluded_invalid: 'Invalid',
  unattributed: 'Unattributed',
}

/** Bucket display order: what was earned, then what was refused, then noise. */
export const ATTRIBUTION_ORDER: CutoffAttribution[] = [
  'counted',
  'excluded_uncapped',
  'pending_validity',
  'over_cap',
  'excluded_invalid',
  'unattributed',
]

/**
 * How many meetings landed in each bucket for one period.
 *
 * Every value is present even at zero — a bucket that vanishes when empty makes
 * "no invalid meetings" indistinguishable from "invalid meetings not reported",
 * which is the exact ambiguity O-5 exists to remove.
 */
export function attributionBuckets(
  attributions: MeetingCutoffAttribution[],
  period: CutoffPeriod
): Record<CutoffAttribution, number> {
  const counts = Object.fromEntries(ATTRIBUTION_ORDER.map(k => [k, 0])) as Record<
    CutoffAttribution,
    number
  >
  for (const row of attributions) {
    if (row.period_id !== period.id) continue
    counts[row.attribution] += 1
  }
  return counts
}

/** One agent's period, measured against the target for their role. */
export interface AgentPeriodUsage {
  agentId: string
  buckets: Record<CutoffAttribution, number>
  /**
   * Meetings contributing to the role target — `counted` plus
   * `excluded_uncapped`, per O-3. Not the same as the slot-consuming count.
   */
  towardTarget: number
  /** Null when no target is configured for this agent's role (O-6). */
  target: number | null
}

/**
 * Per-agent rollup for one period.
 *
 * `roleOf` is injected rather than joined here because the ledger stores no
 * role: the target that applies depends on who the agent is *now*, which only
 * the profiles table knows. Returning null for an unknown role is deliberate —
 * that renders as "not configured" rather than inventing a denominator.
 */
export function agentPeriodUsage(
  attributions: MeetingCutoffAttribution[],
  period: CutoffPeriod,
  roleOf: (agentId: string) => string | undefined
): Map<string, AgentPeriodUsage> {
  const byAgent = new Map<string, AgentPeriodUsage>()

  for (const row of attributions) {
    if (row.period_id !== period.id) continue
    let entry = byAgent.get(row.agent_id)
    if (!entry) {
      const role = roleOf(row.agent_id)
      entry = {
        agentId: row.agent_id,
        buckets: Object.fromEntries(ATTRIBUTION_ORDER.map(k => [k, 0])) as Record<
          CutoffAttribution,
          number
        >,
        towardTarget: 0,
        target:
          role === 'rsr' ? period.rsr_target : role === 'sales_specialist' ? period.sales_target : null,
      }
      byAgent.set(row.agent_id, entry)
    }
    entry.buckets[row.attribution] += 1
    if (TARGET_CONTRIBUTING.includes(row.attribution)) entry.towardTarget += 1
  }

  return byAgent
}

/** One team's period, aggregated across its roster. */
export interface TeamPeriodUsage {
  /** Null for agents with no team — reported rather than dropped. */
  teamId: string | null
  buckets: Record<CutoffAttribution, number>
  towardTarget: number
  /**
   * Sum of the roster's individual role targets, or null when not one member
   * has a configured target. Summed over the ROSTER, not over the agents who
   * appear in the ledger — see `teamPeriodUsage`.
   */
  target: number | null
  memberCount: number
  /** Roster members with nothing attributed this period. */
  idleMembers: number
}

/** A roster row: the minimum this module needs to know about an agent. */
export interface RosterMember {
  id: string
  team_id: string | null
  role: string
}

/**
 * Per-team rollup for one period.
 *
 * Aggregated over the ROSTER rather than over the ledger, which matters for the
 * denominator: a team of six where two agents recorded nothing has six targets
 * to hit, not four. Summing only the agents who appear in the ledger would
 * shrink the target to match whoever happened to work, and a half-idle team
 * would report as comfortably on quota. The idle members are counted and
 * surfaced instead, because that is the fact worth acting on.
 *
 * Only roles with a configured target contribute to the denominator; a manager
 * on the roster has no personal period quota (O-6) and so adds nothing to it,
 * while any meeting they recorded still lands in the buckets.
 */
export function teamPeriodUsage(
  attributions: MeetingCutoffAttribution[],
  period: CutoffPeriod,
  roster: RosterMember[]
): Map<string | null, TeamPeriodUsage> {
  const blank = (teamId: string | null): TeamPeriodUsage => ({
    teamId,
    buckets: Object.fromEntries(ATTRIBUTION_ORDER.map(k => [k, 0])) as Record<
      CutoffAttribution,
      number
    >,
    towardTarget: 0,
    target: null,
    memberCount: 0,
    idleMembers: 0,
  })

  const byTeam = new Map<string | null, TeamPeriodUsage>()
  const teamOf = new Map(roster.map(m => [m.id, m.team_id]))

  // Roster first, so a team whose every agent was idle still gets a row with a
  // real denominator rather than being absent from the report entirely.
  for (const member of roster) {
    const entry = byTeam.get(member.team_id) ?? blank(member.team_id)
    entry.memberCount += 1
    const memberTarget =
      member.role === 'rsr'
        ? period.rsr_target
        : member.role === 'sales_specialist'
          ? period.sales_target
          : null
    if (memberTarget != null) entry.target = (entry.target ?? 0) + memberTarget
    byTeam.set(member.team_id, entry)
  }

  const active = new Set<string>()
  for (const row of attributions) {
    if (row.period_id !== period.id) continue
    // An agent absent from the roster (deactivated, or another module's staff)
    // still recorded a real meeting, so it is counted under whatever team the
    // roster knows — null when it knows none.
    const teamId = teamOf.get(row.agent_id) ?? null
    const entry = byTeam.get(teamId) ?? blank(teamId)
    entry.buckets[row.attribution] += 1
    if (TARGET_CONTRIBUTING.includes(row.attribution)) entry.towardTarget += 1
    byTeam.set(teamId, entry)
    active.add(row.agent_id)
  }

  for (const member of roster) {
    if (!active.has(member.id)) {
      const entry = byTeam.get(member.team_id)
      if (entry) entry.idleMembers += 1
    }
  }

  return byTeam
}

/** Empty usage for a client with nothing attributed in the period. */
export function emptyUsage(clientId: string, period: CutoffPeriod): ClientQuotaUsage {
  return {
    clientId,
    used: 0,
    overCap: 0,
    uncapped: 0,
    pending: 0,
    cap: period.client_meeting_cap,
    state: 'under',
  }
}
