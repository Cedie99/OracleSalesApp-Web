'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Pagination } from '@/components/ui/pagination'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { AddPoDialog, type AddPoDraft } from '@/components/delivery/add-po-dialog'
import { PoDetailDialog } from '@/components/delivery/po-detail-dialog'
import { TripBoard } from '@/components/delivery/trip-board'
import { usePurchaseOrders, useCodRemittances } from '@/lib/hooks/use-delivery'
import { useClients } from '@/lib/hooks/use-clients'
import { listableCustomers } from '@/lib/client-info'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { TripRuns } from '@/components/trip-runs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  NeedsAttention, type AttentionKey, type AttentionSignal,
} from '@/components/needs-attention'
import { isNotWorked, isStaleClaim, staleClaimCount } from '@/lib/claims'
import {
  buildTripLists, codVariance, deliveryTrips, dwellMinutes, hasMissingProof, isHeldCod,
  remainingCod, type TripList,
} from '@/lib/delivery'
import { peso, pesoDelta } from '@/lib/money'
import {
  COD_METHODS, DELIVERY_STATUS_LABEL, DELIVERY_STATUS_TONE, PAYMENT_METHOD_LABEL,
  REMITTANCE_STATUS_LABEL, REMITTANCE_STATUS_TONE, TONE_CLASS, TONE_TEXT,
} from '@/lib/status-styles'
import {
  PhotoLightbox, RemittanceProofThumb, captionFor, type LightboxPhoto,
} from '@/components/photo-lightbox'
import { RemittanceActions } from '@/components/remittance-actions'
import type { DeliveryStatus, PaymentMethod, PurchaseOrder, RemittanceStatus } from '@/types'
import {
  Search, Truck, Camera, PenLine, AlertTriangle, Banknote, Clock, ImageOff, Plus, PackageCheck,
  PackageX, Loader2,
} from 'lucide-react'
import { format } from 'date-fns'

/**
 * Delivery Admin (F-007).
 *
 * The delivery twin of the Collection Admin page, and structurally the same: the
 * admin *publishes* the work — one trip list per delivery day, every customer
 * with what is going on the truck — and then *reconciles* what came back, plus
 * the COD money against what was remitted.
 *
 * What the admin does NOT do is pick who delivers what. The list is a shared
 * pool; a driver works it down, and their name, their truck's plate, and the
 * stop's number in their run all land on the row at the moment they deliver it.
 * The sequence is driver-driven by explicit decision (2026-07-25) — it mirrors
 * the paper trip ticket, not a planned route. So this page groups by delivery
 * DAY, never by driver, and shows drivers only as after-the-fact contributors.
 *
 * That settles OQ-5, "who inputs the customer + plate trip list?" — the admin
 * publishes the list here and the driver picks it up and works it, the plate
 * included. Confirmed by Adrian 2026-07-27; the question is closed, so don't
 * reintroduce per-driver dispatch or an office-entered plate.
 *
 * Two things it words differently from Collection, both deliberate:
 *  1. **The COD amount is not withheld from the driver.** Collection hides
 *     `amount_due` to stop collectors anchoring to it; a COD figure is the fixed
 *     price of goods being handed over, so the driver sees it.
 *  2. **One day, one outcome.** A PO belongs to its delivery day: delivered, or
 *     failed with the goods riding back — a failed delivery IS a backload, not a
 *     separate state. Nothing counts down and nothing re-lists itself, so a
 *     failed stop sits on this page until an admin puts it on a later day's list
 *     or the office writes it off. That is why it gets its own stat card.
 *
 * GPS is no longer one of those differences: 2026-07-27 added coordinates to
 * delivery so the office can trace a driver's trip on the Maps page, the same
 * way it traces a collector's. See the reversal note on PurchaseOrder.
 *
 * The line items an earlier pass collected here are gone (2026-07-27): the trip
 * ticket is customer + plate, and the goods are on the paper PO the driver
 * carries. Admin lists the customer and the area, nothing more.
 *
 * Backed by the live `purchase_orders` and `cod_remittances` tables (migration
 * 044). A PO listed here is immediately visible to the driver's phone.
 */

/** How the Activity tab groups the same set of rows. */
type ActivityView = 'person' | 'store'

