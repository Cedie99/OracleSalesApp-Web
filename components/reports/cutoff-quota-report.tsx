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
  clientQuotaUsage,
  dailyUsage,
  periodDateLabel,
  periodPhase,
  reviewablePeriods,
  teamPeriodUsage,
  workingDaysIn,
} from '@/lib/cutoff'
import { downloadSheet } from '@/components/reports/report-grid'
import type { Client, Meeting, Profile } from '@/types'
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
}

export function CutoffQuotaReport({ clients, agents, meetings }: CutoffQuotaReportProps) {
  const { periods, loading: periodsLoading } = useCutoffPeriods()
  const { attributions, unattributedMeetingCount, loading: ledgerLoading } = useCutoffAttributions()
  const { teamName } = useTeams()
  const { holidays } = useQuotaSettings()
  const [periodId, setPeriodId] = useState<string>('')
  const [showBreakdown, setShowBreakdown] = useState(false)

  // Only periods that have started — a future one has nothing to report on.
  const options = useMemo(() => reviewablePeriods(periods), [periods])
  const period = options.find(p => p.id === periodId) ?? options[0] ?? null

  const buckets = useMemo(
    () => (period ? attributionBuckets(attributions, period) : null),
    [attributions, period]
  )

  const roleOf = useMemo(() => {
    const map = new Map(agents.map(a => [a.id, a.role as string]))
    return (id: string) => map.get(id)
  }, [agents])

  /**
   * Working days in the visible period. The denominator for every RSR figure
   * below — their target is per day, so the period expectation only exists once
   * this is known.
   */
  const workingDays = useMemo(
    () => (period ? workingDaysIn(period, holidays.map(h => h.holiday_date)) : 0),
    [period, holidays]
  )

  const byAgent = useMemo(
    () => (period ? agentPeriodUsage(attributions, period, roleOf, workingDays) : new Map()),
    [attributions, period, roleOf, workingDays]
  )
  const byClient = useMemo(
    () => (period ? clientQuotaUsage(attributions, period) : new Map()),
    [attributions, period]
  )

  const byTeam = useMemo(
    () => (period ? teamPeriodUsage(attributions, period, agents, workingDays) : new Map()),
    [attributions, period, agents, workingDays]
  )

  /** meeting_id -> its date, so daily counts sit on the day the visit happened. */
  const meetingDates = useMemo(
    () => new Map(meetings.map(m => [m.id, m.meeting_date.slice(0, 10)])),
    [meetings]
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

  const total = buckets ? Object.values(buckets).reduce((a, b) => a + b, 0) : 0

  /**
   * The headline figures.
   *
   * `toward` is what the contract measures agents on — counted plus prospect
   * visits (O-3) — not the raw meeting total, which would flatter everyone by
   * including meetings that qualified for nothing. The denominator sums the
   * teams' roster targets, so it does not shrink when agents are idle.
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
        // The unit and its inputs, so the target can be re-derived in the sheet
        // rather than taken on trust — 176 is meaningless without "16 x 11".
        'Target Basis': u.role === 'rsr' ? 'per working day' : u.role ? 'per cutoff' : '',
        'Daily Target': u.role === 'rsr' ? period.rsr_daily_target ?? '' : '',
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
              How every meeting in the period was classified by the server
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
                  of <span className="font-medium text-foreground">{headline.target}</span> meetings
                  targeted this cutoff
                </>
              ) : (
                <>
                  meetings counted this cutoff ·{' '}
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
            {period.label} · {workingDays} working {workingDays === 1 ? 'day' : 'days'} · each
            client may be visited {period.client_meeting_cap}{' '}
            {period.client_meeting_cap === 1 ? 'time' : 'times'} this cutoff
            {headline.idle > 0 && (
              <> · {headline.idle} {headline.idle === 1 ? 'agent has' : 'agents have'} recorded nothing</>
            )}
          </p>

          {/* Sales is a per-cutoff number and RSR a per-day one, so the single
              bar above is a blend of two different questions. Spelling both out
              stops it being read as one. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
            <span>
              Sales{' '}
              <span className="text-foreground font-medium">{period.sales_target ?? '—'}</span> per
              cutoff
            </span>
            <span>
              RSR{' '}
              <span className="text-foreground font-medium">
                {period.rsr_daily_target ?? '—'}
              </span>{' '}
              per working day
              {period.rsr_daily_target != null && (
                <> ({period.rsr_daily_target * workingDays} this cutoff)</>
              )}
            </span>
          </div>
        </div>

        {/* ---- Only what somebody has to act on --------------------------- */}
        {(headline.overCap > 0 || headline.pending > 0) && (
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
            How the {total} {total === 1 ? 'meeting was' : 'meetings were'} classified
          </Button>

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
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                Sales target {period.sales_target ?? 'not set'} · RSR target{' '}
                {period.rsr_target ?? 'not set'} · spreadsheet exports use the same categories.
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
        {period.rsr_daily_target != null && days.length > 0 && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-foreground">
              Each day against the RSR target of {period.rsr_daily_target}
            </p>
            <div className="flex items-end gap-1 mt-2.5 h-16">
              {days.map(d => {
                const pctOfDay = Math.min(
                  100,
                  Math.round((d.count / period.rsr_daily_target!) * 100)
                )
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
