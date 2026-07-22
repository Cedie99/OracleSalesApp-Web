'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mockCollectionVisits, mockRemittances, mockProfiles } from '@/lib/mock/data'
import {
  PAYMENT_METHOD_LABEL, PAYMENT_METHOD_TONE,
  REMITTANCE_DESTINATION_LABEL, REMITTANCE_STATUS_LABEL, REMITTANCE_STATUS_TONE,
  TONE_CLASS, TONE_TEXT, VISIT_STATUS_LABEL, VISIT_STATUS_TONE,
} from '@/lib/status-styles'
import type { CollectionVisit, PaymentMethod, Remittance } from '@/types'
import {
  Search, Wallet, MapPin, Camera, PenLine, AlertTriangle, Banknote, Clock,
} from 'lucide-react'
import { format } from 'date-fns'

/**
 * Collection oversight (F-007).
 *
 * Read-only by design. Collectors capture payments on the phone; web is where
 * superadmin/admin reconcile what was collected against what was remitted. There
 * is deliberately no way to record or edit a collection here — same stance the
 * app already takes on Meetings.
 *
 * Backed by mock data: no collection tables exist in the database (latest
 * migration is 022) and the mobile app has no collector screens yet.
 */

/** Philippine peso, no decimals — amounts in this domain are always whole pesos. */
function peso(n: number): string {
  return `₱${n.toLocaleString('en-PH')}`
}

function variance(r: Remittance): number {
  return r.amount_remitted - r.amount_collected
}

