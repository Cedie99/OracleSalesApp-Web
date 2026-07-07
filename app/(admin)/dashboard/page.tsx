'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { mockDashboardMetrics, mockMeetings, mockEditRequests, mockProfiles } from '@/lib/mock/data'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'
import {
  CalendarCheck, TrendingUp, Target, Trophy,
  Users, CheckCircle2, Clock, Building2, BarChart3
} from 'lucide-react'
import { format } from 'date-fns'

const OUTCOME_COLOR: Record<string, string> = {
  successful: 'bg-primary/15 text-primary border-primary/30',
  follow_up: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  no_decision: 'bg-muted text-muted-foreground border-border',
  lost_opportunity: 'bg-destructive/15 text-destructive border-destructive/30',
}

const OUTCOME_LABEL: Record<string, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost',
}

const VIEW_OPTIONS = [
  { id: 'super_admin', label: 'Super Admin — All Teams & Agencies', teamId: null as string | null },
  { id: 'mgr-1', label: 'Manager View — Sir Eric Mendoza (Team 1)', teamId: 'team-1' },
  { id: 'mgr-2', label: 'Manager View — Sir Mike Lim (Team 2)', teamId: 'team-2' },
] as const

const FIELD_AGENT_ROLES = ['sales_specialist', 'rsr'] as const

export default function DashboardPage() {
  const m = mockDashboardMetrics
  const pending = mockEditRequests.filter(r => r.status === 'pending').length

  const [viewAs, setViewAs] = useState<string>('super_admin')
  const [perfAgentFilter, setPerfAgentFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')

  const currentView = VIEW_OPTIONS.find(v => v.id === viewAs) ?? VIEW_OPTIONS[0]

  const scopedAgents = useMemo(
    () =>
      mockProfiles.filter(
        p =>
          (FIELD_AGENT_ROLES as readonly string[]).includes(p.role) &&
          (currentView.teamId === null || p.team_id === currentView.teamId)
      ),
    [currentView]
  )

  const scopedMeetings = useMemo(
    () =>
      mockMeetings.filter(mtg => {
        const inTeam = currentView.teamId === null || mtg.agent?.team_id === currentView.teamId
        const inAgent = perfAgentFilter === 'all' || mtg.agent_id === perfAgentFilter
        const d = new Date(mtg.meeting_date)
        const afterFrom = !dateFrom || d >= new Date(dateFrom)
        const beforeTo = !dateTo || d <= new Date(`${dateTo}T23:59:59`)
        return inTeam && inAgent && afterFrom && beforeTo
      }),
    [currentView, perfAgentFilter, dateFrom, dateTo]
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

  const recentMeetings = mockMeetings
    .filter(mtg => currentView.teamId === null || mtg.agent?.team_id === currentView.teamId)
    .slice(0, 5)

  const metricCards = [
    {
      title: 'Total Meetings', value: m.totalMeetings, icon: CalendarCheck,
      sub: 'This month', color: 'text-primary',
    },
    {
      title: 'Existing Clients', value: m.meetingsByType.existing, icon: Users,
      sub: `${m.successfulByType.existing} successful`, color: 'text-blue-400',
    },
    {
      title: 'New Clients', value: m.meetingsByType.new, icon: TrendingUp,
      sub: `${m.successfulByType.new} successful`, color: 'text-yellow-400',
    },
    {
      title: 'Prospects', value: m.meetingsByType.prospect, icon: Target,
      sub: `${m.successfulByType.prospect} successful`, color: 'text-purple-400',
    },
    {
      title: 'Closed Deals', value: m.closedDeals, icon: Trophy,
      sub: 'Prospect → Closed', color: 'text-primary',
    },
    {
      title: 'Pending Approvals', value: pending, icon: Clock,
      sub: 'Awaiting review', color: pending > 0 ? 'text-yellow-400' : 'text-muted-foreground',
    },
  ]

  return (
    <div className="flex flex-col flex-1">
      <Header
        title="Dashboard"
        subtitle={`Overview for ${format(new Date(), 'MMMM yyyy')}`}
        pendingApprovals={pending}
      />

      <div className="flex-1 p-6 space-y-6">
        {/* Role-scoped view switcher */}
        <div className="flex items-center gap-3">
          <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground shrink-0">Viewing as:</p>
          <Select value={viewAs} onValueChange={v => setViewAs(v ?? 'super_admin')}>
            <SelectTrigger className="w-72 h-9 bg-card border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIEW_OPTIONS.map(opt => (
                <SelectItem key={opt.id} value={opt.id}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentView.teamId && (
            <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
              Scoped to {currentView.teamId}
            </Badge>
          )}
        </div>

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
                <BarChart data={m.monthlyTrend} barGap={4}>
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
                { label: 'Existing', meetings: m.meetingsByType.existing, successful: m.successfulByType.existing },
                { label: 'New', meetings: m.meetingsByType.new, successful: m.successfulByType.new },
                { label: 'Prospect', meetings: m.meetingsByType.prospect, successful: m.successfulByType.prospect },
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
                {Object.entries(OUTCOME_LABEL).map(([key, label]) => {
                  const count = mockMeetings.filter(m => m.outcome === key).length
                  return (
                    <div key={key} className="flex items-center justify-between">
                      <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${OUTCOME_COLOR[key]}`}>
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
                        {agent.team_id ?? '—'}
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
                    <p className="text-xs text-muted-foreground">{meeting.agent?.full_name} · {meeting.contact_person}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${OUTCOME_COLOR[meeting.outcome]}`}>
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
