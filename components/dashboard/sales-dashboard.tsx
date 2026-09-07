'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PersonSelect } from '@/components/ui/person-select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Pagination } from '@/components/ui/pagination'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { useSalesDashboard, FIELD_AGENT_ROLES } from '@/lib/hooks/use-sales-dashboard'
import { useTeams } from '@/lib/hooks/use-teams'
import { teamsWithManagers } from '@/lib/teams'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'
import {
  CalendarCheck, TrendingUp, Target, Trophy, Handshake,
  Users, CheckCircle2, Clock, BarChart3, Loader2
} from 'lucide-react'
import { format } from 'date-fns'
import type { CustomerType, MeetingOutcome } from '@/types'
import {
  APPROVAL_TONE,
  CUSTOMER_TYPE_LABEL,
  CUSTOMER_TYPE_TONE,
  OUTCOME_LABEL_SHORT as OUTCOME_LABEL,
  OUTCOME_TONE,
  TONE_CLASS,
  TONE_TEXT,
} from '@/lib/status-styles'

const ALL_TEAMS_VIEW = { id: 'all', label: 'All Teams & Agencies', shortLabel: 'All Teams', teamId: null as string | null }


interface SalesDashboardProps {
  /** The module switcher, when this admin has more than one lens. */
  headerAction?: React.ReactNode
}

