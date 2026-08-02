'use client'

import { useMemo } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Pagination } from '@/components/ui/pagination'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import {
  Store, Wallet, HandCoins, AlertTriangle, CircleDollarSign, CameraOff, BarChart3,
} from 'lucide-react'
import { format, subDays, startOfDay } from 'date-fns'
import { useCollectionVisits, useRemittances } from '@/lib/hooks/use-collection'
import { hasMissingProof, remittanceVariance } from '@/lib/collection'
import { peso, pesoDelta } from '@/lib/money'
import type { PaymentMethod } from '@/types'
import {
  PAYMENT_METHOD_LABEL, PAYMENT_METHOD_TONE, PAYMENT_METHODS,
  REMITTANCE_STATUS_LABEL, REMITTANCE_STATUS_TONE,
  TONE_CLASS, TONE_TEXT, VISIT_STATUS_LABEL, VISIT_STATUS_TONE,
} from '@/lib/status-styles'

interface CollectionDashboardProps {
  headerAction?: React.ReactNode
}

/**
 * The Collection lens on the Dashboard.
 *
 * Answers what a Collection Admin actually opens the app for, in the order they
 * ask it: is today's published list getting worked, how much of what we expected
 * has come in, and how much of what came in is still sitting in a collector's
 * bag rather than in the office.
 *
 * That last figure ("Still held") is the one with no equivalent on the sales
 * dashboard and the reason this can't be a re-skin of it: money collected but
 * not yet remitted is the module's standing risk, and it is only knowable by
 * cross-checking visits against remittance `visit_ids`.
 *
 * Backed by mock data — no collection tables exist as of migration 024, matching
 * the Collection page itself.
 */
