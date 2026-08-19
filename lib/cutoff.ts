import type {
  CutoffAttribution,
  CutoffPeriod,
  MeetingCutoffAttribution,
  TeamKind,
  UserRole,
} from '@/types'
import { ROLE_LABEL } from '@/lib/permissions'

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

/**
 * How a client stands against its per-period meeting cap.
 *
 * Three states, not four, and there is deliberately no "at the limit" among
 * them. The cap is a CEILING, not a target — the rule agreed 2026-08-02 says a
 * client may be visited at most N times, never that it should be. A client at
 * 2 of 2 has done nothing wrong and needs no attention, so distinguishing it
 * from one at 0 of 2 only invites the reading that the allowance is a score to
 * fill. The one fact worth reporting is whether somebody went past the wall.
 *
 * Unchanged by the per-role split (074): the ceiling a meeting was measured
 * against depends on the recording agent's role, but going past one is going
 * past one, so 'over' still means any pool overflowed.
 */
export type QuotaState = 'exempt' | 'within' | 'over'

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
 * Today as 'YYYY-MM-DD' in the business timezone, comparable against the
 * starts_on/ends_on DATE columns as plain strings.
 *
 * Cutoff boundaries are Manila-local, not browser- or server-local. This keeps
 * the Admin view aligned with the database attribution and mobile quota card.
 */