export default function DeliveryPage() {
  const { profile } = useCurrentProfile()

  const {
    orders, loading: ordersLoading, error: ordersError, createOrder, removeOrder, cancelClaim,
  } = usePurchaseOrders()
  const {
    codRemittances, error: codError, setStatus: setCodRemittanceStatus,
  } = useCodRemittances()
  const { clients } = useClients()
  /**
   * Who the Add-PO picker may offer. Prospects and in-progress clients have
   * never placed an order, so no PO of theirs can exist; lost and deleted
   * records are out too. See `isListableCustomer`.
   *
   * Only the picker is narrowed — `clients` stays whole for resolving stops
   * already on a list, which may well have gone lost since they were listed.
   */
  const listableClients = useMemo(() => listableCustomers(clients), [clients])
  const { profiles, byRole } = useProfiles()
  // Surfaces the reason a publish failed — an RLS rejection or a constraint
  // violation would otherwise look like the dialog simply not working.
  const [actionError, setActionError] = useState('')

  const [search, setSearch] = useState('')
  const [driverFilter, setDriverFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selected, setSelected] = useState<PurchaseOrder | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addDefaults, setAddDefaults] = useState<{ scheduledFor?: string } | undefined>(undefined)
  // Bumped on every opening so the dialog remounts with fresh fields — see the
  // note on AddPoDialog about why this isn't an effect.
  const [addSession, setAddSession] = useState(0)
  // Which remittance is mid-write, so only that card's buttons go quiet.
  const [remittanceBusyId, setRemittanceBusyId] = useState<string | null>(null)
  const [lightboxPhoto, setLightboxPhoto] = useState<LightboxPhoto | null>(null)

  const router = useRouter()
  const drivers = useMemo(() => byRole(['delivery']), [byRole])

  /**
   * Opens on ALL dates — see the twin note on the Collection page. A failed
   * stop especially does not stop mattering at midnight: nothing re-lists it,
   * so it sits here until an admin acts.
   */
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })
  const [attention, setAttention] = useState<AttentionKey | null>(null)
  /** True when isolating a signal widened the window the admin had narrowed. */
  const [widened, setWidened] = useState(false)
  const [activityView, setActivityView] = useState<ActivityView>('person')

  /**
   * Counted over ALL orders, never the windowed set — see NeedsAttention.
   * `failed` is the backload pile: goods that rode back on the truck and now
   * need re-listing or writing off, which nothing does automatically.
   */
  const signals = useMemo<AttentionSignal[]>(() => [
    {
      key: 'stuck',
      count: staleClaimCount(orders),
      label: ['claimed, never run', 'claimed, never run'],
      hint: 'A driver said they were on their way and never went. Different from "not worked", which nobody picked up at all — this one has a name on it. Claims never expire and each driver may hold only one, so that person cannot take any new stop until an admin releases it.',
    },
    {
      key: 'proof',
      count: orders.filter(hasMissingProof).length,
      label: ['missing proof', 'missing proofs'],
      hint: 'Closed out without a capture the phone should have required — a delivered stop with no proof photo, or a failed one with no backload photo.',
    },
    {
      key: 'failed',
      count: orders.filter(po => po.status === 'failed').length,
      label: ['came back', 'came back'],
      hint: 'Failed deliveries whose goods rode back. One day, one outcome — nothing rolls these forward, so an admin re-lists them on a later day or writes them off.',
    },
    {
      key: 'notworked',
      count: orders.filter(isNotWorked).length,
      label: ['not worked', 'not worked'],
      hint: 'Listed for a day that has passed and never claimed by anyone — the day was over-listed. Different from "came back" (a driver attempted it and the goods returned) and from "claimed, never run" (a driver committed and did not go). Nothing re-lists these, so they sit here until an admin puts them on a later day.',
    },
  ], [orders])

  /** See the twin note on the Collection page. */
  const toggleAttention = useCallback((key: AttentionKey | null) => {
    setAttention(key)
    if (key) {
      if (dateFilter.preset !== 'all') {
        setWidened(true)
        dateFilter.setPreset('all')
      }
    } else if (widened) {
      setWidened(false)
      dateFilter.reset()
    }
  }, [dateFilter, widened])

  const matchesAttention = useCallback(
    (po: PurchaseOrder) => {
      if (attention === 'stuck') return isStaleClaim(po)
      if (attention === 'proof') return hasMissingProof(po)
      if (attention === 'failed') return po.status === 'failed'
      if (attention === 'notworked') return isNotWorked(po)
      return true
    },
    [attention]
  )

  const matchesSearch = useCallback(
    (po: PurchaseOrder) => {
      const q = search.toLowerCase()
      return (
        po.po_number.toLowerCase().includes(q) ||
        (po.client?.company_name ?? '').toLowerCase().includes(q) ||
        po.area.toLowerCase().includes(q) ||
        (po.truck_plate ?? '').toLowerCase().includes(q) ||
        (po.driver?.full_name ?? '').toLowerCase().includes(q)
      )
    },
    [search]
  )

  const filteredOrders = useMemo(() => {
    const filtered = orders.filter(po => {
      const matchDriver = driverFilter === 'all' || po.driver_id === driverFilter
      const matchStatus = statusFilter === 'all' || po.status === statusFilter
      return matchesSearch(po) && matchDriver && matchStatus
        && dateFilter.inRange(po.scheduled_for) && matchesAttention(po)
    })

    // Failed deliveries first — they are the only rows waiting on someone here —
    // then what is still to run, then what is done.
    const rank = (po: PurchaseOrder) =>
      po.status === 'failed' ? 0 : po.status === 'pending' ? 1 : 2
    return [...filtered].sort((a, b) => rank(a) - rank(b) || a.po_number.localeCompare(b.po_number))
  }, [orders, driverFilter, statusFilter, matchesSearch, dateFilter, matchesAttention])

  /**
   * The trip lists honour the search box and the date window, but still ignore
   * the driver and status filters. A driver only lands on a row once the stop
   * has been run, so filtering by one would silently drop every stop still
   * waiting — the main thing an admin opens this tab to see.
   *
   * The driver selection is not discarded: it goes to TripBoard as a FOCUS,
   * dimming other people's rows rather than removing them.
   *
   * `scheduled_for` is safe to window on because the admin sets it when
   * publishing — every stop has one. Windowing on `time_out` would reintroduce
   * exactly the bug described above.
   */
  const lists = useMemo(
    () => buildTripLists(
      orders.filter(
        po => matchesSearch(po) && dateFilter.inRange(po.scheduled_for) && matchesAttention(po)
      )
    ),
    [orders, matchesSearch, dateFilter, matchesAttention]
  )

  /**
   * One entry per driver per day, in the order they ran it — the other half of
   * the Activity tab, over the same rows as `filteredOrders`.
   *
   * ⚠️ Runs are filtered WHOLE, never stop-by-stop — see the twin note on the
   * Collection page. `deliveryTrips` numbers stops by position within the group
   * it is handed, so a filtered subset would renumber the survivors and claim a
   * running order that never happened.
   */
  const trips = useMemo(() => {
    const scoped = orders.filter(
      po =>
        (driverFilter === 'all' || po.driver_id === driverFilter) &&
        dateFilter.inRange(po.scheduled_for)
    )
    const matched = new Set(filteredOrders.map(po => po.id))
    return deliveryTrips(scoped).filter(t => t.stops.some(s => matched.has(s.id)))
  }, [orders, driverFilter, dateFilter, filteredOrders])

  const remittances = useMemo(() => {
    const scoped = codRemittances.filter(
      r => driverFilter === 'all' || r.driver_id === driverFilter
    )
    // Variance first — a shortfall is the only row that needs someone to act.
    return [...scoped].sort((a, b) => {
      if (a.status === 'variance' && b.status !== 'variance') return -1
      if (b.status === 'variance' && a.status !== 'variance') return 1
      return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
    })
  }, [codRemittances, driverFilter])

  const ordersPage = usePagination(
    filteredOrders, 10, `${search}|${driverFilter}|${statusFilter}|${dateFilter.key}`
  )
  const remittancesPage = usePagination(remittances, 9, driverFilter)

  const stats = useMemo(() => {
    const today = new Date().toDateString()
    const codVisits = filteredOrders.filter(po => po.cod && po.cod_amount !== null)
    const collected = codVisits.reduce((sum, po) => sum + (po.cod_amount ?? 0), 0)

    const byMethod = { cash: 0, check: 0, gcash: 0, counter: 0 } as Record<PaymentMethod, number>
    codVisits.forEach(po => {
      if (po.cod_method) byMethod[po.cod_method] += po.cod_amount ?? 0
    })

    // Open on the list: still-waiting stops AND partials, which stay on the list
    // until their COD is fully paid (migration 073).
    const open = filteredOrders.filter(po => po.status === 'pending' || po.status === 'partial')

    return {
      collected,
      byMethod,
      remitted: remittances.reduce((sum, r) => sum + r.amount_remitted, 0),
      totalVariance: remittances.reduce((sum, r) => sum + codVariance(r), 0),
      // Money the driver is still holding: taken at a stop, not yet handed over.
      held: filteredOrders.filter(isHeldCod).reduce((sum, po) => sum + (po.cod_amount ?? 0), 0),
      open: open.length,
      // COD still to bring in: a pending stop owes its whole due, a partial only
      // the balance left on it.
      codOutstanding: open.reduce((sum, po) => {
        if (po.status === 'partial') return sum + remainingCod(po)
        return sum + (po.cod_due ?? 0)
      }, 0),
      failed: filteredOrders.filter(po => po.status === 'failed').length,
      failedToday: filteredOrders.filter(
        po => po.status === 'failed' && po.time_out &&
          new Date(po.time_out).toDateString() === today
      ).length,
      deliveredToday: filteredOrders.filter(
        po => po.status === 'delivered' && po.time_out &&
          new Date(po.time_out).toDateString() === today
      ).length,
      missingProof: filteredOrders.filter(hasMissingProof).length,
    }
  }, [filteredOrders, remittances])

  const openAdd = useCallback((defaults?: { scheduledFor?: string }) => {
    setAddDefaults(defaults)
    setAddSession(n => n + 1)
    setAddOpen(true)
  }, [])

  const handleAddPoToList = useCallback(
    (list: TripList) => openAdd({ scheduledFor: format(list.day, 'yyyy-MM-dd') }),
    [openAdd]
  )

  const handleAdd = useCallback(
    // Returns an error message, or null on success. The dialog needs to know
    // which it was: it stays open on "Save & add another", so it can only clear
    // its fields for the next sheet once this one is actually on the list.
    async (draft: AddPoDraft): Promise<string | null> => {
      // The customer name travels ONTO the row (migration 045) — the driver's
      // phone can't read `clients`. `area` already comes off the form. Refuse
      // rather than publish a PO the driver would see with no customer on it.
      const client = clients.find(c => c.id === draft.clientId)
      if (!client) {
        const message = 'That customer could not be found. Refresh and try again.'
        setActionError(message)
        return message
      }

      // Every driver-side column is left to the database defaults: nobody owns
      // the stop, and the GPS fix rides along with the photo taken at it, so a
      // freshly listed PO has no location either.
      const message = await createOrder({
        poNumber: draft.poNumber,
        clientId: draft.clientId,
        clientName: client.company_name,
        area: draft.area,
        scheduledFor: draft.scheduledFor,
        cod: draft.cod,
        codDue: draft.codDue,
        listedBy: profile?.id ?? null,
      })
      setActionError(message ?? '')
      return message ?? null
    },
    [createOrder, clients, profile?.id]
  )

  /** Only ever called for stops no driver has touched — see TripBoard. */
  /** Staged, not fired — see the twin note on the Collection page. */
  const [pendingAction, setPendingAction] =
    useState<{ kind: 'remove' | 'release'; po: PurchaseOrder } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const runPendingAction = useCallback(async () => {
    if (!pendingAction) return
    setActionBusy(true)
    const { kind, po } = pendingAction
    const message = kind === 'remove'
      ? await removeOrder(po.id)
      : await cancelClaim(po.id)
    setActionError(message ?? '')
    setActionBusy(false)
    setPendingAction(null)
  }, [pendingAction, removeOrder, cancelClaim])

  /**
   * Close out a COD remittance, or reopen one. The driver's app can't — migration
   * 044 gives it no UPDATE on `cod_remittances` — so the status only ever moves
   * off `submitted` from here.
   */
  const handleRemittanceStatus = useCallback(
    async (id: string, status: RemittanceStatus) => {
      setRemittanceBusyId(id)
      const message = await setCodRemittanceStatus(id, status)
      setRemittanceBusyId(null)
      setActionError(message ?? '')
    },
    [setCodRemittanceStatus]
  )

  const listedByName = selected
    ? profiles.find(p => p.id === selected.listed_by)?.full_name ??
      (selected.listed_by === profile?.id ? profile?.full_name ?? null : null)
    : null

  return (
    <div className="flex flex-col flex-1">
      <Header
        title="Delivery"
        subtitle={`${lists.length} trip lists · ${filteredOrders.length} POs · ${remittances.length} COD remittances`}
      />

      <div className="flex-1 p-6 space-y-4">
        {(ordersError || codError || actionError) && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              {actionError || ordersError || codError}
            </AlertDescription>
          </Alert>
        )}

        {ordersLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading delivery data…
          </div>
        )}

        {/* Queue and money summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Delivered today</p>
                <PackageCheck className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{stats.deliveredToday}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Photographed and timestamped
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Still to deliver</p>
                <Clock className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{stats.open}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Across all open lists · {peso(stats.codOutstanding)} of COD riding on them
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">COD held by drivers</p>
                <Banknote className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{peso(stats.held)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Collected, not yet remitted · {peso(stats.remitted)} handed over
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Came back</p>
                <PackageX
                  className={`w-4 h-4 ${stats.failed > 0 ? TONE_TEXT.red : 'text-muted-foreground'}`}
                />
              </div>
              <p className={`text-2xl font-semibold tabular-nums ${stats.failed > 0 ? TONE_TEXT.red : ''}`}>
                {stats.failed}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Failed and backloaded{stats.failedToday > 0 && `, ${stats.failedToday} today`} —
                re-list or write off
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search PO, customer, area, plate, or driver..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={driverFilter} onValueChange={v => setDriverFilter(v ?? 'all')}>
            <SelectTrigger className="w-48 h-9">
              <SelectValue placeholder="Driver" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Drivers</SelectItem>
              {drivers.map(d => (
                <SelectItem key={d.id} value={d.id}>{d.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
            <SelectTrigger className="w-40 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {(['pending', 'partial', 'delivered', 'failed'] as DeliveryStatus[]).map(s => (
                <SelectItem key={s} value={s}>{DELIVERY_STATUS_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DateRangeFilter filter={dateFilter} />
          <Button className="h-9" onClick={() => openAdd()}>
            <Plus /> Add PO
          </Button>
        </div>

        <NeedsAttention
          signals={signals} active={attention} widened={widened} onToggle={toggleAttention}
        />

        <Tabs defaultValue="lists">
          <TabsList>
            {/* One tab per JOB — see the twin note on the Collection page. */}
            <TabsTrigger value="lists">Lists ({lists.length})</TabsTrigger>
            <TabsTrigger value="activity">Activity ({filteredOrders.length})</TabsTrigger>
            <TabsTrigger value="remittances">COD Remittances ({remittances.length})</TabsTrigger>
          </TabsList>

          {/* --- Trip lists: the admin's own work --- */}
          <TabsContent value="lists" className="mt-4 space-y-4">
            <TripBoard
              lists={lists}
              focusWorkerId={driverFilter}
              onOpenPo={setSelected}
              onAddPo={handleAddPoToList}
              onRemovePo={po => setPendingAction({ kind: 'remove', po })}
              onCancelClaim={po => setPendingAction({ kind: 'release', po })}
            />
          </TabsContent>

          {/* --- Activity: what came back, grouped the way you need to read it --- */}
          <TabsContent value="activity" className="mt-4 space-y-3">
            {/* Same rows either way — only the grouping changes. */}
            <Tabs value={activityView} onValueChange={v => setActivityView(v as ActivityView)}>
              <TabsList className="h-8">
                <TabsTrigger value="person" className="text-xs px-3">
                  By driver ({trips.length})
                </TabsTrigger>
                <TabsTrigger value="store" className="text-xs px-3">
                  By stop ({filteredOrders.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {activityView === 'person' ? (
              <TripRuns
                trips={trips}
                nouns={{ stop: ['stop', 'stops'], worker: ['driver', 'drivers'] }}
                onOpenStop={id => {
                  const po = orders.find(o => o.id === id)
                  if (po) setSelected(po)
                }}
                onViewOnMap={trip => router.push(
                  `/maps?module=delivery&trip=${encodeURIComponent(trip.id)}`
                )}
              />
            ) : (
            <>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">PO</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Customer</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Area</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Driver</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Plate</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">COD</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Time in — out</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Proof</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ordersPage.pageItems.map(po => {
                      const proofGap = hasMissingProof(po)
                      return (
                        <tr
                          key={po.id}
                          onClick={() => setSelected(po)}
                          className="hover:bg-muted/20 cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className="font-medium text-foreground">{po.po_number}</span>
                            {po.sequence_no && (
                              <span className="ml-1.5 text-[11px] text-muted-foreground tabular-nums">
                                #{po.sequence_no}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <p className="text-foreground truncate max-w-[180px]">
                              {po.client?.company_name}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{po.area}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="tone" className={TONE_CLASS[DELIVERY_STATUS_TONE[po.status]]}>
                                {DELIVERY_STATUS_LABEL[po.status]}
                              </Badge>
                              {po.status === 'failed' && (
                                <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                  backloaded
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap">
                            {po.driver?.full_name ?? (
                              <span className="text-muted-foreground">Unclaimed</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {po.truck_plate ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                            {po.cod ? (
                              <>
                                <span className="font-medium">
                                  {po.cod_amount === null ? peso(po.cod_due ?? 0) : peso(po.cod_amount)}
                                </span>
                                {/* A partial still owes a balance — surface it in
                                    amber rather than a remittance state (073). */}
                                <span className={`block text-[11px] ${po.status === 'partial' ? TONE_TEXT.amber : 'text-muted-foreground'}`}>
                                  {po.status === 'partial'
                                    ? `${peso(remainingCod(po))} left`
                                    : po.cod_amount === null
                                      ? 'due'
                                      : po.cod_remitted
                                        ? 'remitted'
                                        : 'with driver'}
                                </span>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          {/* The trip report's own two columns, plus the dwell
                              they imply — the only read on how long a stop took. */}
                          <td className="px-4 py-3 text-xs whitespace-nowrap">
                            {po.time_in && po.time_out ? (
                              <>
                                <span className="text-foreground tabular-nums">
                                  {format(new Date(po.time_in), 'h:mm')} —{' '}
                                  {format(new Date(po.time_out), 'h:mm a')}
                                </span>
                                <span className="block text-muted-foreground tabular-nums">
                                  {format(new Date(po.time_out), 'MMM d')} · {dwellMinutes(po)} min
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              {po.proof_url && <Camera className="w-3.5 h-3.5 text-primary" />}
                              {po.backload_photo_url && <PackageX className="w-3.5 h-3.5 text-primary" />}
                              {po.receiver_signature_url && (
                                <PenLine className="w-3.5 h-3.5 text-muted-foreground" />
                              )}
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

                {filteredOrders.length === 0 && (
                  <div className="text-center py-16 text-muted-foreground">
                    <Truck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No purchase orders found</p>
                  </div>
                )}
              </div>
            </Card>

            <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
              A blank &ldquo;received by&rdquo; is normal — the name and the signature are
              both optional, because customers often refuse to give one. A photo and
              a &ldquo;Delivered&rdquo; remark are the proof that matters. A PO number can
              appear twice: that is one that failed and was listed again for another
              day.
              {stats.missingProof > 0 && (
                <>
                  {' '}
                  <span className={TONE_TEXT.red}>
                    {stats.missingProof} closed-out {stats.missingProof === 1 ? 'PO is' : 'POs are'} missing
                    a required capture (proof of delivery, COD payment, or backload photo).
                  </span>
                </>
              )}
            </p>

            <Pagination
              className="mt-4"
              page={ordersPage.page} pageCount={ordersPage.pageCount} onPageChange={ordersPage.setPage}
              from={ordersPage.from} to={ordersPage.to} total={ordersPage.total} itemLabel="purchase orders"
            />
            </>
            )}
          </TabsContent>

          {/* --- COD remittances --- */}
          <TabsContent value="remittances" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {remittancesPage.pageItems.map(r => {
                const delta = codVariance(r)
                return (
                  <Card key={r.id}>
                    <CardContent className="px-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground truncate">{r.driver?.full_name}</p>
                          <p className="text-xs text-muted-foreground">
                            Office · {format(new Date(r.submitted_at), 'MMM d, h:mm a')}
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
                        <span>Receiver: {r.receiver_name}</span>
                        <span className="text-muted-foreground">
                          {r.po_ids.length} {r.po_ids.length === 1 ? 'PO' : 'POs'}
                        </span>
                        {/* Office is the only destination here, so the signature is
                            never optional the way it is on a 7-11 collection drop. */}
                        {!r.receiver_signature_url && (
                          <span className={`inline-flex items-center gap-1 font-medium ${TONE_TEXT.red}`}>
                            <AlertTriangle className="w-3 h-3" /> Signature missing
                          </span>
                        )}
                      </div>

                      {/* The evidence the reconcile decision below rests on, so
                          it has to be readable — not just ticked off. */}
                      {r.receiver_signature_url && (
                        <div className="flex gap-2">
                          <RemittanceProofThumb
                            url={r.receiver_signature_url}
                            label="Signature"
                            caption={captionFor(r.receiver_name, r.submitted_at)}
                            signature
                            icon={<PenLine className="w-3 h-3" />}
                            onOpen={setLightboxPhoto}
                          />
                        </div>
                      )}

                      <RemittanceActions
                        status={r.status}
                        delta={delta}
                        busy={remittanceBusyId === r.id}
                        onSetStatus={status => handleRemittanceStatus(r.id, status)}
                      />
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {remittances.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Banknote className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No COD remittances found</p>
              </div>
            )}

            <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
              COD remits to the office only — the 7-11 and bank-deposit destinations
              Collection offers were dropped from the driver&apos;s screen, so the
              receiving officer&apos;s signature is always required.
              {' '}
              <span className="tabular-nums">
                {peso(stats.collected)} taken in
                {COD_METHODS.filter(m => stats.byMethod[m] > 0).length > 0 &&
                  ` (${COD_METHODS.filter(m => stats.byMethod[m] > 0)
                    .map(m => `${PAYMENT_METHOD_LABEL[m]} ${peso(stats.byMethod[m])}`)
                    .join(' · ')})`}
                .
              </span>
              {stats.totalVariance !== 0 && (
                <>
                  {' '}
                  <span className={TONE_TEXT.red}>
                    {pesoDelta(stats.totalVariance)} across all remittances.
                  </span>
                </>
              )}
            </p>

            <Pagination
              className="mt-4"
              page={remittancesPage.page} pageCount={remittancesPage.pageCount} onPageChange={remittancesPage.setPage}
              from={remittancesPage.from} to={remittancesPage.to} total={remittancesPage.total} itemLabel="remittances"
            />
          </TabsContent>
        </Tabs>
      </div>

      <AddPoDialog
        key={addSession}
        open={addOpen}
        onOpenChange={setAddOpen}
        clients={listableClients}
        orders={orders}
        defaults={addDefaults}
        onAdd={handleAdd}
      />

      <ConfirmDialog
        open={!!pendingAction}
        busy={actionBusy}
        destructive={pendingAction?.kind === 'remove'}
        title={pendingAction?.kind === 'remove' ? 'Remove this stop?' : 'Release this claim?'}
        confirmLabel={pendingAction?.kind === 'remove' ? 'Remove stop' : 'Release claim'}
        description={
          pendingAction?.kind === 'remove' ? (
            <>
              <span className="font-medium text-foreground">
                {pendingAction.po.po_number}
              </span>{' '}
              comes off this day&apos;s trip list and disappears from the drivers&apos; phones. Only
              a stop nobody has run or claimed can be removed, so no captured proof or COD is
              lost — but the goods still need a day, so re-list it.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">
                {pendingAction?.po.claimed_by_name ?? 'The driver'}
              </span>{' '}
              is on their way to{' '}
              <span className="font-medium text-foreground">
                {pendingAction?.po.client?.company_name ?? pendingAction?.po.po_number}
              </span>
              . Releasing puts it back in the shared pool for any driver, and frees their one claim
              slot — do it if they have finished for the day or the claim was a mistake.
            </>
          )
        }
        onConfirm={runPendingAction}
        onOpenChange={open => !open && setPendingAction(null)}
      />

      <PoDetailDialog
        po={selected}
        onOpenChange={open => !open && setSelected(null)}
        listedByName={listedByName}
      />

      {/* Opened from the remittance cards. The detail dialog carries its own,
          for the captures on a PO. */}
      <PhotoLightbox
        photo={lightboxPhoto}
        onOpenChange={open => !open && setLightboxPhoto(null)}
      />
    </div>
  )
}
