'use client'

import { useCallback, useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Pagination } from '@/components/ui/pagination'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { useCollectionVisits, useRemittances } from '@/lib/hooks/use-collection'
import { useClients } from '@/lib/hooks/use-clients'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AddStoreDialog, type AddStoreDraft } from '@/components/collection/add-store-dialog'
import { ListBoard } from '@/components/collection/list-board'
import { VisitDetailDialog } from '@/components/collection/visit-detail-dialog'
import { buildDays, hasMissingProof, remittanceVariance, type CollectionDay } from '@/lib/collection'
import { peso, pesoDelta } from '@/lib/money'
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABEL, PAYMENT_METHOD_TONE,
  REMITTANCE_DESTINATION_LABEL, REMITTANCE_STATUS_LABEL, REMITTANCE_STATUS_TONE,
  TONE_CLASS, TONE_TEXT, VISIT_STATUS_LABEL, VISIT_STATUS_TONE,
} from '@/lib/status-styles'
import type { CollectionVisit, PaymentMethod } from '@/types'
import {
  Search, Wallet, MapPin, Camera, PenLine, AlertTriangle, Banknote, Clock, ImageOff, Plus,
  Loader2,
} from 'lucide-react'
import { format } from 'date-fns'

/**
 * Collection Admin (F-007).
 *
 * The admin owns both ends of this module. They *publish* the work — one
 * collection list per day, every store with what it owes — and that list only
 * comes into existence here, because the collector's app is mobile-only with no
 * way to add a store (July 3 spec: "daily electronic collection list"). Then
 * they *reconcile* it: what came back against what was owed, and what was
 * remitted against what was collected.
 *
 * What the admin does NOT do is pick who collects what. The list is a shared
 * pool — the mobile wireframe's store rows carry no collector field at all, and
 * a collector simply works the list down, their name landing on a row when they
 * collect it. So this page groups by collection DAY, never by collector, and
 * shows collectors only as after-the-fact contributors.
 *
 * That is the answer to the July 3 meeting's OQ-4, "who assigns collection
 * routes/stores to collectors?" — nobody does, confirmed by Adrian 2026-07-27.
 * The question is closed; don't reintroduce per-collector assignment.
 *
 * The amount due lives on the office side of that split. It is entered here
 * and, per the 2026-07-25 anchoring-bias decision, deliberately withheld from
 * the collector's Collect Payment screen — they type what was actually handed
 * over, with no figure on screen to drift toward. So a gap between due and
 * collected is information about the store, not an accusation about the
 * collector, and this page words it that way.
 *
 * Backed by the live `collection_visits` and `remittances` tables (migration
 * 025). A store listed here is immediately visible to the collector's phone,
 * which is the whole point — this page is where a day's work comes into
 * existence.
 */