export default function CollectionPage() {
  const [search, setSearch] = useState('')
  const [collectorFilter, setCollectorFilter] = useState<string>('all')
  const [methodFilter, setMethodFilter] = useState<string>('all')
  const [selectedVisit, setSelectedVisit] = useState<CollectionVisit | null>(null)

  const collectors = useMemo(() => mockProfiles.filter(p => p.role === 'collector'), [])

  const visits = useMemo(() => {
    return mockCollectionVisits.filter(v => {
      const matchSearch =
        (v.client?.company_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (v.collector?.full_name ?? '').toLowerCase().includes(search.toLowerCase())
      const matchCollector = collectorFilter === 'all' || v.collector_id === collectorFilter
      const matchMethod = methodFilter === 'all' || v.payment_method === methodFilter
      return matchSearch && matchCollector && matchMethod
    })
  }, [search, collectorFilter, methodFilter])

  const remittances = useMemo(() => {
    const scoped = mockRemittances.filter(
      r => collectorFilter === 'all' || r.collector_id === collectorFilter
    )
    // Variance first — a shortfall is the only row that needs someone to act.
    return [...scoped].sort((a, b) => {
      if (a.status === 'variance' && b.status !== 'variance') return -1
      if (b.status === 'variance' && a.status !== 'variance') return 1
      return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
    })
  }, [collectorFilter])

  const stats = useMemo(() => {
    const collected = visits
      .filter(v => v.status === 'collected')
      .reduce((sum, v) => sum + (v.amount_collected ?? 0), 0)

    const byMethod = { cash: 0, check: 0, gcash: 0 } as Record<PaymentMethod, number>
    visits.forEach(v => {
      if (v.status === 'collected' && v.payment_method) {
        byMethod[v.payment_method] += v.amount_collected ?? 0
      }
    })

    const remitted = remittances.reduce((sum, r) => sum + r.amount_remitted, 0)
    const totalVariance = remittances.reduce((sum, r) => sum + variance(r), 0)

    return {
      collected,
      byMethod,
      remitted,
      totalVariance,
      // Money the collector is still holding: collected but not yet handed over.
      unremitted: collected - remitted,
      pending: visits.filter(v => v.status === 'pending').length,
      rescheduled: visits.filter(v => v.status === 'rescheduled').length,
    }
  }, [visits, remittances])

  return (
    <div className="flex flex-col flex-1">
      <Header title="Collection" subtitle={`${visits.length} visits · ${remittances.length} remittances`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Money summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Collected</p>
                <Wallet className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.collected)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Cash {peso(stats.byMethod.cash)} · Check {peso(stats.byMethod.check)} · GCash {peso(stats.byMethod.gcash)}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Remitted</p>
                <Banknote className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.remitted)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Handed over to office / bayad center</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Still held</p>
                <Clock className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.unremitted)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Collected, not yet remitted</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Variance</p>
                <AlertTriangle
                  className={`w-4 h-4 ${stats.totalVariance !== 0 ? TONE_TEXT.red : 'text-muted-foreground'}`}
                />
              </div>
              <p
                className={`text-2xl font-semibold tabular-nums ${stats.totalVariance !== 0 ? TONE_TEXT.red : ''}`}
              >
                {stats.totalVariance === 0 ? peso(0) : `${stats.totalVariance > 0 ? '+' : '−'}${peso(Math.abs(stats.totalVariance))}`}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Remitted minus collected</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search store or collector..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={collectorFilter} onValueChange={v => setCollectorFilter(v ?? 'all')}>
            <SelectTrigger className="w-48 h-9">
              <SelectValue placeholder="Collector" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Collectors</SelectItem>
              {collectors.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={methodFilter} onValueChange={v => setMethodFilter(v ?? 'all')}>
            <SelectTrigger className="w-40 h-9">
              <SelectValue placeholder="Method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Methods</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
              <SelectItem value="check">Check</SelectItem>
              <SelectItem value="gcash">GCash</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Tabs defaultValue="visits">
          <TabsList>
            <TabsTrigger value="visits">Store Visits ({visits.length})</TabsTrigger>
            <TabsTrigger value="remittances">Remittances ({remittances.length})</TabsTrigger>
          </TabsList>

          {/* --- Store visits --- */}
          <TabsContent value="visits" className="mt-4">
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Store</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Collector</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Method</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Due</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Collected</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Captured</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Proof</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visits.map(v => {
                      const short =
                        v.amount_collected !== null && v.amount_collected < v.amount_due
                      return (
                        <tr
                          key={v.id}
                          onClick={() => setSelectedVisit(v)}
                          className="hover:bg-muted/20 cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-3">
                            <p className="font-medium text-foreground truncate max-w-[180px]">
                              {v.client?.company_name}
                            </p>
                            <p className="text-xs text-muted-foreground truncate max-w-[180px]">
                              {v.client?.office_address}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-foreground">{v.collector?.full_name}</td>
                          <td className="px-4 py-3">
                            <Badge variant="tone" className={TONE_CLASS[VISIT_STATUS_TONE[v.status]]}>
                              {VISIT_STATUS_LABEL[v.status]}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {v.payment_method ? (
                              <Badge variant="tone" className={TONE_CLASS[PAYMENT_METHOD_TONE[v.payment_method]]}>
                                {PAYMENT_METHOD_LABEL[v.payment_method]}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                            {peso(v.amount_due)}
                          </td>
                          <td className={`px-4 py-3 text-right tabular-nums font-medium ${short ? TONE_TEXT.red : ''}`}>
                            {v.amount_collected === null ? '—' : peso(v.amount_collected)}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {v.visited_at ? format(new Date(v.visited_at), 'MMM d, h:mm a') : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1.5">
                              {v.gps_lat !== null && <MapPin className="w-3.5 h-3.5 text-primary" />}
                              {v.photo_url && <Camera className="w-3.5 h-3.5 text-primary" />}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {visits.length === 0 && (
                  <div className="text-center py-16 text-muted-foreground">
                    <Wallet className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No collection visits found</p>
                  </div>
                )}
              </div>
            </Card>
          </TabsContent>

          {/* --- Remittances --- */}
          <TabsContent value="remittances" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {remittances.map(r => {
                const delta = variance(r)
                // Office remittances require an in-app receiver signature before
                // submit; anything else legitimately has none.
                const signatureRequired = r.destination === 'office'
                return (
                  <Card key={r.id}>
                    <CardContent className="px-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground truncate">{r.collector?.full_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {REMITTANCE_DESTINATION_LABEL[r.destination]} ·{' '}
                            {format(new Date(r.submitted_at), 'MMM d, h:mm a')}
                          </p>
                        </div>
                        <Badge variant="tone" className={`shrink-0 ${TONE_CLASS[REMITTANCE_STATUS_TONE[r.status]]}`}>
                          {REMITTANCE_STATUS_LABEL[r.status]}
                        </Badge>
                      </div>

                      <div className="rounded-xl bg-muted/50 p-3 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Collected</span>
                          <span className="tabular-nums font-medium">{peso(r.amount_collected)}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Remitted</span>
                          <span className="tabular-nums font-medium">{peso(r.amount_remitted)}</span>
                        </div>
                        {delta !== 0 && (
                          <div className={`flex items-center justify-between text-xs font-semibold ${TONE_TEXT.red}`}>
                            <span>Variance</span>
                            <span className="tabular-nums">
                              {delta > 0 ? '+' : '−'}{peso(Math.abs(delta))}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        {r.receiver_name && <span>Receiver: {r.receiver_name}</span>}
                        {r.signed_proof_url && (
                          <span className="inline-flex items-center gap-1">
                            <Camera className="w-3 h-3" /> Signed proof
                          </span>
                        )}
                        {r.receiver_signature_url ? (
                          <span className="inline-flex items-center gap-1">
                            <PenLine className="w-3 h-3" /> Signature
                          </span>
                        ) : signatureRequired ? (
                          <span className={`inline-flex items-center gap-1 font-medium ${TONE_TEXT.red}`}>
                            <AlertTriangle className="w-3 h-3" /> Signature missing
                          </span>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {remittances.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Banknote className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No remittances found</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Visit detail */}
      <Dialog open={!!selectedVisit} onOpenChange={open => !open && setSelectedVisit(null)}>
        <DialogContent className="max-w-md">
          {selectedVisit && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedVisit.client?.company_name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="tone" className={TONE_CLASS[VISIT_STATUS_TONE[selectedVisit.status]]}>
                    {VISIT_STATUS_LABEL[selectedVisit.status]}
                  </Badge>
                  {selectedVisit.payment_method && (
                    <Badge variant="tone" className={TONE_CLASS[PAYMENT_METHOD_TONE[selectedVisit.payment_method]]}>
                      {PAYMENT_METHOD_LABEL[selectedVisit.payment_method]}
                    </Badge>
                  )}
                </div>

                <div className="rounded-xl bg-muted/50 p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Amount due</span>
                    <span className="tabular-nums font-medium">{peso(selectedVisit.amount_due)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Amount collected</span>
                    <span className="tabular-nums font-medium">
                      {selectedVisit.amount_collected === null ? '—' : peso(selectedVisit.amount_collected)}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Auto-captured</p>
                  <p className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 shrink-0" />
                    {selectedVisit.gps_lat !== null
                      ? `${selectedVisit.gps_lat.toFixed(4)}° N, ${selectedVisit.gps_lng?.toFixed(4)}° E`
                      : 'No GPS captured'}
                  </p>
                  <p className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    {selectedVisit.visited_at
                      ? format(new Date(selectedVisit.visited_at), 'MMM d, yyyy · h:mm a')
                      : 'Not yet visited'}
                  </p>
                </div>

                {selectedVisit.rescheduled_to && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Rescheduled to </span>
                    <span className="font-medium">
                      {format(new Date(selectedVisit.rescheduled_to), 'MMM d, yyyy')}
                    </span>
                  </p>
                )}

                {selectedVisit.remarks && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Remarks: </span>
                    {selectedVisit.remarks}
                  </p>
                )}

                {selectedVisit.photo_url && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={selectedVisit.photo_url}
                    alt="Payment proof"
                    className="w-full rounded-xl border border-border"
                  />
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
