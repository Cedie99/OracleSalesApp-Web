'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCutoffAttributions, useCutoffPeriods, useQuotaSettings } from '@/lib/hooks/use-cutoff'
import { useTeams } from '@/lib/hooks/use-teams'
import {
  ATTRIBUTION_LABEL,
  ATTRIBUTION_ORDER,
  agentPeriodUsage,
  attributionBuckets,
  capForRole,
  capsDiffer,
  clientQuotaUsage,
  cutoffTargetFor,
  dailyUsage,
  disqualificationBreakdown,
  manilaDateOf,
  monthLabel,
  monthOf,
  periodAttributions,
  periodDateLabel,
  periodPhase,
  reviewablePeriods,
  rosterDailyExpectation,
  teamPeriodUsage,
  workingDaysIn,
  workingDaysInMonth,
} from '@/lib/cutoff'
import { downloadSheet } from '@/components/reports/report-grid'
import type { Client, Meeting, MeetingCutoffAttribution, Profile, TagAlongRequest } from '@/types'
import {
  Gauge,
  FileSpreadsheet,
  Download,
  TriangleAlert,
  Info,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

/**
 * Cutoff and quota reporting — the Admin side of ADR-053.
 *
 * Its own panel rather than a fourth ReportGrid card for two reasons. O-5 wants
 * every bucket visible and distinguishable, and a report card holds exactly
 * three figures. And this report is scoped by cutoff PERIOD, not by the
 * toolbar's arbitrary date range: a period is the unit the rules are written in,
 * and letting someone report on "last 7 days" of a quota measured in fortnights
 * would produce a number that answers no question anyone asked.
 *
 * TWO WINDOWS since migration 105, and the panel has to keep them apart:
 *
 *   per CUTOFF   attribution buckets, and every per-client visit-limit figure —
 *                a slot is allocated against the period, so over-cap is a fact
 *                about the period and nothing else
 *   per MONTH    every TARGET, and the agent/team progress measured against one
 *
 * The selector still picks a cutoff. The month reported is the one the selected
 * cutoff ENDS in, which is the payroll convention here — the cutoff running Jul
 * 24 to Aug 8 belongs to August. Every monthly figure below is captioned with
 * the month by name, because a reader looking at a fortnight's row of buckets
 * needs to see that the target beside it covers something wider.
 *
 * Everything here reads the server's attribution ledger. Web never recounts from
 * `meetings` — see the note at the top of lib/cutoff.ts.
 */

/** Colour per bucket. Only the two that mean "something went wrong" are loud. */
const BUCKET_TONE: Record<string, string> = {
  counted: 'text-foreground',
  excluded_uncapped: 'text-foreground',
  pending_validity: 'text-amber-600 dark:text-amber-500',
  over_cap: 'text-destructive',
  excluded_invalid: 'text-muted-foreground',
  unattributed: 'text-muted-foreground',
}

/**
 * Plain-English names for the breakdown.
 *
 * ATTRIBUTION_LABEL carries the contract's own vocabulary and is what the Excel
 * exports use, because a spreadsheet is read beside the ADR. On screen the
 * reader is an admin who has never seen the ADR: "Uncapped stage" and
 * "Unattributed" are schema words that tell them nothing about what to do.
 */
const BUCKET_PLAIN: Record<string, string> = {
  counted: 'Counted toward quota',
  excluded_uncapped: 'Prospect visits',
  pending_validity: 'Waiting on approval',
  over_cap: 'Past the client’s limit',
  excluded_invalid: 'Didn’t qualify',
  unattributed: 'Outside any cutoff',
}

const BUCKET_HINT: Record<string, string> = {
  counted: 'Used one of the client’s allowed visits, and counts toward the agent’s target.',
  excluded_uncapped:
    'Visits to prospects, which have no limit. They still count toward the agent’s target.',
  pending_validity:
    'A manager was tagged along and hasn’t confirmed yet, so these aren’t final. They may still move.',
  over_cap:
    'Real visits, kept on record, but the client had already used up its allowed visits for this cutoff.',
  excluded_invalid: 'No Show, abandoned partway, a duplicate, or a tag-along the manager declined.',
  unattributed: 'Recorded when no cutoff was running. These are never moved into a later one.',
}

interface CutoffQuotaReportProps {
  clients: Client[]
  agents: Profile[]
  /** Only for dating the ledger's rows — see `meetingDates`. */
  meetings: Meeting[]
  /**
   * meeting_id -> its tag-along requests, for the attendees the LEDGER DOES NOT
   * HOLD — see `periodRowsWithAttendees`.
   */
  tagAlongsByMeeting: Map<string, TagAlongRequest[]>
}

export function CutoffQuotaReport({
  clients,
  agents,
  meetings,
  tagAlongsByMeeting,
}: CutoffQuotaReportProps) {
  const { periods, loading: periodsLoading } = useCutoffPeriods()
  const { attributions, unattributedMeetingCount, loading: ledgerLoading } = useCutoffAttributions()
  const { teamName } = useTeams()
  const { holidays } = useQuotaSettings()
  const [periodId, setPeriodId] = useState<string>('')
  const [showBreakdown, setShowBreakdown] = useState(false)

  // Only periods that have started — a future one has nothing to report on.
  const options = useMemo(() => reviewablePeriods(periods), [periods])
  const period = options.find(p => p.id === periodId) ?? options[0] ?? null

  /**
   * meeting_id -> the MANILA date it happened on.
   *
   * Manila, not a `slice(0, 10)` of the raw timestamp. That slice is the UTC
   * date, which for anything logged before 08:00 local names the previous day —
   * see `manilaDateOf`. These dates place orphaned ledger rows into a cutoff and
   * put the daily bars on a day, so the error moved real visits between periods.
   */
  const meetingDates = useMemo(
    () => new Map(meetings.map(m => [m.id, manilaDateOf(m.meeting_date)])),
    [meetings]
  )

  const roleOf = useMemo(() => {
    const map = new Map(agents.map(a => [a.id, a.role as string]))
    return (id: string) => map.get(id)
  }, [agents])

  // No team-kind lookup here any more. It existed only to resolve a manager's
  // target, which since 105 is a flat monthly number that does not vary by the
  // kind of team they run. The per-client pools still split by team kind, but
  // they read it off `captured_team_kind` on the ledger row rather than from
  // the roster — see `clientQuotaUsage`.

  /** The month the selected cutoff ends in — the window every target covers. */
  const month = useMemo(() => (period ? monthOf(period.ends_on) : null), [period])

  /**
   * The selected period IS the source of its own target numbers.
   *
   * It used to be `targetSourceForMonth`, which reached across both of a
   * month's cutoffs to pick one row deterministically. That existed because the
   * headline was measured over the MONTH and a month holds two snapshots. This
   * panel now reports per CUTOFF throughout, so the question it answered no
   * longer arises: the cutoff on screen carries the numbers its own attributions
   * were charged against, and an admin's mid-month edit correctly shows up on
   * the cutoff it applied to rather than being averaged across both.
   */
  const targetSource = period

  /**
   * Working days in the CUTOFF, and in the month that contains it.
   *
   * Both are needed because the roles are stored in two different units. An
   * RSR's daily rate multiplies straight out over the cutoff's own days —
   * `working_days_override` included, which is the per-cutoff correction it
   * exists for. Sales and Manager carry flat MONTHLY figures, so reaching a
   * cutoff means prorating by its share of the month, which needs the month's
   * count as the denominator. See `cutoffTargetFor`.
   */
  const cutoffWorkingDays = useMemo(
    () => (period ? workingDaysIn(period, holidays.map(h => h.holiday_date)) : 0),
    [period, holidays]
  )
  const workingDays = useMemo(
    () => (month ? workingDaysInMonth(month, holidays.map(h => h.holiday_date)) : 0),
    [month, holidays]
  )

  /**
   * Ledger rows for the selected CUTOFF.
   *
   * By `period_id` — the server's own record of which cutoff charged the visit —
   * rather than by re-deriving the window from meeting dates. Everything below
   * is counted over these rows, so the headline, the buckets, the daily bars and
   * the team table all describe one window and reconcile with each other.
   */
  const periodRows = useMemo(
    () => (period ? periodAttributions(attributions, period, meetingDates) : []),
    [attributions, period, meetingDates]
  )

  /**
   * The period's rows, plus the attendees the ledger deliberately omits.
   *
   * Migration 076 stops before its participant loop for an `excluded_invalid`
   * meeting — its comment calls a row per attendee on a disqualified visit
   * "noise" — so a manager who tagged along on a No Decision visit has no ledger
   * row anywhere. That is defensible for a QUOTA ledger, where they earned
   * nothing. It is wrong for a REPORT: it made those managers vanish from this
   * panel entirely, which is the same silent drop that hid a hundred meetings
   * behind a `period_id` test.
   *
   * So they are reconstructed here, from the tag-along table, on 076's own rule
   * (manager, accepted, never the agent). They land in `excluded_invalid` like
   * the visit they attended, count toward no target, and make this panel's total
   * equal the Meetings Report's record count for the same cutoff.
   */
  const periodRowsWithAttendees = useMemo(() => {
    const extra: MeetingCutoffAttribution[] = []
    for (const row of periodRows) {
      if (row.attribution !== 'excluded_invalid') continue
      for (const request of tagAlongsByMeeting.get(row.meeting_id) ?? []) {
        if (
          request.invitee_kind !== 'manager' ||
          request.status !== 'accepted' ||
          request.invitee_id === row.agent_id
        ) {
          continue
        }
        extra.push({ ...row, agent_id: request.invitee_id, participation: 'tag_along' })
      }
    }
    return extra.length > 0 ? [...periodRows, ...extra] : periodRows
  }, [periodRows, tagAlongsByMeeting])

  /**
   * Managers who attended a QUALIFYING visit and hold no credit for it.
   *
   * Not the same people as the reconstructed attendees above. Those joined a
   * visit that earned nobody anything, so earning nothing themselves is right.
   * These joined a visit that counted, and 076's guard simply never wrote their
   * row — see migration 107. Surfaced until that backfill lands, and it reads
   * zero afterwards.
   */
  const uncreditedManagers = useMemo(() => {
    const credited = new Set(periodRows.map(r => `${r.meeting_id}:${r.agent_id}`))
    let count = 0
    for (const row of periodRows) {
      if (row.attribution === 'excluded_invalid' || row.attribution === 'pending_validity') continue
      for (const request of tagAlongsByMeeting.get(row.meeting_id) ?? []) {
        if (
          request.invitee_kind !== 'manager' ||
          request.status !== 'accepted' ||
          request.invitee_id === row.agent_id ||
          credited.has(`${row.meeting_id}:${request.invitee_id}`)
        ) {
          continue
        }
        count += 1
      }
    }
    return count
  }, [periodRows, tagAlongsByMeeting])

  /**
   * The buckets, over exactly the rows every other rollup below uses.
   *
   * Derived from `periodRows` rather than re-scoped from `attributions`, so the
   * breakdown, the team table and the exports can no longer disagree about what
   * this cutoff contains.
   */
  const buckets = useMemo(
    () => (period ? attributionBuckets(periodRowsWithAttendees) : null),
    [periodRowsWithAttendees, period]
  )

  /**
   * Why this cutoff's disqualified visits were disqualified.
   *
   * Reconstructed from the meetings, because the ledger stores only the verdict
   * — see `disqualificationBreakdown`. Surfaced beside over-cap and pending
   * rather than left inside the collapsed breakdown: a sixth of this cutoff's
   * visits earned nothing, and an admin should not have to expand a panel to
   * discover that, still less to learn whether the cause was policy or a photo
   * that never uploaded.
   */
  const meetingsById = useMemo(
    () =>
      new Map(
        meetings.map(m => [
          m.id,
          {
            outcome: m.outcome as string,
            // All four, because 098's evidence test accepts an end photo plus a
            // start capture in place of the start photo — reading `photo_url`
            // alone reports visits as unevidenced that the server accepted.
            photo_url: m.photo_url,
            end_photo_url: m.end_photo_url,
            start_captured_at: m.start_captured_at,
            client_status_at_meeting: m.client_status_at_meeting,
          },
        ])
      ),
    [meetings]
  )
  const disqualified = useMemo(
    () => disqualificationBreakdown(periodRowsWithAttendees, meetingsById),
    [periodRowsWithAttendees, meetingsById]
  )

  /**
   * Credits vs meetings, and the gap between them.
   *
   * This panel counts CREDITS — a manager who tagged along earns one of their
   * own (076), which is how a flat monthly manager target is reachable at all.
   * The Meetings Report card counts MEETINGS. So the two legitimately differ,
   * and side by side with no explanation they read as a discrepancy: 555 there
   * against 565 here, with nothing on screen accounting for the 10.
   */
  const creditSpread = useMemo(() => {
    const distinctMeetings = new Set(periodRows.map(r => r.meeting_id)).size
    return {
      meetings: distinctMeetings,
      // Credited off the LEDGER, so this stays the number that actually earned
      // something — the reconstructed attendees below earned nothing.
      credited: periodRows.length - distinctMeetings,
      attendances: periodRowsWithAttendees.length - distinctMeetings + uncreditedManagers,
    }
  }, [periodRows, periodRowsWithAttendees, uncreditedManagers])

  const byAgent = useMemo(
    () =>
      targetSource
        ? agentPeriodUsage(periodRows, targetSource, roleOf, cutoffWorkingDays, workingDays)
        : new Map(),
    [periodRows, targetSource, roleOf, cutoffWorkingDays, workingDays]
  )

  // A visit limit is allocated per cutoff, so a client's slot usage was always
  // counted this way — it is the rest of the panel that has come into line.
  const byClient = useMemo(
    () => (period ? clientQuotaUsage(attributions, period) : new Map()),
    [attributions, period]
  )

  const byTeam = useMemo(
    () =>
      targetSource
        ? teamPeriodUsage(periodRows, targetSource, agents, cutoffWorkingDays, workingDays)
        : new Map(),
    [periodRows, targetSource, agents, cutoffWorkingDays, workingDays]
  )

  /**
   * What the whole roster is expected to record on one working day.
   *
   * The daily chart's denominator. It used to divide every agent's combined day
   * by a single RSR's daily target, which on real data ran past 400% and was
   * clamped to 100% on essentially every working day — the row of bars was
   * saturated rather than informative.
   */
  const dailyExpectation = useMemo(
    () =>
      targetSource
        ? rosterDailyExpectation(agents, targetSource, cutoffWorkingDays, workingDays)
        : null,
    [agents, targetSource, cutoffWorkingDays, workingDays]
  )

  const days = useMemo(
    () =>
      period ? dailyUsage(attributions, meetingDates, period, holidays.map(h => h.holiday_date)) : [],
    [attributions, meetingDates, period, holidays]
  )

  /** Teams with the most over-cap first — the report exists to surface those. */
  const teamRows = useMemo(
    () =>
      [...byTeam.values()].sort(
        (a, b) =>
          b.buckets.over_cap - a.buckets.over_cap ||
          b.towardTarget - a.towardTarget ||
          teamName(a.teamId ?? '').localeCompare(teamName(b.teamId ?? ''))
      ),
    [byTeam, teamName]
  )

  /**
   * Every record the cutoff holds, the ledger's gap included.
   *
   * The six buckets alone came to 566 against the Meetings Report's 577,
   * because 11 managers attended a qualifying visit and the ledger never
   * recorded them. A breakdown that offers to classify a cutoff and then
   * accounts for 566 of its 577 records has the same defect this panel has been
   * cleared of twice already, so the gap is a row rather than an omission.
   */
  const total =
    (buckets ? Object.values(buckets).reduce((a, b) => a + b, 0) : 0) + uncreditedManagers

  /**
   * The headline figures.
   *
   * `toward` is what the contract measures agents on — counted plus prospect
   * visits (O-3) — not the raw total, which would flatter everyone by including
   * visits that qualified for nothing. The denominator sums the teams' roster
   * targets, so it does not shrink when agents are idle.
   *
   * Because every figure in this panel now covers the same cutoff and counts the
   * same unit, `toward` is exactly the first two rows of the breakdown below it
   * (`counted` + `excluded_uncapped`), and the daily bars sum to it. That is the
   * property this panel previously lacked: a month-scoped headline sat directly
   * above cutoff-scoped buckets, and the two could not be reconciled on screen.
   */
  const headline = useMemo(() => {
    const rows = teamRows
    const toward = rows.reduce((sum, t) => sum + t.towardTarget, 0)
    const configured = rows.filter(t => t.target != null)
    const target = configured.length > 0
      ? configured.reduce((sum, t) => sum + (t.target ?? 0), 0)
      : null
    return {
      toward,
      target,
      // Both are "someone should look at this"; neither is a failure to count.
      overCap: buckets?.over_cap ?? 0,
      pending: buckets?.pending_validity ?? 0,
      idle: rows.reduce((sum, t) => sum + t.idleMembers, 0),
    }
  }, [teamRows, buckets])

  const pct =
    headline.target && headline.target > 0
      ? Math.min(100, Math.round((headline.toward / headline.target) * 100))
      : null
  const agentName = (id: string) => agents.find(a => a.id === id)?.full_name ?? ''
  const teamOfAgent = (id: string) => {
    const teamId = agents.find(a => a.id === id)?.team_id
    return teamId ? teamName(teamId) : 'No team'
  }

  function downloadTeamSummary() {
    if (!period) return
    downloadSheet(
      teamRows.map(u => ({
        'Team': u.teamId ? teamName(u.teamId) : 'No team',
        'Period': period.label,
        'Members': u.memberCount,
        'Idle Members': u.idleMembers,
        'Toward Target': u.towardTarget,
        // Summed over the roster, so it does not shrink when agents are idle.
        'Team Target': u.target ?? '',
        'Remaining': u.target != null ? Math.max(0, u.target - u.towardTarget) : '',
        ...Object.fromEntries(ATTRIBUTION_ORDER.map(k => [ATTRIBUTION_LABEL[k], u.buckets[k]])),
      })),
      'Team Quota',
      'cutoff-team-summary'
    )
  }

  function downloadAgentSummary() {
    if (!period) return
    downloadSheet(
      [...byAgent.values()].map(u => ({
        'Agent': agentName(u.agentId),
        'Team': teamOfAgent(u.agentId),
        'Role': roleOf(u.agentId) ?? '',
        'Period': period.label,
        // The month is its own column because it is the window the target and
        // "Toward Target" both cover, and it is NOT the period beside it.
        'Target Month': month ? monthLabel(month) : '',
        // The unit and its inputs, so the target can be re-derived in the sheet
        // rather than taken on trust — 336 is meaningless without "16 x 21".
        'Target Basis': u.role === 'rsr' ? 'per working day' : u.role ? 'per month' : '',
        'Daily Target': u.role === 'rsr' ? targetSource?.rsr_daily_target ?? '' : '',
        'Working Days': u.role === 'rsr' ? workingDays : '',
        'Toward Target': u.towardTarget,
        // Blank, never 0 — an unconfigured target is not a target of nothing
        // (O-6), and a 0 here would read as one in the spreadsheet.
        'Target': u.target ?? '',
        'Remaining': u.target != null ? Math.max(0, u.target - u.towardTarget) : '',
        ...Object.fromEntries(ATTRIBUTION_ORDER.map(k => [ATTRIBUTION_LABEL[k], u.buckets[k]])),
      })),
      'Agent Quota',
      'cutoff-agent-summary'
    )
  }

  function downloadClientDetail() {
    if (!period) return
    downloadSheet(
      [...byClient.values()].map(u => {
        const client = clients.find(c => c.id === u.clientId)
        return {
          'Client': client?.company_name ?? '',
          'Assigned Agent': client?.agent?.full_name ?? '',
          'Period': period.label,
          'Visits': u.used,
          // The ceiling, for reference. No "Remaining" column: the allowance is
          // a limit, not a budget to spend down, and a remaining count invites
          // exactly the reading that an unfilled client needs topping up.
          'Limit': u.cap,
          'Past Limit': u.overCap,
          'Prospect Visits': u.uncapped,
          'Awaiting Approval': u.pending,
          'Over Limit': u.state === 'over' ? 'Yes' : 'No',
        }
      }),
      'Client Allowance',
      'cutoff-client-detail'
    )
  }

  if (periodsLoading || ledgerLoading) return null

  if (!period) {
    return (
      <Alert>
        <Info className="w-4 h-4" />
        <AlertTitle>No cutoff period to report on</AlertTitle>
        <AlertDescription>
          Quota reporting needs at least one period that has started. Define one in Settings
          — until then every meeting is recorded as <code>unattributed</code>.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Gauge className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold text-foreground">
              Cutoff &amp; Quota
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              How every visit in the cutoff was classified by the server
            </p>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {/* Period, not the toolbar date range — see the note at the top. */}
            <Select value={period.id} onValueChange={v => setPeriodId(v ?? '')}>
              <SelectTrigger className="w-56 h-9 bg-card border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* A single string child, not a fragment: ui/select derives the
                    trigger's label from these children and falls back to
                    String(value) for anything else — which here is a raw uuid. */}
                {options.map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label === periodDateLabel(p)
                      ? p.label
                      : `${p.label} · ${periodDateLabel(p)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {periodPhase(period) === 'current' && (
              <Badge variant="outline" className="text-[10px]">Current</Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ---- Headline: the one number an admin came for ------------------ */}
        <div className="rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-3xl font-bold text-foreground tabular-nums">
              {headline.toward}
            </span>
            <span className="text-sm text-muted-foreground">
              {headline.target != null ? (
                <>
                  of <span className="font-medium text-foreground">{headline.target}</span> targeted
                  this cutoff
                </>
              ) : (
                <>
                  credited this cutoff ·{' '}
                  {/* Never a zero or an invented denominator — O-6. */}
                  <span className="text-amber-600 dark:text-amber-500">no target set</span>
                </>
              )}
            </span>
          </div>

          {pct != null && (
            <div className="mt-2.5 h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground mt-2">
            {period.label} · {cutoffWorkingDays} working{' '}
            {cutoffWorkingDays === 1 ? 'day' : 'days'} this cutoff, prorated from{' '}
            {month ? monthLabel(month) : 'the month'}&rsquo;s {workingDays} ·{' '}
            {capsDiffer(period) ? (
              <>
                each client may be visited {capForRole('sales_specialist', period)}{' '}
                {capForRole('sales_specialist', period) === 1 ? 'time' : 'times'} by Sales and{' '}
                {capForRole('rsr', period)}{' '}
                {capForRole('rsr', period) === 1 ? 'time' : 'times'} by RSR this cutoff
              </>
            ) : (
              <>
                each client may be visited {capForRole('sales_specialist', period)}{' '}
                {capForRole('sales_specialist', period) === 1 ? 'time' : 'times'} this cutoff
              </>
            )}
            {headline.idle > 0 && (
              <> · {headline.idle} {headline.idle === 1 ? 'agent has' : 'agents have'} recorded nothing</>
            )}
          </p>

          {/* Three roles stored in two different units, so the single bar above
              is a blend of three questions. Each is spelled out in the unit the
              bar actually uses — this cutoff — with the stored monthly or daily
              figure it was derived from in parentheses, so an admin can check
              the proration rather than take it on trust. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
            <span>
              Sales{' '}
              <span className="text-foreground font-medium">
                {cutoffTargetFor('sales_specialist', period, cutoffWorkingDays, workingDays) ?? '—'}
              </span>{' '}
              this cutoff
              {period.sales_target != null && <> (of {period.sales_target} a month)</>}
            </span>
            <span>
              Manager{' '}
              <span className="text-foreground font-medium">
                {cutoffTargetFor('sales_manager', period, cutoffWorkingDays, workingDays) ?? '—'}
              </span>{' '}
              this cutoff
              {period.manager_target != null && <> (of {period.manager_target} a month)</>}
            </span>
            <span>
              RSR{' '}
              <span className="text-foreground font-medium">
                {cutoffTargetFor('rsr', period, cutoffWorkingDays, workingDays) ?? '—'}
              </span>{' '}
              this cutoff
              {period.rsr_daily_target != null && (
                <> ({period.rsr_daily_target} per working day)</>
              )}
            </span>
          </div>
        </div>

        {/* ---- Only what somebody has to act on --------------------------- */}
        {(headline.overCap > 0 || headline.pending > 0 || disqualified.total > 0) && (
          <div className="flex flex-wrap gap-2">
            {headline.overCap > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <TriangleAlert className="w-4 h-4 text-destructive shrink-0" />
                <p className="text-xs text-foreground">
                  <span className="font-semibold">{headline.overCap}</span>{' '}
                  {headline.overCap === 1 ? 'visit went' : 'visits went'} past a client’s limit
                </p>
              </div>
            )}
            {headline.pending > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <Info className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0" />
                <p className="text-xs text-foreground">
                  <span className="font-semibold">{headline.pending}</span>{' '}
                  {headline.pending === 1 ? 'visit is' : 'visits are'} waiting on a manager’s
                  approval — these numbers can still change
                </p>
              </div>
            )}

            {/* Real work with no credit attached, and unlike the disqualified
                visits beside it this one is a defect rather than a decision. */}
            {uncreditedManagers > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs text-foreground">
                    <span className="font-semibold">{uncreditedManagers}</span> manager tag-
                    {uncreditedManagers === 1 ? 'along' : 'alongs'} earned no credit
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Late approval — they approved after the visit was scored.
                  </p>
                </div>
              </div>
            )}

            {/* Disqualified visits, split by cause. Real work that earned no
                credit is not a footnote: it is either a policy call the business
                should revisit or evidence that went missing, and the two need
                telling apart. */}
            {disqualified.total > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs text-foreground">
                    <span className="font-semibold">{disqualified.total}</span>{' '}
                    {disqualified.total === 1 ? 'meeting' : 'meetings'} didn’t qualify and earned
                    no credit
                  </p>
                  {/* Meetings, and each cause named separately — the sum is an
                      identity an admin can check against the Meetings Report's
                      own No Decision and Lost tiles, which a combined
                      "No Decision or Lost" figure made impossible. */}
                  <p className="text-[11px] text-muted-foreground">
                    {[
                      disqualified.lost > 0 && `${disqualified.lost} Lost`,
                      disqualified.noEvidence > 0 && `${disqualified.noEvidence} no evidence`,
                      disqualified.otherReason > 0 &&
                        `${disqualified.otherReason} tag-along declined`,
                      disqualified.unknown > 0 && `${disqualified.unknown} not loaded`,
                    ]
                      .filter(Boolean)
                      .join(' + ')}{' '}
                    = {disqualified.total}
                  </p>
                  {/* The one arm that is a defect rather than a decision. */}
                  {disqualified.noEvidence > 0 && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-500">
                      No photo, and no end-photo-plus-start-capture either — the visit happened
                      but couldn’t be evidenced. Worth checking whether capture is failing.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- The full breakdown, on request ------------------------------
            Kept, because O-5 requires every category to stay distinguishable —
            but folded away, because six equal tiles of schema vocabulary told
            an admin nothing about what to do. */}
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 -ml-2 text-xs text-muted-foreground"
            onClick={() => setShowBreakdown(v => !v)}
          >
            {showBreakdown ? (
              <ChevronDown className="w-3.5 h-3.5 mr-1" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 mr-1" />
            )}
            How the {total} {total === 1 ? 'record was' : 'records were'} classified in{' '}
            {period.label}
          </Button>

          {/* Ties this total back to the Meetings Report card, which counts
              ATTENDANCES and so reports a different number for the same cutoff.
              Both directions are stated because the gap runs both ways and an
              unexplained difference between two cards is what sent someone
              looking for a bug that was not there. */}
          {creditSpread.attendances > 0 && (
            <p className="text-[11px] text-muted-foreground ml-2">
              {creditSpread.meetings} meetings and {creditSpread.attendances} manager tag-
              {creditSpread.attendances === 1 ? 'along' : 'alongs'} — the same{' '}
              {creditSpread.meetings + creditSpread.attendances} records the Meetings Report
              shows for this cutoff. {creditSpread.credited} of the tag-alongs earned a
              credit; the rest either joined a visit that didn&rsquo;t qualify or are missing
              from the ledger — both are rows below.
            </p>
          )}

          {showBreakdown && (
            <div className="mt-2 rounded-lg border border-border divide-y divide-border">
              {ATTRIBUTION_ORDER.map(key => (
                <div key={key} className="flex items-start gap-3 px-3 py-2">
                  <span
                    className={`text-sm font-semibold tabular-nums w-8 shrink-0 text-right ${BUCKET_TONE[key]}`}
                  >
                    {buckets?.[key] ?? 0}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{BUCKET_PLAIN[key]}</p>
                    <p className="text-[11px] text-muted-foreground">{BUCKET_HINT[key]}</p>
                  </div>
                </div>
              ))}

              {/* A seventh row for what the ledger does not hold. Kept visually
                  identical to the six so it cannot be read as a footnote — it is
                  a classification like the others, just one the server never
                  wrote. It disappears when migration 107 backfills them. */}
              {uncreditedManagers > 0 && (
                <div className="flex items-start gap-3 px-3 py-2">
                  <span className="text-sm font-semibold tabular-nums w-8 shrink-0 text-right text-amber-600 dark:text-amber-500">
                    {uncreditedManagers}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">Late approval</p>
                    <p className="text-[11px] text-muted-foreground">
                      The manager approved after the visit was scored, so it counted for nobody.
                    </p>
                  </div>
                </div>
              )}

              {/* The stored figures, in the units they are stored in — the
                  prorated per-cutoff numbers are on the headline above.
                  rsr_daily_target, not the deprecated rsr_target this line used
                  to print — 064 stopped writing that column, so it showed a
                  frozen pre-064 number or "not set" however the target moved. */}
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                Stored targets: Sales{' '}
                {period.sales_target != null ? `${period.sales_target} a month` : 'not set'} ·
                Manager{' '}
                {period.manager_target != null ? `${period.manager_target} a month` : 'not set'} ·
                RSR{' '}
                {period.rsr_daily_target != null
                  ? `${period.rsr_daily_target} per working day`
                  : 'not set'}{' '}
                · the first two rows above are what counts toward them · spreadsheet exports
                use the same categories.
              </p>
            </div>
          )}
        </div>

        {/* Meetings inserted before migration 059's trigger have no ledger row
            at all — absent, not 'unattributed'. A report that stays silent about
            them implies those visits never happened. */}
        {unattributedMeetingCount > 0 && (
          <Alert>
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>
              {unattributedMeetingCount} older{' '}
              {unattributedMeetingCount === 1 ? 'meeting is' : 'meetings are'} not in this ledger
            </AlertTitle>
            <AlertDescription>
              They were recorded before cutoff attribution existed, so they carry no
              classification at all and appear in none of the buckets above. Nothing
              backfills them.
            </AlertDescription>
          </Alert>
        )}

        {/* ---- Day by day --------------------------------------------------
            RSRs are managed against a daily number, so a period total hides the
            thing that matters: which days had nothing. Non-working days are
            drawn but greyed — they are not misses, and omitting them entirely
            would make a fortnight look like a continuous run of work. */}
        {dailyExpectation != null && days.length > 0 && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-foreground">
              Each day against the roster&rsquo;s daily expectation of {dailyExpectation}
            </p>
            <div className="flex items-end gap-1 mt-2.5 h-16">
              {days.map(d => {
                const pctOfDay = Math.min(100, Math.round((d.count / dailyExpectation) * 100))
                return (
                  <div
                    key={d.date}
                    className="flex-1 flex flex-col items-center gap-1 min-w-0"
                    title={`${d.date} · ${d.count} ${d.count === 1 ? 'visit' : 'visits'}${
                      d.isWorkingDay ? '' : ' · not a working day'
                    }`}
                  >
                    <div className="w-full h-12 flex items-end rounded-sm bg-muted/50 overflow-hidden">
                      <div
                        className={`w-full rounded-sm ${
                          d.isWorkingDay ? 'bg-primary' : 'bg-muted-foreground/40'
                        }`}
                        style={{ height: `${Math.max(d.count > 0 ? 6 : 0, pctOfDay)}%` }}
                      />
                    </div>
                    <span
                      className={`text-[9px] tabular-nums ${
                        d.isWorkingDay ? 'text-muted-foreground' : 'text-muted-foreground/50'
                      }`}
                    >
                      {d.date.slice(8)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ---- Per team ---------------------------------------------------- */}
        {teamRows.length > 0 && (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2">Team</th>
                  <th className="text-right font-medium px-3 py-2">Agents</th>
                  <th className="text-right font-medium px-3 py-2">Toward target</th>
                  <th className="text-right font-medium px-3 py-2">Pending</th>
                  <th className="text-right font-medium px-3 py-2">Over cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {teamRows.map(u => (
                  <tr key={u.teamId ?? 'none'}>
                    <td className="px-3 py-2 text-foreground">
                      {u.teamId ? teamName(u.teamId) : 'No team'}
                      {/* Idle members are why the denominator looks big. Said
                          here so the gap reads as absence, not underperformance. */}
                      {u.idleMembers > 0 && (
                        <span className="text-muted-foreground">
                          {' '}· {u.idleMembers} idle
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {u.memberCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">
                      {u.towardTarget}
                      <span className="text-muted-foreground"> / {u.target ?? '—'}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-500">
                      {u.buckets.pending_validity || ''}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-destructive">
                      {u.buckets.over_cap || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={downloadTeamSummary}
            variant="outline"
            className="h-9 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 text-xs font-medium"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Per team ({teamRows.length})
          </Button>
          <Button
            onClick={downloadAgentSummary}
            variant="outline"
            className="h-9 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 text-xs font-medium"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Per agent ({byAgent.size})
          </Button>
          <Button
            onClick={downloadClientDetail}
            variant="outline"
            className="h-9 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 text-xs font-medium"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Per client ({byClient.size})
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