function manilaIso(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
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
  const day = manilaIso(today)
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
  const day = manilaIso(today)
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
  const day = manilaIso(today)
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

/**
 * The visit ceiling that applies to a meeting recorded by this role, on a team
 * of this kind.
 *
 * Mirrors `public.cutoff_cap_for_agent()` (migration 076) exactly, including the
 * fallback: a role with no ceiling of its own gets the legacy shared one, because
 * the alternative is an undefined ceiling, which would read as "nothing ever
 * counts". It also covers periods created before 074, whose two columns are null.
 *
 * The team kind matters for exactly one role. `sales_manager` covers both a
 * sales team and an RSR team — migration 010 folded rsr_manager into it — so a
 * manager is capped as the team they run is capped, and the role alone cannot
 * say which that is.
 */
export function capForAgent(
  role: UserRole | null | undefined,
  teamKind: TeamKind | null | undefined,
  period: CutoffPeriod
): number {
  const salesCap = period.sales_client_meeting_cap ?? period.client_meeting_cap
  const rsrCap = period.rsr_client_meeting_cap ?? period.client_meeting_cap

  if (role === 'sales_specialist') return salesCap
  if (role === 'rsr') return rsrCap
  if (role === 'sales_manager' && teamKind === 'sales') return salesCap
  if (role === 'sales_manager' && teamKind === 'rsr') return rsrCap
  return period.client_meeting_cap
}

/**
 * The ceiling for a role whose team is unknown. Mirrors the deprecated
 * `public.cutoff_cap_for_role()` shim — a manager resolves to the legacy shared
 * ceiling rather than to either side's.
 */
export function capForRole(role: UserRole | null | undefined, period: CutoffPeriod): number {
  return capForAgent(role, null, period)
}

/**
 * Which pool a participant draws from — mirrors `public.cutoff_pool_key()`.
 *
 * Role alone for everyone except a manager, whose one role carries two different
 * ceilings and so has to split by team kind. Folding team kind into a
 * specialist's or RSR's key would only strand a teamless agent in a pool of
 * their own, since their kind never varies.
 */
export function poolKey(
  role: UserRole | null | undefined,
  teamKind: TeamKind | null | undefined
): string {
  if (role === 'sales_manager') return `sales_manager:${teamKind ?? 'none'}`
  return role ?? ''
}

/** True when the two roles are actually set to different ceilings. */
export function capsDiffer(period: CutoffPeriod): boolean {
  return capForRole('sales_specialist', period) !== capForRole('rsr', period)
}

/**
 * One pool's allowance against one client.
 *
 * Pools are counted separately (migration 074): a client with a Sales limit of 2
 * and an RSR limit of 4 has both, and Sales filling its two slots consumes none
 * of RSR's four. Since 076 a manager has a pool of their own too, so a manager
 * tagging along never eats the specialist's allowance.
 */
export interface QuotaPool {
  /** `poolKey(role, teamKind)` — what the server counted this row against. */
  key: string
  /** Null for a row whose agent had no profile — its own pool, not a match-all. */
  role: UserRole | null
  /** Only meaningful for `sales_manager`, whose ceiling depends on it. */
  teamKind: TeamKind | null
  used: number
  overCap: number
  cap: number
}

/**
 * Names a pool for a reader.
 *
 * A manager's pool carries the team kind, because "Sales Manager's limit of 4"
 * is confusing next to a Sales limit of 2 — the 4 is the RSR ceiling, and the
 * only thing that explains it is which team they run.
 */
export function poolLabel(pool: Pick<QuotaPool, 'role' | 'teamKind'>): string {
  if (!pool.role) return 'an unknown role'
  if (pool.role === 'sales_manager' && pool.teamKind) {
    return `${ROLE_LABEL[pool.role]} (${pool.teamKind === 'rsr' ? 'RSR' : 'Sales'} team)`
  }
  return ROLE_LABEL[pool.role]
}

/** What one client did against its allowance in one period. */
export interface ClientQuotaUsage {
  clientId: string
  /** Meetings that consumed a slot, across every pool. */
  used: number
  /**
   * Meetings refused a slot because their pool was full. THIS is the
   * over-visiting signal, not `used > cap`, which the server makes impossible.
   */
  overCap: number
  /** Meetings on an uncapped stage (prospect / in progress). */
  uncapped: number
  /** Meetings whose tag-along confirmation is still open, reserving nothing. */
  pending: number
  /**
   * Total allowance across the pools this client actually drew on — the sum of
   * `pools[].cap`, not any single role's ceiling.
   *
   * Summed rather than picked because with per-role pools there is no one cap
   * for a client that both roles visited: its real allowance is both ceilings
   * together, and reporting either alone would show 3 of 2. A client assigned to
   * one agent has one pool, so this is that role's cap and reads exactly as it
   * did before 074 — which is every client, near enough.
   */
  cap: number
  /** Per-role breakdown, for a surface that needs to say which pool overflowed. */
  pools: QuotaPool[]
  state: QuotaState
}

/**
 * Fold the attribution ledger into per-client usage for one period.
 *
 * Rows for other periods are ignored rather than filtered upstream, so a caller
 * can hand over the whole ledger and switch periods without refetching.
 *
 * The pools are built from `captured_agent_role`, the role frozen onto the row
 * when it was decided — never from the agent's role now. Reading the roster live
 * would move a client between pools the moment somebody changed jobs, and
 * silently restate a finished cutoff.
 */
export function clientQuotaUsage(
  attributions: MeetingCutoffAttribution[],
  period: CutoffPeriod,
  /**
   * The role owning each client, used ONLY to name a ceiling for a client that
   * has opened no pool — one whose meetings were all uncapped, invalid, or still
   * pending. Without it such a client reports a cap of 0, which reads as "no
   * allowance" when the truth is "none of it drawn on yet".
   */
  roleOfClient?: (clientId: string) => UserRole | null | undefined
): Map<string, ClientQuotaUsage> {
  const byClient = new Map<string, ClientQuotaUsage>()

  const blank = (clientId: string): ClientQuotaUsage => ({
    clientId,
    used: 0,
    overCap: 0,
    uncapped: 0,
    pending: 0,
    cap: 0,
    pools: [],
    state: 'within',
  })

  for (const row of attributions) {
    if (row.period_id !== period.id) continue
    const entry = byClient.get(row.client_id) ?? blank(row.client_id)

    // MEETINGS at this level, PARTICIPATIONS in the pools below. These four
    // describe what happened to the client — how often it was visited — and a
    // visit with a manager along is one visit, not two. Since 076 that meeting
    // has two ledger rows, so counting every row here would tell an admin a
    // client was seen twice when somebody went out once. The 'agent' row is the
    // canonical one: every meeting has exactly one.
    if (row.participation === 'agent') {
      if (row.attribution === 'counted') entry.used += 1
      else if (row.attribution === 'over_cap') entry.overCap += 1
      else if (row.attribution === 'excluded_uncapped') entry.uncapped += 1
      else if (row.attribution === 'pending_validity') entry.pending += 1
      // excluded_invalid and unattributed contribute to nothing by design.
    }

    // Every participant, not just the agent: a slot is consumed per person, so
    // this is where a manager's tag-along has to be counted or their pool would
    // read as empty while the server had it full.
    //
    // Only the two capped outcomes open a pool. An uncapped or invalid meeting
    // consumed no slot, so counting its role here would add a whole ceiling to
    // the client's allowance on the strength of a meeting that used none of it.
    if (row.attribution === 'counted' || row.attribution === 'over_cap') {
      const role = row.captured_agent_role ?? null
      const teamKind = row.captured_team_kind ?? null
      const key = poolKey(role, teamKind)
      let pool = entry.pools.find(p => p.key === key)
      if (!pool) {
        pool = { key, role, teamKind, used: 0, overCap: 0, cap: capForAgent(role, teamKind, period) }
        entry.pools.push(pool)
      }
      if (row.attribution === 'counted') pool.used += 1
      else pool.overCap += 1
    }

    byClient.set(row.client_id, entry)
  }

  for (const entry of byClient.values()) {
    entry.cap = entry.pools.length
      ? entry.pools.reduce((total, pool) => total + pool.cap, 0)
      : capForRole(roleOfClient?.(entry.clientId), period)
    entry.state = quotaState(entry)
  }
  return byClient
}

/**
 * Where a client sits against its cap.
 *
 * 'exempt' means every attributed meeting was on an uncapped stage — the client
 * was a prospect throughout, so no ceiling applies. Checked before anything else
 * because such a client has `used = 0`, which would otherwise read as "plenty of
 * room left" rather than "no limit here".
 *
 * 'over' keys off refused slots, never off `used > cap`. The server allocates
 * slots up to the cap and classifies the rest as over_cap, so `used` can never
 * exceed `cap` and a comparison would silently never fire.
 *
 * It reads the POOLS rather than the client-level `overCap`, because since 076
 * those count different things: `overCap` counts meetings, and a pool that
 * overflowed on a manager's tag-along has no meeting of its own to show up as.
 * Falling back to `overCap` keeps the function usable on a bare count.
 *
 * Everything else is 'within', with no gradient inside it — see QuotaState.
 */
export function quotaState(
  usage: Pick<ClientQuotaUsage, 'used' | 'overCap' | 'uncapped' | 'cap'> &
    Partial<Pick<ClientQuotaUsage, 'pools'>>
): QuotaState {
  const refused = usage.pools
    ? usage.pools.reduce((total, pool) => total + pool.overCap, 0)
    : usage.overCap
  if (refused > 0 || usage.overCap > 0) return 'over'
  if (usage.used === 0 && usage.uncapped > 0) return 'exempt'
  return 'within'
}

// --- Targets and the working calendar ----------------------------------------
//
// Three roles, two units, ONE window (supervisor, 2026-08-16):
//
//   Sales    35 per calendar MONTH
//   Manager  20 per calendar MONTH   — flat, not the team's number any more
//   RSR      16 per WORKING DAY      — so the month expectation is 16 x working
//                                      days in that month
//
// The window is the month and not the cutoff. Until migration 105 a target was
// a per-cutoff number, and with the [8, 23] cycle running twice a month that
// made 35 mean 70. Prorating a monthly figure back into 17/18 per cutoff was
// asked about and explicitly rejected — the target is monthly, and the code
// measures it over a month.
//
// The cutoff period keeps everything else: attribution, slot allocation, and
// the per-client visit CAP are all still per cutoff, because those are what the
// server's trigger reads. Targets are monthly, limits are per cutoff, and the
// two no longer share a window — which is why the target helpers below take a
// month while `clientQuotaUsage` still takes a period.
//
// No number is written down here. All three come from the period row, which an
// admin edits (contract O-6, Batch-0 items 1-2).

/**
 * Roles that carry a quota.
 *
 * A manager is one as of migration 105. O-7 said they had no personal target,
 * which was true while they inherited their team's; a flat monthly number of
 * their own supersedes both.
 */
export type QuotaRole = 'sales_specialist' | 'rsr' | 'sales_manager'

/**
 * Working days in a period: weekdays, minus company holidays, unless the period
 * states its own count.
 *
 * The override exists for a schedule the rule cannot express — a worked
 * Saturday, a shutdown week. Holidays are passed in rather than derived because
 * Philippine holidays are declared by proclamation and no algorithm produces
 * them.
 */
export function workingDaysIn(period: CutoffPeriod, holidays: string[] = []): number {
  if (period.working_days_override != null) return period.working_days_override

  const holidaySet = new Set(holidays)
  let count = 0
  // Iterated in UTC over the DATE columns' own calendar days, so the count is
  // the same wherever it runs — a local-time walk would drop or double a day
  // depending on the viewer's zone.
  const cursor = new Date(`${period.starts_on}T00:00:00Z`)
  const end = new Date(`${period.ends_on}T00:00:00Z`)

  while (cursor.getTime() <= end.getTime()) {
    const day = cursor.getUTCDay()
    const iso = cursor.toISOString().slice(0, 10)
    if (day !== 0 && day !== 6 && !holidaySet.has(iso)) count += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

/**
 * The Manila calendar date a timestamp falls on, as 'YYYY-MM-DD'.
 *
 * The business day is Manila-local, and migration 072 exists precisely because
 * the server was getting this wrong. The admin side was still slicing the first
 * ten characters off the raw timestamp — a UTC date — so every visit logged
 * before 08:00 Manila was dated to the day BEFORE the one it happened on.
 *
 * That is not only a cosmetic slip in the daily chart. These dates decide which
 * cutoff an orphaned ledger row belongs to (`periodAttributions`), so a visit
 * recorded at 7am on the first day of a cutoff was placed in the previous one,
 * and the panel and the Meetings Report disagreed about how many meetings the
 * period held.
 */
export function manilaDateOf(timestamp: string): string {
  return manilaIso(new Date(timestamp))
}

/**
 * The calendar month a 'YYYY-MM-DD' day belongs to, as 'YYYY-MM'.
 *
 * String arithmetic rather than Date arithmetic throughout this section: the
 * dates in play are already Manila-local plain dates, and parsing them into a
 * Date only to slice a month back out is where a timezone shifts one into the
 * month before.
 */
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** The month containing today, in the business timezone. */
export function currentMonth(today: Date = new Date()): string {
  return monthOf(manilaIso(today))
}

/** First and last day of a 'YYYY-MM', inclusive, as 'YYYY-MM-DD'. */
export function monthBounds(month: string): { start: string; end: string } {
  const [year, m] = month.split('-').map(Number)
  const last = daysInMonth(year, m)
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

const MONTH_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/** "August 2026" — what a monthly target is measured over. */
export function monthLabel(month: string): string {
  return MONTH_LABEL_FMT.format(new Date(`${month}-01T00:00:00Z`))
}

/**
 * Working days in a calendar month: weekdays, minus company holidays.
 *
 * Deliberately has no override, unlike `workingDaysIn`. That one is a per-PERIOD
 * correction for a schedule the rule cannot express, and a month spans two
 * periods — so there is no honest way to apply one period's override to a month.
 * Migration 105 makes the same choice server-side, and the two must agree or an
 * RSR's phone and the admin report will quote different targets.
 */
export function workingDaysInMonth(month: string, holidays: string[] = []): number {
  const holidaySet = new Set(holidays)
  const { start, end } = monthBounds(month)
  let count = 0
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)

  while (cursor.getTime() <= last.getTime()) {
    const day = cursor.getUTCDay()
    const iso = cursor.toISOString().slice(0, 10)
    if (day !== 0 && day !== 6 && !holidaySet.has(iso)) count += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

/**
 * The period whose snapshot supplies a MONTH's target numbers.
 *
 * Needed because the two are different shapes: targets are monthly, but the
 * numbers are still snapshotted per period, and a month holds two of those
 * rows. Which matters as soon as an admin edits mid-month, which they are
 * expected to do freely — `apply_standing_targets()` reaches every cutoff that
 * has not ENDED, so an edit on 15 August updates the 9–23 period while the
 * 24 July–8 August one keeps the old number. Both end in August. Reading
 * whichever the reader happened to select would answer the same question two
 * ways depending on a dropdown that has nothing to do with the month.
 *
 * The LAST period ending in the month wins, so the most recently applied number
 * is the month's number. That restates the month's target the moment it is
 * edited, which is the intended behaviour: a target feeds no attribution
 * decision, so nothing already recorded moves — see the note on
 * `apply_standing_targets()`.
 *
 * Falls back to null when no period ends in the month at all; the caller shows
 * "not configured" rather than borrowing a neighbouring month's numbers.
 */
export function targetSourceForMonth(
  periods: CutoffPeriod[],
  month: string
): CutoffPeriod | null {
  return (
    periods
      // Drafts excluded, matching migration 105's `source` CTE: a draft is a
      // period nobody has committed to, and letting one supply the month's
      // numbers would show a target the server does not agree with.
      .filter(p => p.status !== 'draft' && monthOf(p.ends_on) === month)
      .sort((a, b) => b.ends_on.localeCompare(a.ends_on))[0] ?? null
  )
}

/**
 * What one agent of this role is expected to do in a MONTH.
 *
 * Replaces `periodTargetFor` (migration 105). The numbers still come off a
 * period row — that is where an admin's edit is snapshotted — but what they
 * mean is a month's work, so the multiplier handed in is the month's working
 * days, never a period's.
 *
 * Null in, null out: an unconfigured role has no target and must render as such
 * rather than as zero (O-6). A role with no quota at all — admin, executive,
 * collector — is also null, which is why the parameter is widened to string.
 *
 * A manager no longer takes their team's number and so no longer needs a team
 * kind. That inheritance (076) is exactly what the flat `manager_target`
 * replaces: a manager of an RSR team and a manager of a sales team are both
 * measured against the same monthly figure.
 */
export function monthlyTargetFor(
  role: string | undefined,
  period: CutoffPeriod,
  workingDaysInTheMonth: number
): number | null {
  if (role === 'sales_specialist') return period.sales_target
  if (role === 'sales_manager') return period.manager_target
  if (role === 'rsr') {
    return period.rsr_daily_target == null
      ? null
      : period.rsr_daily_target * workingDaysInTheMonth
  }
  return null
}

/**
 * What one agent of this role is expected to do in one CUTOFF.
 *
 * The admin panel reports per cutoff — that is the window an admin selects, the
 * window a client's visit limit is allocated in, and the window they asked to be
 * measured on. Targets, however, are stored per MONTH (105), so two of the three
 * roles have to be divided down to reach a cutoff.
 *
 * RSR needs no division and gets none: their number is already per working day,
 * so a cutoff's target is that rate times the cutoff's own working days —
 * including any `working_days_override`, which is exactly the per-cutoff
 * correction `workingDaysIn` exists for.
 *
 * Sales and Manager carry flat monthly figures, so they are prorated by the
 * cutoff's share of the month's working days rather than split in half. A month
 * does not divide into two equal fortnights — holidays land in one cutoff and
 * not the other — and halving would quietly move a holiday's worth of target
 * onto whichever cutoff was unlucky.
 *
 * Rounded per agent rather than at the roster sum, so the number an individual
 * is shown is the number that was added up. Null in, null out, as O-6 requires.
 */
export function cutoffTargetFor(
  role: string | undefined,
  period: CutoffPeriod,
  workingDaysInTheCutoff: number,
  workingDaysInTheMonth: number
): number | null {
  if (role === 'rsr') {
    return period.rsr_daily_target == null
      ? null
      : period.rsr_daily_target * workingDaysInTheCutoff
  }

  const monthly =
    role === 'sales_specialist'
      ? period.sales_target
      : role === 'sales_manager'
        ? period.manager_target
        : null

  // A month with no working days would be a data error, but dividing by it
  // would turn that into an Infinity on screen.
  if (monthly == null || workingDaysInTheMonth <= 0) return null
  return Math.round(monthly * (workingDaysInTheCutoff / workingDaysInTheMonth))
}

/**
 * What the whole roster is expected to record on one working day of a cutoff.
 *
 * The denominator for the daily chart. Built from the same per-role cutoff
 * targets as the headline, so a bar and the headline above it are the same unit
 * measured over different spans — the chart previously divided every agent's
 * combined day by ONE RSR's daily quota, which saturated `Math.min(100, …)` on
 * essentially every working day and made the whole row unreadable.
 *
 * Null when not one roster member has a configured target, so the caller can
 * hide the chart rather than draw bars against an invented denominator.
 */
export function rosterDailyExpectation(
  roster: RosterMember[],
  period: CutoffPeriod,
  workingDaysInTheCutoff: number,
  workingDaysInTheMonth: number
): number | null {
  if (workingDaysInTheCutoff <= 0) return null

  let total = 0
  let configured = false
  for (const member of roster) {
    const target = cutoffTargetFor(
      member.role,
      period,
      workingDaysInTheCutoff,
      workingDaysInTheMonth
    )
    if (target != null) {
      total += target
      configured = true
    }
  }

  if (!configured) return null
  // At least 1: a roster whose whole cutoff target rounds below one a day still
  // needs a denominator that does not divide by zero.
  return Math.max(1, Math.round(total / workingDaysInTheCutoff))
}

/**
 * The ledger rows belonging to one cutoff — the single place that decides.
 *
 * Normally by `period_id`, which is the server's own record of which cutoff a
 * meeting was charged against; the two can disagree for anything synced late
 * off a phone, and the server's answer is the one the quota actually used.
 *
 * But `period_id` alone does NOT select a cutoff's work, and assuming it did is
 * what hid a hundred real visits. Migration 059 writes THREE of the six
 * attributions with `period_id = NULL` — `pending_validity` (75),
 * `excluded_invalid` (96) and `unattributed` (120). Only `counted`,
 * `excluded_uncapped` and `over_cap` carry a period. A `row.period_id ===
 * period.id` test therefore cannot match half the vocabulary, which made those
 * three buckets structurally incapable of reporting anything but zero — the
 * rows O-5 put on screen to surface disqualified work were the exact rows that
 * could never appear.
 *
 * Those orphans are placed by the MEETING's date instead. It is the only honest
 * mapping available, since the row names no period, and it answers what an
 * admin is really asking of a cutoff they selected: what happened in these
 * dates, including the work that qualified for nothing.
 *
 * Callers that must NOT see orphans simply omit `meetingDates` — `clientQuotaUsage`
 * is the case that matters, since an orphan carries `slot_index = null` and
 * consumes no client visit slot.
 */
export function periodAttributions(
  attributions: MeetingCutoffAttribution[],
  period: CutoffPeriod,
  meetingDates?: Map<string, string>
): MeetingCutoffAttribution[] {
  return attributions.filter(row => {
    if (row.period_id === period.id) return true
    if (row.period_id == null && meetingDates != null) {
      const date = meetingDates.get(row.meeting_id)
      return date != null && date >= period.starts_on && date <= period.ends_on
    }
    return false
  })
}

/**
 * Why the cutoff's disqualified visits were disqualified.
 *
 * The ledger records only that a visit landed in `excluded_invalid`; the gate is
 * three rules OR'd together and keeps no note of which one fired, so the reason
 * is reconstructed from the meeting in the gate's own precedence.
 *
 * THE GATE IS MIGRATION 098's, not 059's or 076's. Both of those were
 * superseded and read
 *
 *   m.outcome not in ('successful', 'follow_up')  and  m.photo_url is null
 *
 * 098 widened the first to admit `no_decision` — a visit where the client did
 * not commit is still a visit — and replaced the second with `has_valid_evidence`,
 * which accepts an end photo plus a start capture in place of the start photo
 * (ADR-019's trade). Reading the superseded rule reported 88 evidence failures
 * as "No Decision", which is not merely a wrong label: it hid a capture defect
 * affecting eighty-eight visits behind an outcome nobody can act on.
 *
 * So `no_decision` is NOT a disqualification reason and has no bucket here.
 * Only `lost_opportunity` fails on outcome now.
 */
export interface DisqualificationBreakdown {
  /** Lost Opportunity — the only outcome 098 still refuses. */
  lost: number
  /**
   * No usable evidence: no photo, and not the end-photo-plus-start-capture pair
   * that 098 accepts instead. The visit happened and cannot be proved, which
   * makes this a capture failure rather than a decision.
   */
  noEvidence: number
  /** A manager declined the tag-along — the only remaining arm of 098's gate. */
  declined: number
  /**
   * Outcome and evidence both pass and nobody declined, so this visit would
   * qualify if it were decided today. It is not — 098 widened the gate to admit
   * `no_decision` but backfilled only `pending_validity` rows, and the terminal
   * guard makes an old verdict permanent. These are visits denied credit under
   * a rule that no longer exists.
   */
  staleVerdict: number
  /** Row present but its meeting is not loaded — reported, never folded away. */
  unknown: number
  total: number
}

/** The evidence test from migration 098, verbatim. */
export interface MeetingEvidence {
  outcome: string
  photo_url: string | null
  end_photo_url?: string | null
  start_captured_at?: string | null
  client_status_at_meeting?: string | null
}

export function disqualificationBreakdown(
  attributionsInPeriod: MeetingCutoffAttribution[],
  meetingsById: Map<string, MeetingEvidence>,
  /** Whether a manager declined this meeting's tag-along — 098's first arm. */
  wasDeclined: (meetingId: string) => boolean = () => false
): DisqualificationBreakdown {
  const out: DisqualificationBreakdown = {
    lost: 0,
    noEvidence: 0,
    declined: 0,
    staleVerdict: 0,
    unknown: 0,
    total: 0,
  }

  for (const row of attributionsInPeriod) {
    if (row.attribution !== 'excluded_invalid') continue
    out.total += 1

    const meeting = meetingsById.get(row.meeting_id)
    if (meeting == null) {
      out.unknown += 1
      continue
    }

    const hasValidEvidence =
      meeting.photo_url != null ||
      ((meeting.client_status_at_meeting === 'new' ||
        meeting.client_status_at_meeting === 'existing') &&
        meeting.start_captured_at != null &&
        meeting.end_photo_url != null)

    // 098's order: outcome before evidence, so a Lost visit is reported as the
    // outcome it is rather than blamed on a photo it also happens to lack.
    if (wasDeclined(row.meeting_id)) {
      out.declined += 1
    } else if (
      meeting.outcome !== 'successful' &&
      meeting.outcome !== 'follow_up' &&
      meeting.outcome !== 'no_decision'
    ) {
      out.lost += 1
    } else if (!hasValidEvidence) {
      out.noEvidence += 1
    } else {
      // Nothing in 098's gate refuses this visit today. Reported as its own
      // fact rather than folded into "declined", which is what made 88 stale
      // verdicts read as 88 managers refusing to attend.
      out.staleVerdict += 1
    }
  }

  return out
}

/** One day's worth of an agent's, or a team's, target-contributing work. */
export interface DailyUsage {
  /** 'YYYY-MM-DD'. */
  date: string
  count: number
  /** False for weekends and holidays — shown, but not counted against a target. */
  isWorkingDay: boolean
}

/**
 * Target-contributing meetings per calendar day of a period.
 *
 * Dated from the MEETING, not from the ledger row. `attributed_at` records when
 * the trigger wrote its decision, which for anything synced late from a phone
 * is a different day from the visit — and the daily target is about the day the
 * work happened.
 *
 * Days with no meetings are still returned, because a gap is the thing a daily
 * target exists to reveal; only returning days that have rows would draw a
 * continuous line through a week nobody worked.
 */
export function dailyUsage(
  attributions: MeetingCutoffAttribution[],
  meetingDates: Map<string, string>,
  period: CutoffPeriod,
  holidays: string[] = []
): DailyUsage[] {
  const counts = new Map<string, number>()
  for (const row of attributions) {
    if (row.period_id !== period.id) continue
    if (!TARGET_CONTRIBUTING.includes(row.attribution)) continue
    // Every participation, tag-alongs included — see attributionBuckets. These
    // bars are read against the ROSTER's daily expectation, which is built from
    // the same per-role targets that credit a manager for tagging along, so both
    // sides of the ratio count the same unit. Against a single RSR's daily
    // number they would not: that comparison divided the whole company's day by
    // one person's quota and pinned every working day at 100%.
    const date = meetingDates.get(row.meeting_id)
    if (!date) continue
    counts.set(date, (counts.get(date) ?? 0) + 1)
  }

  const holidaySet = new Set(holidays)
  const days: DailyUsage[] = []
  const cursor = new Date(`${period.starts_on}T00:00:00Z`)
  const end = new Date(`${period.ends_on}T00:00:00Z`)

  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10)
    const day = cursor.getUTCDay()
    days.push({
      date: iso,
      count: counts.get(iso) ?? 0,
      isWorkingDay: day !== 0 && day !== 6 && !holidaySet.has(iso),
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
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
 * How many credited visits landed in each bucket, for rows already scoped to a
 * cutoff by `periodAttributions()`.
 *
 * Takes pre-scoped rows rather than filtering by period itself, so that exactly
 * one function decides what belongs to a cutoff. It used to apply its own
 * `period_id` test, which meant the buckets and the per-agent/per-team rollups
 * could disagree about the same cutoff — and did: the buckets showed 97
 * disqualified visits that the team table and its exports knew nothing about.
 *
 * CREDITS, not meetings. Since 076 a manager who tagged along carries a ledger
 * row of their own and it is counted here, because this panel measures people
 * against quotas and a manager's tag-along is their work. The consequence to
 * keep in mind: this total exceeds the number of MEETINGS in the period
 * whenever anyone tagged along, so it must not be reconciled against a meeting
 * count.
 *
 * Every value is present even at zero — a bucket that vanishes when empty makes
 * "no invalid meetings" indistinguishable from "invalid meetings not reported",
 * which is the exact ambiguity O-5 exists to remove.
 */
export function attributionBuckets(
  attributionsInPeriod: MeetingCutoffAttribution[]
): Record<CutoffAttribution, number> {
  const counts = Object.fromEntries(ATTRIBUTION_ORDER.map(k => [k, 0])) as Record<
    CutoffAttribution,
    number
  >
  for (const row of attributionsInPeriod) counts[row.attribution] += 1
  return counts
}

/** One agent's month, measured against the target for their role. */
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
  /** Carried so a report can say which unit the target was expressed in. */
  role: string | undefined
}

/**
 * Per-agent rollup for one CUTOFF.
 *
 * Takes rows already scoped to the cutoff — `periodAttributions()` does that —
 * so this walks what it is given without re-filtering. Every participation
 * counts, tag-alongs included: a manager's flat monthly number is earned by
 * joining other people's visits, so dropping those rows would measure them
 * against a target they had no way to reach.
 *
 * `roleOf` is injected rather than joined here because the ledger stores no
 * role: the target that applies depends on who the agent is *now*, which only
 * the profiles table knows. Returning null for an unknown role is deliberate —
 * that renders as "not configured" rather than inventing a denominator.
 */
export function agentPeriodUsage(
  attributionsInPeriod: MeetingCutoffAttribution[],
  period: CutoffPeriod,
  roleOf: (agentId: string) => string | undefined,
  workingDaysInTheCutoff: number,
  workingDaysInTheMonth: number
): Map<string, AgentPeriodUsage> {
  const byAgent = new Map<string, AgentPeriodUsage>()

  for (const row of attributionsInPeriod) {
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
        // Via cutoffTargetFor, so a monthly figure is prorated down to this
        // cutoff rather than compared against a fortnight of work.
        target: cutoffTargetFor(role, period, workingDaysInTheCutoff, workingDaysInTheMonth),
        role,
      }
      byAgent.set(row.agent_id, entry)
    }
    entry.buckets[row.attribution] += 1
    if (TARGET_CONTRIBUTING.includes(row.attribution)) entry.towardTarget += 1
  }

  return byAgent
}

/**
 * The ledger rows belonging to one calendar month.
 *
 * Dated by the MEETING, not by `period_id` and not by `attributed_at`. Two
 * reasons, and both matter: a month spans two cutoffs so no period id selects
 * it, and `attributed_at` is when the trigger ran, which for anything synced
 * late off a phone is a different day from the visit. A monthly target is about
 * work done in the month.
 *
 * Rows whose meeting is unknown to the caller are dropped rather than kept — an
 * undated row cannot be placed in a month, and guessing would put it in this
 * one.
 */
export function monthAttributions(
  attributions: MeetingCutoffAttribution[],
  meetingDates: Map<string, string>,
  month: string
): MeetingCutoffAttribution[] {
  return attributions.filter(row => {
    const date = meetingDates.get(row.meeting_id)
    return date != null && monthOf(date) === month
  })
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
 * Per-team rollup for one CUTOFF. Window scoping as `agentPeriodUsage`.
 *
 * Aggregated over the ROSTER rather than over the ledger, which matters for the
 * denominator: a team of six where two agents recorded nothing has six targets
 * to hit, not four. Summing only the agents who appear in the ledger would
 * shrink the target to match whoever happened to work, and a half-idle team
 * would report as comfortably on quota. The idle members are counted and
 * surfaced instead, because that is the fact worth acting on.
 *
 * Only roles with a configured target contribute to the denominator. That
 * includes the team's manager, who since 105 carries a flat monthly number of
 * their own rather than a copy of their team's — so a team of five specialists
 * plus a manager has six targets to hit, and the manager's tag-alongs count
 * toward theirs. Each figure is prorated to the cutoff by `cutoffTargetFor`.
 */
export function teamPeriodUsage(
  attributionsInPeriod: MeetingCutoffAttribution[],
  period: CutoffPeriod,
  roster: RosterMember[],
  workingDaysInTheCutoff: number,
  workingDaysInTheMonth: number
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
    // Mixed-role teams sum correctly because each member is resolved in their
    // own unit first: a prorated share of 35 a month per Sales head, the same
    // for the manager's 20, and (16 x this cutoff's working days) per RSR head.
    const memberTarget = cutoffTargetFor(
      member.role,
      period,
      workingDaysInTheCutoff,
      workingDaysInTheMonth
    )
    if (memberTarget != null) entry.target = (entry.target ?? 0) + memberTarget
    byTeam.set(member.team_id, entry)
  }

  const active = new Set<string>()
  for (const row of attributionsInPeriod) {
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

/**
 * Empty usage for a client with nothing attributed in the period.
 *
 * `role` is the client's owning agent's role, which is what names its ceiling
 * now that pools are per role (074). It is optional because the number is only
 * ever displayed — with no meetings there is no `overCap`, so `quotaState` is
 * 'within' and the cap signal cannot fire whatever this says.
 */
export function emptyUsage(
  clientId: string,
  period: CutoffPeriod,
  role?: UserRole | null
): ClientQuotaUsage {
  return {
    clientId,
    used: 0,
    overCap: 0,
    uncapped: 0,
    pending: 0,
    cap: capForRole(role, period),
    pools: [],
    state: 'within',
  }
}