export function CollectionDashboard({ headerAction }: CollectionDashboardProps) {
  const dateFilter = useDateRangeFilter({ defaultPreset: '30d' })
  const { inRange } = dateFilter

  const { visits: allVisits } = useCollectionVisits()
  const { remittances } = useRemittances()

  const visits = useMemo(
    () => allVisits.filter(v => inRange(v.scheduled_for)),
    [allVisits, inRange]
  )

  const stats = useMemo(() => {
    const collected = visits.filter(v => v.status === 'collected')
    const rescheduled = visits.filter(v => v.status === 'rescheduled')
    const pending = visits.filter(v => v.status === 'pending')

    // Money handed over is tracked on the remittance, not on the visit — so a
    // visit counts as "still held" until some remittance names it.
    const remittedVisitIds = new Set(remittances.flatMap(r => r.visit_ids))
    const stillHeld = collected
      .filter(v => !remittedVisitIds.has(v.id))
      .reduce((sum, v) => sum + (v.amount_collected ?? 0), 0)

    return {
      listed: visits.length,
      collectedCount: collected.length,
      rescheduledCount: rescheduled.length,
      pendingCount: pending.length,
      totalDue: visits.reduce((sum, v) => sum + v.amount_due, 0),
      totalCollected: collected.reduce((sum, v) => sum + (v.amount_collected ?? 0), 0),
      outstanding: pending.reduce((sum, v) => sum + v.amount_due, 0),
      stillHeld,
      missingProof: visits.filter(hasMissingProof).length,
    }
  }, [visits, remittances])

  // Remittances aren't date-filtered by the visit window: a shortfall stays the
  // admin's problem regardless of which day's stores it came from.
  const variance = useMemo(
    () => remittances.reduce((sum, r) => sum + remittanceVariance(r), 0),
    [remittances]
  )

  const dailyTrend = useMemo(() => {
    const days = Array.from({ length: 14 }, (_, i) => startOfDay(subDays(new Date(), 13 - i)))
    const buckets = days.map(d => ({
      key: format(d, 'yyyy-MM-dd'),
      day: format(d, 'MMM d'),
      due: 0,
      collected: 0,
    }))
    const byKey = new Map(buckets.map(b => [b.key, b]))
    for (const visit of allVisits) {
      const bucket = byKey.get(visit.scheduled_for.slice(0, 10))
      if (!bucket) continue
      bucket.due += visit.amount_due
      bucket.collected += visit.amount_collected ?? 0
    }
    return buckets.map(({ day, due, collected }) => ({ day, due, collected }))
    // Deliberately reads `allVisits`, not the date-filtered `visits`: this chart
    // is always the trailing 14 days regardless of the period selector above it.
  }, [allVisits])

  const byMethod = useMemo(() => {
    const counts = Object.fromEntries(
      PAYMENT_METHODS.map(m => [m, { count: 0, amount: 0 }])
    ) as Record<PaymentMethod, { count: number; amount: number }>
    for (const visit of visits) {
      if (!visit.payment_method) continue
      // Guarded, not indexed directly: the database is shared with mobile, which
      // can ship a payment method before web widens PaymentMethod — exactly how
      // 'delivery_receipt' arrived on 2026-08-01. Indexing a Record keyed off
      // our union then crashed the whole dashboard on one unknown string, the
      // same failure an `executive` role once caused on the Users page. An
      // unrecognised method is now simply left out of this breakdown until
      // someone adds it, which is a gap rather than an outage.
      const bucket = counts[visit.payment_method]
      if (!bucket) continue
      bucket.count += 1
      bucket.amount += visit.amount_collected ?? 0
    }
    return counts
  }, [visits])

  const collectorPerformance = useMemo(() => {
    const byCollector = new Map<
      string,
      { id: string; name: string; avatarUrl: string | null; stores: number; collected: number; rescheduled: number }
    >()
    for (const visit of visits) {
      if (!visit.collector_id) continue
      const row = byCollector.get(visit.collector_id) ?? {
        id: visit.collector_id,
        name: visit.collector?.full_name ?? 'Unknown',
        avatarUrl: visit.collector?.avatar_url ?? null,
        stores: 0,
        collected: 0,
        rescheduled: 0,
      }
      row.stores += 1
      row.collected += visit.amount_collected ?? 0
      if (visit.status === 'rescheduled') row.rescheduled += 1
      byCollector.set(visit.collector_id, row)
    }
    return [...byCollector.values()].sort((a, b) => b.collected - a.collected)
  }, [visits])

  const perfPage = usePagination(collectorPerformance, 8, dateFilter.key)

  const recentVisits = useMemo(
    () =>
      [...visits]
        .filter(v => v.visited_at)
        .sort((a, b) => new Date(b.visited_at!).getTime() - new Date(a.visited_at!).getTime())
        .slice(0, 5),
    [visits]
  )

  const collectionRate =
    stats.totalDue > 0 ? Math.round((stats.totalCollected / stats.totalDue) * 100) : 0

  const metricCards = [
    {
      title: 'Stores Listed', value: String(stats.listed), icon: Store,
      sub: `${stats.pendingCount} still open`, color: 'text-primary',
    },
    {
      title: 'Collected', value: String(stats.collectedCount), icon: HandCoins,
      sub: `${stats.rescheduledCount} rescheduled`, color: TONE_TEXT.brand,
    },
    {
      title: 'Amount Collected', value: peso(stats.totalCollected), icon: Wallet,
      sub: `of ${peso(stats.totalDue)} due`, color: TONE_TEXT.brand,
    },
    {
      title: 'Outstanding', value: peso(stats.outstanding), icon: CircleDollarSign,
      sub: 'On unworked stores',
      color: stats.outstanding > 0 ? TONE_TEXT.amber : 'text-muted-foreground',
    },
    {
      title: 'Still Held', value: peso(stats.stillHeld), icon: AlertTriangle,
      sub: 'Collected, not remitted',
      color: stats.stillHeld > 0 ? TONE_TEXT.amber : 'text-muted-foreground',
    },
    {
      title: 'Missing Proof', value: String(stats.missingProof), icon: CameraOff,
      sub: 'Captures to chase',
      color: stats.missingProof > 0 ? TONE_TEXT.red : 'text-muted-foreground',
    },
  ]

  return (
    <>
      <Header
        title="Dashboard"
        subtitle={`Collection overview · ${dateFilter.label}`}
        action={headerAction}
      />

      <div className="flex-1 p-6 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">Period:</p>
          <DateRangeFilter filter={dateFilter} />
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
          <Card className="bg-card border-border lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">
                Due vs Collected — last 14 days
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dailyTrend} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 6%)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'oklch(0.55 0 0)' }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'oklch(0.55 0 0)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={v => `${Math.round(v / 1000)}k`}
                  />
                  <Tooltip
                    contentStyle={{ background: 'oklch(0.11 0 0)', border: '1px solid oklch(1 0 0 / 10%)', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: 'oklch(0.96 0 0)', fontWeight: 600 }}
                    itemStyle={{ color: 'oklch(0.75 0 0)' }}
                    formatter={value => (typeof value === 'number' ? peso(value) : String(value))}
                  />
                  <Bar dataKey="due" name="Due" fill="oklch(0.62 0.19 145 / 40%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="collected" name="Collected" fill="oklch(0.62 0.19 145)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">Collection Rate</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-muted-foreground">Of amount due</span>
                  <span className="text-foreground font-medium">{collectionRate}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${collectionRate}%` }} />
                </div>
              </div>

              <div className="pt-3 border-t border-border space-y-2">
                <p className="text-xs font-medium text-foreground">Store Status</p>
                {(['collected', 'rescheduled', 'pending'] as const).map(status => {
                  const count = visits.filter(v => v.status === status).length
                  return (
                    <div key={status} className="flex items-center justify-between">
                      <Badge variant="tone" className={TONE_CLASS[VISIT_STATUS_TONE[status]]}>
                        {VISIT_STATUS_LABEL[status]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{count}</span>
                    </div>
                  )
                })}
              </div>

              <div className="pt-3 border-t border-border space-y-2">
                <p className="text-xs font-medium text-foreground">Payment Method</p>
                {PAYMENT_METHODS.map(method => (
                  <div key={method} className="flex items-center justify-between">
                    <Badge variant="tone" className={TONE_CLASS[PAYMENT_METHOD_TONE[method]]}>
                      {PAYMENT_METHOD_LABEL[method]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {byMethod[method].count > 0 ? peso(byMethod[method].amount) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Collector performance */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm font-semibold text-foreground">Collector Performance</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left px-5 py-2.5 font-medium">Collector</th>
                    <th className="text-right px-5 py-2.5 font-medium">Stores</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden md:table-cell">Rescheduled</th>
                    <th className="text-right px-5 py-2.5 font-medium">Collected</th>
                    <th className="text-left px-5 py-2.5 font-medium w-40 hidden lg:table-cell">Share of total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {perfPage.pageItems.map(row => {
                    const share =
                      stats.totalCollected > 0
                        ? Math.round((row.collected / stats.totalCollected) * 100)
                        : 0
                    return (
                      <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar className="size-7 after:border-0">
                              {row.avatarUrl && <AvatarImage src={row.avatarUrl} alt="" />}
                              <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                                {row.name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <p className="font-medium text-foreground leading-tight">{row.name}</p>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right font-medium text-foreground">{row.stores}</td>
                        <td className="px-5 py-3 text-right hidden md:table-cell text-muted-foreground">
                          {row.rescheduled}
                        </td>
                        <td className="px-5 py-3 text-right font-medium text-foreground tabular-nums">
                          {peso(row.collected)}
                        </td>
                        <td className="px-5 py-3 hidden lg:table-cell">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${share}%` }} />
                            </div>
                            <span className="text-xs text-foreground font-medium w-9 text-right">{share}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {collectorPerformance.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  Nobody has worked a store in this period
                </div>
              )}
            </div>
            {perfPage.total > 0 && (
              <div className="px-5 py-3 border-t border-border">
                <Pagination
                  page={perfPage.page} pageCount={perfPage.pageCount} onPageChange={perfPage.setPage}
                  from={perfPage.from} to={perfPage.to} total={perfPage.total} itemLabel="collectors"
                />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent activity */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-foreground">Recent Collections</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {recentVisits.map(visit => (
                  <div key={visit.id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Store className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {visit.client?.company_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {visit.collector?.full_name ?? 'Unworked'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <Badge variant="tone" className={TONE_CLASS[VISIT_STATUS_TONE[visit.status]]}>
                        {VISIT_STATUS_LABEL[visit.status]}
                      </Badge>
                      <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                        {visit.amount_collected != null
                          ? peso(visit.amount_collected)
                          : format(new Date(visit.visited_at!), 'MMM d')}
                      </p>
                    </div>
                  </div>
                ))}
                {recentVisits.length === 0 && (
                  <div className="text-center py-10 text-muted-foreground text-sm">
                    No stores worked in this period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Remittances — the reconciliation side of the module. */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-sm font-semibold text-foreground">Remittances</CardTitle>
                {variance !== 0 && (
                  <span className={`text-xs font-medium ${TONE_TEXT.red}`}>
                    {pesoDelta(variance)} net variance
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {/* Variance first — a shortfall is the row an admin must not miss. */}
                {[...remittances]
                  .sort((a, b) => Math.abs(remittanceVariance(b)) - Math.abs(remittanceVariance(a)))
                  .slice(0, 5)
                  .map(remittance => {
                    const delta = remittanceVariance(remittance)
                    return (
                      <div key={remittance.id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Wallet className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {remittance.collector?.full_name ?? 'Unknown'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {peso(remittance.amount_remitted)} · {remittance.visit_ids.length} stores
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <Badge variant="tone" className={TONE_CLASS[REMITTANCE_STATUS_TONE[remittance.status]]}>
                            {REMITTANCE_STATUS_LABEL[remittance.status]}
                          </Badge>
                          {delta !== 0 && (
                            <p className={`text-xs mt-1 tabular-nums ${TONE_TEXT.red}`}>{pesoDelta(delta)}</p>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
