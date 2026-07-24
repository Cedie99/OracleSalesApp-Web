'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useMeetings } from '@/lib/hooks/use-meetings'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { useTeams } from '@/lib/hooks/use-teams'
import { useEditRequests } from '@/lib/hooks/use-edit-requests'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'
import {
  CalendarCheck, TrendingUp, Target, Trophy,
  Users, CheckCircle2, Clock, BarChart3, Loader2
} from 'lucide-react'
import { format, isSameMonth, startOfMonth, subMonths } from 'date-fns'
import type { CustomerType, MeetingOutcome } from '@/types'
import {
  APPROVAL_TONE,
  CUSTOMER_TYPE_TONE,
  OUTCOME_LABEL_SHORT as OUTCOME_LABEL,
  OUTCOME_TONE,
  TONE_CLASS,
  TONE_TEXT,
} from '@/lib/status-styles'

const ALL_TEAMS_VIEW = { id: 'all', label: 'All Teams & Agencies', shortLabel: 'All Teams', teamId: null as string | null }

const FIELD_AGENT_ROLES = ['sales_specialist', 'rsr'] as const

export default function DashboardPage() {
  const [viewAs, setViewAs] = useState<string>('all')
  const [perfAgentFilter, setPerfAgentFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')

  const { meetings, loading: meetingsLoading, error: meetingsError } = useMeetings()
  const { profiles } = useProfiles()
  const { teams, teamName } = useTeams()
  const { requests: editRequests } = useEditRequests()

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

  // All meetings within the current team scope (not affected by the Agent
  // Performance table's own agent/date filters below) — drives the metric
  // cards, monthly trend, success rate, and outcome counts.
  const teamMeetings = useMemo(
    () => meetings.filter(mtg => currentView.teamId === null || mtg.agent?.team_id === currentView.teamId),
    [meetings, currentView]
  )

  const scopedMeetings = useMemo(
    () =>
      teamMeetings.filter(mtg => {
        const inAgent = perfAgentFilter === 'all' || mtg.agent_id === perfAgentFilter
        const d = new Date(mtg.meeting_date)
        const afterFrom = !dateFrom || d >= new Date(dateFrom)
        const beforeTo = !dateTo || d <= new Date(`${dateTo}T23:59:59`)
        return inAgent && afterFrom && beforeTo
      }),
    [teamMeetings, perfAgentFilter, dateFrom, dateTo]
  )

  const agentPerformance = useMemo(
    () =>
      scopedAgents
        .map(agent => {
          const meetings = scopedMeetings.filter(mtg => mtg.agent_id === agent.id)
          const successful = meetings.filter(mtg => mtg.outcome === 'successful').length
          const followUp = meetings.filter(mtg => mtg.outcome === 'follow_up').length
          const noDecision = meetings.filter(mtg => mtg.outcome === 'no_decision').length
          const lost = meetings.filter(mtg => mtg.outcome === 'lost_opportunity').length
          const rate = meetings.length > 0 ? Math.round((successful / meetings.length) * 100) : 0
          return { agent, total: meetings.length, successful, followUp, noDecision, lost, rate }
        })
        .sort((a, b) => b.total - a.total),
    [scopedAgents, scopedMeetings]
  )

  const recentMeetings = useMemo(
    () =>
      [...teamMeetings]
        .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
        .slice(0, 5),
    [teamMeetings]
  )

  const pending = useMemo(
    () =>
      editRequests.filter(
        r => r.status === 'pending' && (currentView.teamId === null || r.requester?.team_id === currentView.teamId)
      ).length,
    [editRequests, currentView]
  )

  // Just this calendar month, within the team scope — drives the metric
  // cards, success rate, and outcome counts (all "current month" stats).
  const monthMeetings = useMemo(
    () => teamMeetings.filter(mtg => isSameMonth(new Date(mtg.meeting_date), new Date())),
    [teamMeetings]
  )

  const meetingsByType = useMemo(() => {
    const counts: Record<CustomerType, number> = { existing: 0, new: 0, prospect: 0 }
    monthMeetings.forEach(mtg => {
      const type = mtg.client?.customer_type
      if (type) counts[type] += 1
    })
    return counts
  }, [monthMeetings])

  const successfulByType = useMemo(() => {
    const counts: Record<CustomerType, number> = { existing: 0, new: 0, prospect: 0 }
    monthMeetings.forEach(mtg => {
      const type = mtg.client?.customer_type
      if (mtg.outcome === 'successful' && type) counts[type] += 1
    })
    return counts
  }, [monthMeetings])

  const closedDeals = useMemo(
    () => monthMeetings.filter(mtg => mtg.outcome === 'successful').length,
    [monthMeetings]
  )

  // Always 12 buckets (this month + the trailing 11), zero-filled, so the
  // trend chart shows a real year regardless of how the data is distributed.
  const monthlyTrend = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => subMonths(startOfMonth(new Date()), 11 - i))
    const buckets = months.map(d => ({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      month: format(d, 'MMM'),
      total: 0,
      successful: 0,
    }))
    const bucketByKey = new Map(buckets.map(b => [b.key, b]))
    teamMeetings.forEach(mtg => {
      const d = new Date(mtg.meeting_date)
      const bucket = bucketByKey.get(`${d.getFullYear()}-${d.getMonth()}`)
      if (!bucket) return
      bucket.total += 1
      if (mtg.outcome === 'successful') bucket.successful += 1
    })
    return buckets.map(({ month, total, successful }) => ({ month, total, successful }))
  }, [teamMeetings])

  const metricCards = [
    {
      title: 'Total Meetings', value: monthMeetings.length, icon: CalendarCheck,
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
    <div className="flex flex-col flex-1">
      <Header
        title="Dashboard"
        subtitle={`Overview for ${format(new Date(), 'MMMM yyyy')}`}
        pendingApprovals={pending}
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

        {/* Metric cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
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
              {[
                { label: 'Existing', meetings: meetingsByType.existing, successful: successfulByType.existing },
                { label: 'New', meetings: meetingsByType.new, successful: successfulByType.new },
                { label: 'Prospect', meetings: meetingsByType.prospect, successful: successfulByType.prospect },
              ].map(({ label, meetings, successful }) => {
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
                  const count = monthMeetings.filter(mtg => mtg.outcome === key).length
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
                <Select value={perfAgentFilter} onValueChange={v => setPerfAgentFilter(v ?? 'all')}>
                  <SelectTrigger className="w-44 h-8 bg-card border-border text-xs">
                    <SelectValue placeholder="All Agents" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Agents</SelectItem>
                    {scopedAgents.map(a => (
                      <SelectItem key={a.id} value={a.id}>{a.full_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="w-36 h-8 bg-card border-border text-xs"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="w-36 h-8 bg-card border-border text-xs"
                />
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
                  {agentPerformance.map(({ agent, total, successful, followUp, noDecision, lost, rate }) => (
                    <tr key={agent.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-foreground leading-tight">{agent.full_name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{agent.role.replace('_', ' ')}</p>
                      </td>
                      <td className="px-5 py-3 hidden md:table-cell text-xs text-muted-foreground">
                        {teamName(agent.team_id)}
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
    </div>
  )
}