/** The Sales lens on the Dashboard — meetings, agents, and the approval queue. */
export function SalesDashboard({ headerAction }: SalesDashboardProps) {
  const [viewAs, setViewAs] = useState<string>('all')
  const [perfAgentFilter, setPerfAgentFilter] = useState<string>('all')
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })

  const { profiles } = useProfiles()
  const { teams, teamName } = useTeams()

  // Built from the real `teams` rows rather than a hardcoded list, so a team
  // renamed or added on the mobile side shows up here without a code change —
  // the previous hardcoded labels had already drifted ("RSR Team 1" in code vs
  // "Team 3" in the database).
  const viewOptions = useMemo(
    () => [
      ALL_TEAMS_VIEW,
      ...teams.map(t => ({ id: t.id, label: t.name, shortLabel: t.name, teamId: t.id })),
    ],
    [teams]
  )

  const currentView = useMemo(
    () => viewOptions.find(v => v.id === viewAs) ?? ALL_TEAMS_VIEW,
    [viewOptions, viewAs]
  )

  const scopedAgents = useMemo(
    () =>
      profiles.filter(
        p =>
          (FIELD_AGENT_ROLES as readonly string[]).includes(p.role) &&
          (currentView.teamId === null || p.team_id === currentView.teamId)
      ),
    [profiles, currentView]
  )

  // Memoised because these arrays reach Combobox.Root as `items` via
  // PersonSelect. Rebuilt inline they would carry a new identity on every
  // render and make the picker re-derive its whole collection each time.
  const agentOptions = useMemo(
    () => scopedAgents.map(a => ({ id: a.id, name: a.full_name, teamId: a.team_id })),
    [scopedAgents]
  )
  const teamOptions = useMemo(
    () => teamsWithManagers(teams.map(t => ({ id: t.id, name: t.name })), profiles),
    [teams, profiles]
  )

  // Every figure on this page is a COUNT or a GROUP BY, so Postgres computes
  // them. This component used to download every meeting in the company and
  // every edit request to derive about thirty numbers. See migration 134.
  //
  // Three scopes live in that one call, and they are not interchangeable: the
  // metric cards, the trend and the recent list follow the TEAM filter only,
  // the cards narrow further to the current calendar month, and the Agent
  // Performance table alone also applies the agent and date filters below.
  const dashboardFilters = useMemo(
    () => ({
      teamId: currentView.teamId,
      agentId: perfAgentFilter === 'all' ? null : perfAgentFilter,
      range: dateFilter.range,
    }),
    [currentView.teamId, perfAgentFilter, dateFilter.range],
  )

  const {
    data: dashboard,
    loading: meetingsLoading,
    error: meetingsError,
  } = useSalesDashboard(dashboardFilters)

  const { metrics, monthlyTrend: trendRaw, agentPerformance, recentMeetings } = dashboard
  const { byType: meetingsByType, successfulByType } = metrics
  const closedDeals = metrics.closedDeals
  const pending = metrics.pending

  // The month label is formatted here rather than in SQL, so every date on the
  // page goes through date-fns exactly once.
  const monthlyTrend = useMemo(
    () => trendRaw.map(({ monthStart, total, successful }) => ({
      month: format(new Date(monthStart), 'MMM'),
      total,
      successful,
    })),
    [trendRaw],
  )

  // Still paginated in the browser: this list is one row per agent, bounded by
  // headcount rather than by the meetings table, so it never grows the way the
  // record lists do.
  const agentPage = usePagination(
    agentPerformance, 8, `${viewAs}|${perfAgentFilter}|${dateFilter.key}`,
  )

  const metricCards = [
    {
      title: 'Total Meetings', value: metrics.monthTotal, icon: CalendarCheck,
      sub: 'This month', color: 'text-primary',
    },
    // Derived from CUSTOMER_TYPE_TONE rather than restated, so a prospect reads
    // the same amber here as it does on its pill in the Clients table.
    {
      title: 'Existing Clients', value: meetingsByType.existing, icon: Users,
      sub: `${successfulByType.existing} successful`, color: TONE_TEXT[CUSTOMER_TYPE_TONE.existing],
    },
    {
      title: 'New Clients', value: meetingsByType.new, icon: TrendingUp,
      sub: `${successfulByType.new} successful`, color: TONE_TEXT[CUSTOMER_TYPE_TONE.new],
    },
    // The fourth stage, between prospect and new (migrations 038/040). Carded in
    // lifecycle position rather than appended, so the row reads as the funnel it is.
    {
      title: 'In Progress', value: meetingsByType.in_progress, icon: Handshake,
      sub: `${successfulByType.in_progress} successful`, color: TONE_TEXT[CUSTOMER_TYPE_TONE.in_progress],
    },
    {
      title: 'Prospects', value: meetingsByType.prospect, icon: Target,
      sub: `${successfulByType.prospect} successful`, color: TONE_TEXT[CUSTOMER_TYPE_TONE.prospect],
    },
    {
      title: 'Closed Deals', value: closedDeals, icon: Trophy,
      sub: 'Successful meetings', color: 'text-primary',
    },
    {
      title: 'Pending Approvals', value: pending, icon: Clock,
      sub: 'Awaiting review', color: pending > 0 ? TONE_TEXT[APPROVAL_TONE.pending] : 'text-muted-foreground',
    },
  ]

  return (
    <>
      <Header
        title="Dashboard"
        subtitle={`Sales overview for ${format(new Date(), 'MMMM yyyy')}`}
        pendingApprovals={pending}
        action={headerAction}
        viewSwitcher={{
          options: viewOptions.map(({ id, label }) => ({ id, label })),
          value: viewAs,
          activeLabel: currentView.shortLabel,
          onChange: setViewAs,
        }}
      />

      <div className="flex-1 p-6 space-y-6">
        {meetingsError && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              Couldn&apos;t load dashboard data: {meetingsError}
            </AlertDescription>
          </Alert>
        )}

        {meetingsLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading live data…
          </div>
        )}

        {/* Metric cards — seven since the lifecycle gained 'in_progress', so the
            column counts changed with it: 7 across on xl keeps the single row,
            and lg moves 3→4 so the second row carries 3 rather than a lone card. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
          {metricCards.map(({ title, value, icon: Icon, sub, color }) => (
            <Card key={title} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <p className="text-xs text-muted-foreground leading-tight">{title}</p>
                  <Icon className={`w-4 h-4 shrink-0 ${color}`} />
                </div>
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-muted-foreground mt-1">{sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Bar chart */}
          <Card className="bg-card border-border lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">Monthly Meetings Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={monthlyTrend} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 6%)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'oklch(0.55 0 0)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'oklch(0.55 0 0)' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: 'oklch(0.11 0 0)', border: '1px solid oklch(1 0 0 / 10%)', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: 'oklch(0.96 0 0)', fontWeight: 600 }}
                    itemStyle={{ color: 'oklch(0.75 0 0)' }}
                  />
                  <Bar dataKey="total" name="Total" fill="oklch(0.62 0.19 145 / 40%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="successful" name="Successful" fill="oklch(0.62 0.19 145)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Success Rate breakdown */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">Success Rate</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Driven off CUSTOMER_TYPE_LABEL rather than a literal list of three,
                  which is how this panel silently omitted 'in_progress' after
                  migration 038 added it. A future stage lands here on its own. */}
              {(Object.entries(CUSTOMER_TYPE_LABEL) as [CustomerType, string][]).map(([key, label]) => {
                const meetings = meetingsByType[key]
                const successful = successfulByType[key]
                const pct = meetings > 0 ? Math.round((successful / meetings) * 100) : 0
                return (
                  <div key={label}>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="text-foreground font-medium">{successful}/{meetings} ({pct}%)</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}

              <div className="pt-3 border-t border-border space-y-2">
                <p className="text-xs font-medium text-foreground">Meeting Outcomes</p>
                {(Object.entries(OUTCOME_LABEL) as [MeetingOutcome, string][]).map(([key, label]) => {
                  const count = metrics.outcomes[key]
                  return (
                    <div key={key} className="flex items-center justify-between">
                      <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[key]]}>
                        {label}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{count}</span>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Agent Performance */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-primary" />
                <CardTitle className="text-sm font-semibold text-foreground">Agent Performance</CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PersonSelect
                  options={agentOptions}
                  value={perfAgentFilter}
                  onChange={setPerfAgentFilter}
                  allLabel="All Agents"
                  // Only when the view spans every team is grouping worth its
                  // headings — inside one team they would all read the same.
                  teams={currentView.teamId === null ? teamOptions : undefined}
                  aria-label="Agent"
                  className="w-52"
                />
                <DateRangeFilter filter={dateFilter} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left px-5 py-2.5 font-medium">Agent</th>
                    <th className="text-left px-5 py-2.5 font-medium hidden md:table-cell">Team</th>
                    <th className="text-right px-5 py-2.5 font-medium">Total</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden lg:table-cell">Successful</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden lg:table-cell">Follow-up</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden xl:table-cell">No Decision</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden xl:table-cell">Lost</th>
                    <th className="text-left px-5 py-2.5 font-medium w-40">Success Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {agentPage.pageItems.map(({ agentId, agentName, agentRole, teamId, total, successful, followUp, noDecision, lost, rate }) => (
                    <tr key={agentId} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-foreground leading-tight">{agentName}</p>
                        <p className="text-xs text-muted-foreground capitalize">{agentRole.replace('_', ' ')}</p>
                      </td>
                      <td className="px-5 py-3 hidden md:table-cell text-xs text-muted-foreground">
                        {teamName(teamId)}
                      </td>
                      <td className="px-5 py-3 text-right font-medium text-foreground">{total}</td>
                      <td className="px-5 py-3 text-right hidden lg:table-cell text-muted-foreground">{successful}</td>
                      <td className="px-5 py-3 text-right hidden lg:table-cell text-muted-foreground">{followUp}</td>
                      <td className="px-5 py-3 text-right hidden xl:table-cell text-muted-foreground">{noDecision}</td>
                      <td className="px-5 py-3 text-right hidden xl:table-cell text-muted-foreground">{lost}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all"
                              style={{ width: `${rate}%` }}
                            />
                          </div>
                          <span className="text-xs text-foreground font-medium w-9 text-right">{rate}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {agentPerformance.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No agents in this scope
                </div>
              )}
            </div>
            {agentPage.total > 0 && (
              <div className="px-5 py-3 border-t border-border">
                <Pagination
                  page={agentPage.page} pageCount={agentPage.pageCount} onPageChange={agentPage.setPage}
                  from={agentPage.from} to={agentPage.to} total={agentPage.total} itemLabel="agents"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent meetings */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-foreground">Recent Meetings</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {recentMeetings.map((meeting) => (
                <div key={meeting.id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{meeting.client?.company_name}</p>
                    {/* Separator is conditional: 9 of 30 live meetings have a
                        blank contact_person, which otherwise leaves a dangling "·". */}
                    <p className="text-xs text-muted-foreground">
                      {[meeting.agent?.full_name, meeting.contact_person].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[meeting.outcome]]}>
                      {OUTCOME_LABEL[meeting.outcome]}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">
                      {format(new Date(meeting.meeting_date), 'MMM d')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
