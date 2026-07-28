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
  Package, Truck, PackageX, CircleDollarSign, AlertTriangle, CameraOff, BarChart3, Timer,
} from 'lucide-react'
import { format, subDays, startOfDay } from 'date-fns'
import { usePurchaseOrders, useCodRemittances } from '@/lib/hooks/use-delivery'
import { codVariance, dwellMinutes, hasMissingProof, isHeldCod, TRIP_CAP } from '@/lib/delivery'
import { peso, pesoDelta } from '@/lib/money'
import {
  DELIVERY_STATUS_LABEL, DELIVERY_STATUS_TONE,
  REMITTANCE_STATUS_LABEL, REMITTANCE_STATUS_TONE,
  TONE_CLASS, TONE_TEXT,
} from '@/lib/status-styles'

interface DeliveryDashboardProps {
  headerAction?: React.ReactNode
}

/**
 * The Delivery lens on the Dashboard — the Collection twin, in delivery nouns.
 *
 * Two figures here have no Collection equivalent and are the reason this is its
 * own component rather than a parameterised copy:
 *
 *  - **Failed stops.** A failed delivery means goods physically came back on the
 *    truck, and nothing re-lists itself (see the one-day rule on DeliveryStatus).
 *    Every failure is a decision an admin still owes, so it gets a card.
 *  - **Average dwell.** The paper trip report's TIME-IN/TIME-OUT pair is the only
 *    measure the office has of how long a stop really takes, and it is what a
 *    trip ticket's ~15-customer shape is built on.
 *
 * Backed by mock data — no delivery tables exist as of migration 024.
 */
