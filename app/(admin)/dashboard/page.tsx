'use client'

import { Header } from '@/components/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { mockDashboardMetrics, mockMeetings, mockEditRequests } from '@/lib/mock/data'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'
import {
  CalendarCheck, TrendingUp, Target, Trophy,
  Users, CheckCircle2, Clock
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

export default function DashboardPage() {
  const m = mockDashboardMetrics
  const pending = mockEditRequests.filter(r => r.status === 'pending').length
  const recentMeetings = mockMeetings.slice(0, 5)

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