export default function CollectionPage() {
  const { profile } = useCurrentProfile()

  const {
    visits, loading: visitsLoading, error: visitsError, createVisit, removeVisit, cancelClaim,
  } = useCollectionVisits()
  const { remittances: allRemittances, error: remittancesError } = useRemittances()
  const { clients } = useClients()
  const { profiles, byRole } = useProfiles()
  // Surfaces the reason a publish failed — an RLS rejection or a constraint
  // violation would otherwise look like the dialog simply not working.
  const [actionError, setActionError] = useState('')

  const [search, setSearch] = useState('')
  const [collectorFilter, setCollectorFilter] = useState<string>('all')
  const [methodFilter, setMethodFilter] = useState<string>('all')
  const [selectedVisit, setSelectedVisit] = useState<CollectionVisit | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addDefaults, setAddDefaults] = useState<{ scheduledFor?: string } | undefined>(undefined)
  // Bumped on every opening so the dialog remounts with fresh fields — see the
  // note on AddStoreDialog about why this isn't an effect.
  const [addSession, setAddSession] = useState(0)

  const collectors = useMemo(() => byRole(['collector']), [byRole])

  const filteredVisits = useMemo(() => {
    const needle = search.toLowerCase()
    return visits.filter(v => {
      const matchSearch =
        (v.client?.company_name ?? '').toLowerCase().includes(needle) ||
        (v.collector?.full_name ?? '').toLowerCase().includes(needle)
      const matchCollector = collectorFilter === 'all' || v.collector_id === collectorFilter
      const matchMethod = methodFilter === 'all' || v.payment_method === methodFilter
      return matchSearch && matchCollector && matchMethod
    })
  }, [visits, search, collectorFilter, methodFilter])

  /**
   * The daily lists honour the search box but ignore the collector and method
   * filters. Both of those only have a value once a store has been collected,
   * so filtering by either would silently drop every store still waiting to be
   * picked up — which is the main thing an admin opens this tab to see.
   */
  const days = useMemo(() => {
    const needle = search.toLowerCase()
    const scoped = visits.filter(
      v =>
        (v.client?.company_name ?? '').toLowerCase().includes(needle) ||
        (v.collector?.full_name ?? '').toLowerCase().includes(needle)
    )
    return buildDays(scoped)
  }, [visits, search])

  const remittances = useMemo(() => {
    const scoped = allRemittances.filter(
      r => collectorFilter === 'all' || r.collector_id === collectorFilter
    )
    // Variance first — a shortfall is the only row that needs someone to act.
    return [...scoped].sort((a, b) => {
      if (a.status === 'variance' && b.status !== 'variance') return -1
      if (b.status === 'variance' && a.status !== 'variance') return 1
      return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
    })
  }, [allRemittances, collectorFilter])

  const visitsPage = usePagination(filteredVisits, 10, `${search}|${collectorFilter}|${methodFilter}`)
  const remittancesPage = usePagination(remittances, 9, collectorFilter)

  const stats = useMemo(() => {
    const collectedVisits = filteredVisits.filter(v => v.status === 'collected')
    const collected = collectedVisits.reduce((sum, v) => sum + (v.amount_collected ?? 0), 0)

    const byMethod = { cash: 0, check: 0, gcash: 0, counter: 0 } as Record<PaymentMethod, number>
    collectedVisits.forEach(v => {
      if (v.payment_method) byMethod[v.payment_method] += v.amount_collected ?? 0
    })

    const remitted = remittances.reduce((sum, r) => sum + r.amount_remitted, 0)

    return {
      collected,
      byMethod,
      remitted,
      totalVariance: remittances.reduce((sum, r) => sum + remittanceVariance(r), 0),
      // Money the collector is still holding: collected but not yet handed over.
      unremitted: collected - remitted,
      // Listed but not yet picked up — the outstanding exposure on the lists.
      outstanding: filteredVisits
        .filter(v => v.status === 'pending')
        .reduce((sum, v) => sum + v.amount_due, 0),
      pending: filteredVisits.filter(v => v.status === 'pending').length,
      missingProof: filteredVisits.filter(hasMissingProof).length,
    }
  }, [filteredVisits, remittances])

  const openAdd = useCallback((defaults?: { scheduledFor?: string }) => {
    setAddDefaults(defaults)
    setAddSession(n => n + 1)
    setAddOpen(true)
  }, [])

  const handleAddStoreToDay = useCallback(
    (day: CollectionDay) => openAdd({ scheduledFor: format(day.day, 'yyyy-MM-dd') }),
    [openAdd]
  )

  const handleAdd = useCallback(
    async (draft: AddStoreDraft) => {
      // The name and city travel ONTO the row (migration 045): the collector's
      // phone has no RLS read on `clients`, so a store published without them
      // shows up blank on the list. Refuse rather than publish a nameless row —
      // the admin can only have got here by picking from this same list.
      const client = clients.find(c => c.id === draft.clientId)
      if (!client) {
        setActionError('That customer could not be found. Refresh and try again.')
        return
      }

      // Everything the collector fills in is left to the database defaults —
      // the store belongs to nobody until someone actually works it.
      const message = await createVisit({
        clientId: draft.clientId,
        clientName: client.company_name,
        area: client.city ?? null,
        scheduledFor: draft.scheduledFor,
        amountDue: draft.amountDue,
        listedBy: profile?.id ?? null,
      })
      setActionError(message ?? '')
    },
    [createVisit, clients, profile?.id]
  )

  /** Only ever called for stores no collector has touched — see ListBoard. */
  const handleRemoveStore = useCallback(
    async (visit: CollectionVisit) => {
      const message = await removeVisit(visit.id)
      setActionError(message ?? '')
    },
    [removeVisit]
  )

  /**
   * Release a collector's hold so the store goes back in the pool. Claims never
   * expire, and a collector may only hold one at a time, so a claim left on an
   * unworked store blocks that person entirely until an admin clears it.
   */
  const handleCancelClaim = useCallback(
    async (visit: CollectionVisit) => {
      const message = await cancelClaim(visit.id)
      setActionError(message ?? '')
    },
    [cancelClaim]
  )

  const listedByName = selectedVisit
    ? profiles.find(p => p.id === selectedVisit.listed_by)?.full_name ??
      (selectedVisit.listed_by === profile?.id ? profile?.full_name ?? null : null)
    : null

  return (
    <div className="flex flex-col flex-1">
      <Header
        title="Collection"
        subtitle={`${days.length} lists · ${filteredVisits.length} stores · ${remittances.length} remittances`}
      />

      <div className="flex-1 p-6 space-y-4">
        {(visitsError || remittancesError || actionError) && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              {actionError || visitsError || remittancesError}
            </AlertDescription>
          </Alert>
        )}

        {visitsLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading collection data…
          </div>
        )}

        {/* Money summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Collected</p>
                <Wallet className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.collected)}</p>
              {/* Four methods no longer fit on one line, so empty buckets drop
                  out rather than padding the row with zeroes. */}
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {PAYMENT_METHODS.filter(m => stats.byMethod[m] > 0)
                  .map(m => `${PAYMENT_METHOD_LABEL[m]} ${peso(stats.byMethod[m])}`)
                  .join(' · ') || 'Nothing collected yet'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Still out</p>
                <Clock className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.outstanding)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {stats.pending} listed {stats.pending === 1 ? 'store' : 'stores'} not yet collected
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Held by collectors</p>
                <Banknote className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.unremitted)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Collected, not yet remitted · {peso(stats.remitted)} handed over
              </p>
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
                {pesoDelta(stats.totalVariance)}
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
              {PAYMENT_METHODS.map(m => (
                <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="h-9" onClick={() => openAdd()}>
            <Plus /> Add store
          </Button>
        </div>

        <Tabs defaultValue="lists">
          <TabsList>
            <TabsTrigger value="lists">Collection Lists ({days.length})</TabsTrigger>
            <TabsTrigger value="visits">Store Visits ({filteredVisits.length})</TabsTrigger>
            <TabsTrigger value="remittances">Remittances ({remittances.length})</TabsTrigger>
          </TabsList>

          {/* --- Collection lists: the admin's own work --- */}
          <TabsContent value="lists" className="mt-4 space-y-4">
            <ListBoard
              days={days}
              onOpenVisit={setSelectedVisit}
              onAddStore={handleAddStoreToDay}
              onRemoveStore={handleRemoveStore}
              onCancelClaim={handleCancelClaim}
            />
          </TabsContent>

          {/* --- Store visits: what came back --- */}
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
                    {visitsPage.pageItems.map(v => {
                      const short = v.amount_collected !== null && v.amount_collected < v.amount_due
                      const proofGap = hasMissingProof(v)
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
                          <td className="px-4 py-3 text-foreground">
                            {v.collector?.full_name ?? (
                              <span className="text-xs text-muted-foreground">Unclaimed</span>
                            )}
                          </td>
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
                          <td className={`px-4 py-3 text-right tabular-nums font-medium ${short ? TONE_TEXT.amber : ''}`}>
                            {v.amount_collected === null ? '—' : peso(v.amount_collected)}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {v.visited_at ? format(new Date(v.visited_at), 'MMM d, h:mm a') : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              {v.gps_lat !== null && <MapPin className="w-3.5 h-3.5 text-primary" />}
                              {v.payment_photo_url && <Camera className="w-3.5 h-3.5 text-primary" />}
                              {proofGap && (
                                <span
                                  className={`inline-flex items-center gap-1 text-[10px] font-medium ${TONE_TEXT.red}`}
                                  title="A required capture never arrived"
                                >
                                  <ImageOff className="w-3.5 h-3.5" /> missing
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {filteredVisits.length === 0 && (
                  <div className="text-center py-16 text-muted-foreground">
                    <Wallet className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No collection visits found</p>
                  </div>
                )}
              </div>
            </Card>

            <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
              A collected amount under the due figure is a partial payment by the
              store, not a collector shortfall — the collector&apos;s app never shows
              them what was owed.
              {stats.missingProof > 0 && (
                <>
                  {' '}
                  <span className={TONE_TEXT.red}>
                    {stats.missingProof} collected {stats.missingProof === 1 ? 'visit is' : 'visits are'} missing
                    a required capture (payment photo or delivery receipt).
                  </span>
                </>
              )}
            </p>

            <Pagination
              className="mt-4"
              page={visitsPage.page} pageCount={visitsPage.pageCount} onPageChange={visitsPage.setPage}
              from={visitsPage.from} to={visitsPage.to} total={visitsPage.total} itemLabel="visits"
            />
          </TabsContent>

          {/* --- Remittances --- */}
          <TabsContent value="remittances" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {remittancesPage.pageItems.map(r => {
                const delta = remittanceVariance(r)
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
                            <span className="tabular-nums">{pesoDelta(delta)}</span>
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
            <Pagination
              className="mt-4"
              page={remittancesPage.page} pageCount={remittancesPage.pageCount} onPageChange={remittancesPage.setPage}
              from={remittancesPage.from} to={remittancesPage.to} total={remittancesPage.total} itemLabel="remittances"
            />
          </TabsContent>
        </Tabs>
      </div>

      <AddStoreDialog
        key={addSession}
        open={addOpen}
        onOpenChange={setAddOpen}
        clients={clients}
        visits={visits}
        defaults={addDefaults}
        onAdd={handleAdd}
      />

      <VisitDetailDialog
        visit={selectedVisit}
        onOpenChange={open => !open && setSelectedVisit(null)}
        listedByName={listedByName}
      />
    </div>
  )
}