export function DeliveryDashboard({ headerAction }: DeliveryDashboardProps) {
  const dateFilter = useDateRangeFilter({ defaultPreset: '30d' })
  const { inRange } = dateFilter

  const { orders: allOrders } = usePurchaseOrders()
  const { codRemittances } = useCodRemittances()

  const orders = useMemo(
    () => allOrders.filter(po => inRange(po.scheduled_for)),
    [allOrders, inRange]
  )

  const stats = useMemo(() => {
    const delivered = orders.filter(po => po.status === 'delivered')
    const failed = orders.filter(po => po.status === 'failed')
    const pending = orders.filter(po => po.status === 'pending')

    const dwells = orders.map(dwellMinutes).filter((d): d is number => d != null)
    const avgDwell =
      dwells.length > 0 ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : null

    return {
      listed: orders.length,
      deliveredCount: delivered.length,
      failedCount: failed.length,
      pendingCount: pending.length,
      codDue: orders.reduce((sum, po) => sum + (po.cod_due ?? 0), 0),
      codCollected: orders.reduce((sum, po) => sum + (po.cod_amount ?? 0), 0),
      // COD taken at a stop but not yet handed over — the driver is carrying it.
      codHeld: orders.filter(isHeldCod).reduce((sum, po) => sum + (po.cod_amount ?? 0), 0),
      missingProof: orders.filter(hasMissingProof).length,
      avgDwell,
    }
  }, [orders])

  const variance = useMemo(
    () => codRemittances.reduce((sum, r) => sum + codVariance(r), 0),
    [codRemittances]
  )

  const dailyTrend = useMemo(() => {
    const days = Array.from({ length: 14 }, (_, i) => startOfDay(subDays(new Date(), 13 - i)))
    const buckets = days.map(d => ({
      key: format(d, 'yyyy-MM-dd'),
      day: format(d, 'MMM d'),
      delivered: 0,
      failed: 0,
    }))
    const byKey = new Map(buckets.map(b => [b.key, b]))
    for (const po of allOrders) {
      const bucket = byKey.get(po.scheduled_for.slice(0, 10))
      if (!bucket) continue
      if (po.status === 'delivered') bucket.delivered += 1
      if (po.status === 'failed') bucket.failed += 1
    }
    return buckets.map(({ day, delivered, failed }) => ({ day, delivered, failed }))
    // Deliberately reads `allOrders`, not the date-filtered `orders`: this chart
    // is always the trailing 14 days regardless of the period selector above it.
  }, [allOrders])

  // Areas are how the paper trip ticket groups a run, so they are the natural
  // second axis here — the office plans by area, not by customer.
  const byArea = useMemo(() => {
    const areas = new Map<string, { area: string; stops: number; failed: number }>()
    for (const po of orders) {
      const row = areas.get(po.area) ?? { area: po.area, stops: 0, failed: 0 }
      row.stops += 1
      if (po.status === 'failed') row.failed += 1
      areas.set(po.area, row)
    }
    return [...areas.values()].sort((a, b) => b.stops - a.stops)
  }, [orders])

  const driverPerformance = useMemo(() => {
    const byDriver = new Map<
      string,
      {
        id: string; name: string; avatarUrl: string | null; plates: string[]
        stops: number; delivered: number; failed: number; cod: number; dwells: number[]
      }
    >()
    for (const po of orders) {
      if (!po.driver_id) continue
      const row = byDriver.get(po.driver_id) ?? {
        id: po.driver_id,
        name: po.driver?.full_name ?? 'Unknown',
        avatarUrl: po.driver?.avatar_url ?? null,
        plates: [],
        stops: 0,
        delivered: 0,
        failed: 0,
        cod: 0,
        dwells: [],
      }
      row.stops += 1
      if (po.status === 'delivered') row.delivered += 1
      if (po.status === 'failed') row.failed += 1
      row.cod += po.cod_amount ?? 0
      if (po.truck_plate && !row.plates.includes(po.truck_plate)) row.plates.push(po.truck_plate)
      const dwell = dwellMinutes(po)
      if (dwell != null) row.dwells.push(dwell)
      byDriver.set(po.driver_id, row)
    }
    return [...byDriver.values()]
      .map(row => ({
        ...row,
        avgDwell:
          row.dwells.length > 0
            ? Math.round(row.dwells.reduce((a, b) => a + b, 0) / row.dwells.length)
            : null,
        rate: row.stops > 0 ? Math.round((row.delivered / row.stops) * 100) : 0,
      }))
      .sort((a, b) => b.stops - a.stops)
  }, [orders])

  const perfPage = usePagination(driverPerformance, 8, dateFilter.key)

  const recentStops = useMemo(
    () =>
      [...orders]
        .filter(po => po.time_out)
        .sort((a, b) => new Date(b.time_out!).getTime() - new Date(a.time_out!).getTime())
        .slice(0, 5),
    [orders]
  )

  const successRate =
    stats.deliveredCount + stats.failedCount > 0
      ? Math.round((stats.deliveredCount / (stats.deliveredCount + stats.failedCount)) * 100)
      : 0

  const metricCards = [
    {
      title: 'Stops Listed', value: String(stats.listed), icon: Package,
      sub: `${stats.pendingCount} still waiting`, color: 'text-primary',
    },
    {
      title: 'Delivered', value: String(stats.deliveredCount), icon: Truck,
      sub: `${successRate}% of closed stops`, color: TONE_TEXT.brand,
    },
    {
      title: 'Failed', value: String(stats.failedCount), icon: PackageX,
      sub: 'Backloaded — needs a decision',
      color: stats.failedCount > 0 ? TONE_TEXT.red : 'text-muted-foreground',
    },
    {
      title: 'COD Collected', value: peso(stats.codCollected), icon: CircleDollarSign,
      sub: `of ${peso(stats.codDue)} due`, color: TONE_TEXT.brand,
    },
    {
      title: 'Held by Drivers', value: peso(stats.codHeld), icon: AlertTriangle,
      sub: 'Collected, not remitted',
      color: stats.codHeld > 0 ? TONE_TEXT.amber : 'text-muted-foreground',
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
        subtitle={`Delivery overview · ${dateFilter.label}`}
        action={headerAction}
      />

      <div className="flex-1 p-6 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">Period:</p>
          <DateRangeFilter filter={dateFilter} />
          {stats.avgDwell != null && (
            <Badge variant="outline" className="text-xs gap-1.5">
              <Timer className="w-3 h-3" />
              {stats.avgDwell} min average dwell
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
          <Card className="bg-card border-border lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">
                Delivered vs Failed — last 14 days
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dailyTrend} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 6%)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'oklch(0.55 0 0)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'oklch(0.55 0 0)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: 'oklch(0.11 0 0)', border: '1px solid oklch(1 0 0 / 10%)', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: 'oklch(0.96 0 0)', fontWeight: 600 }}
                    itemStyle={{ color: 'oklch(0.75 0 0)' }}
                  />
                  <Bar dataKey="delivered" name="Delivered" fill="oklch(0.62 0.19 145)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="failed" name="Failed" fill="oklch(0.65 0.2 25)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground">Coverage</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-muted-foreground">Delivered on first attempt</span>
                  <span className="text-foreground font-medium">{successRate}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${successRate}%` }} />
                </div>
              </div>

              <div className="pt-3 border-t border-border space-y-2">
                <p className="text-xs font-medium text-foreground">Stop Status</p>
                {(['delivered', 'failed', 'pending'] as const).map(status => {
                  const count = orders.filter(po => po.status === status).length
                  return (
                    <div key={status} className="flex items-center justify-between">
                      <Badge variant="tone" className={TONE_CLASS[DELIVERY_STATUS_TONE[status]]}>
                        {DELIVERY_STATUS_LABEL[status]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{count}</span>
                    </div>
                  )
                })}
              </div>

              <div className="pt-3 border-t border-border space-y-2">
                <p className="text-xs font-medium text-foreground">By Area</p>
                {byArea.slice(0, 6).map(({ area, stops, failed }) => (
                  <div key={area} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground truncate">{area}</span>
                    <span className="text-xs text-foreground shrink-0 tabular-nums">
                      {stops}
                      {failed > 0 && <span className={TONE_TEXT.red}> · {failed} failed</span>}
                    </span>
                  </div>
                ))}
                {byArea.length === 0 && (
                  <p className="text-xs text-muted-foreground">No stops in this period</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Driver performance */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm font-semibold text-foreground">Driver Performance</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left px-5 py-2.5 font-medium">Driver</th>
                    <th className="text-left px-5 py-2.5 font-medium hidden md:table-cell">Truck</th>
                    <th className="text-right px-5 py-2.5 font-medium">Stops</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden lg:table-cell">Failed</th>
                    <th className="text-right px-5 py-2.5 font-medium hidden xl:table-cell">Avg dwell</th>
                    <th className="text-right px-5 py-2.5 font-medium">COD</th>
                    <th className="text-left px-5 py-2.5 font-medium w-40 hidden lg:table-cell">Success</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {perfPage.pageItems.map(row => (
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
                      <td className="px-5 py-3 hidden md:table-cell text-xs text-muted-foreground">
                        {row.plates.join(', ') || '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-medium text-foreground">
                        {row.stops}
                        {row.stops > TRIP_CAP && (
                          <span className={`ml-1 text-[10px] ${TONE_TEXT.amber}`}>over cap</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right hidden lg:table-cell text-muted-foreground">
                        {row.failed}
                      </td>
                      <td className="px-5 py-3 text-right hidden xl:table-cell text-muted-foreground">
                        {row.avgDwell != null ? `${row.avgDwell}m` : '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-medium text-foreground tabular-nums">
                        {row.cod > 0 ? peso(row.cod) : '—'}
                      </td>
                      <td className="px-5 py-3 hidden lg:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${row.rate}%` }} />
                          </div>
                          <span className="text-xs text-foreground font-medium w-9 text-right">{row.rate}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {driverPerformance.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  Nobody has run a stop in this period
                </div>
              )}
            </div>
            {perfPage.total > 0 && (
              <div className="px-5 py-3 border-t border-border">
                <Pagination
                  page={perfPage.page} pageCount={perfPage.pageCount} onPageChange={perfPage.setPage}
                  from={perfPage.from} to={perfPage.to} total={perfPage.total} itemLabel="drivers"
                />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent stops */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-foreground">Recent Stops</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {recentStops.map(po => (
                  <div key={po.id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Package className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {po.client?.company_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[po.driver?.full_name, po.area].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <Badge variant="tone" className={TONE_CLASS[DELIVERY_STATUS_TONE[po.status]]}>
                        {DELIVERY_STATUS_LABEL[po.status]}
                      </Badge>
                      <p className="text-xs text-muted-foreground mt-1">
                        {format(new Date(po.time_out!), 'MMM d · HH:mm')}
                      </p>
                    </div>
                  </div>
                ))}
                {recentStops.length === 0 && (
                  <div className="text-center py-10 text-muted-foreground text-sm">
                    No stops run in this period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* COD remittances */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-sm font-semibold text-foreground">COD Remittances</CardTitle>
                {variance !== 0 && (
                  <span className={`text-xs font-medium ${TONE_TEXT.red}`}>
                    {pesoDelta(variance)} net variance
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {[...codRemittances]
                  .sort((a, b) => Math.abs(codVariance(b)) - Math.abs(codVariance(a)))
                  .slice(0, 5)
                  .map(remittance => {
                    const delta = codVariance(remittance)
                    return (
                      <div key={remittance.id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <CircleDollarSign className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {remittance.driver?.full_name ?? 'Unknown'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {peso(remittance.amount_remitted)} · {remittance.po_ids.length} stops
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
                {codRemittances.length === 0 && (
                  <div className="text-center py-10 text-muted-foreground text-sm">
                    No COD handed over yet
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
