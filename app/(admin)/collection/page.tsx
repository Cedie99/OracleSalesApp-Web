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
import { useCollectionVisits, useRemittances } from '@/lib/hooks/use-collection'
import { useClients } from '@/lib/hooks/use-clients'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AddStoreDialog, type AddStoreDraft } from '@/components/collection/add-store-dialog'
import { AdditionalBadge } from '@/components/collection/additional-badge'
import { listAdditionalStore } from './actions'
import { toast } from 'sonner'
import { ListBoard } from '@/components/collection/list-board'
import { VisitDetailDialog } from '@/components/collection/visit-detail-dialog'
import { TripRuns } from '@/components/trip-runs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  NeedsAttention, type AttentionKey, type AttentionSignal,
} from '@/components/needs-attention'
import { isNotWorked, isStaleClaim, staleClaimCount } from '@/lib/claims'
import {
  buildDays, collectionTrips, hasMissingProof, remainingBalance, remittanceVariance,
  type CollectionDay,
} from '@/lib/collection'
import { peso, pesoDelta } from '@/lib/money'
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABEL, PAYMENT_METHOD_TONE, paymentMethodLabel,
  REMITTANCE_DESTINATION_LABEL, REMITTANCE_STATUS_LABEL, REMITTANCE_STATUS_TONE,
  TONE_CLASS, TONE_TEXT, VISIT_STATUS_LABEL, VISIT_STATUS_TONE,
} from '@/lib/status-styles'
import {
  PhotoLightbox, RemittanceProofThumb, captionFor, type LightboxPhoto,
} from '@/components/photo-lightbox'
import { RemittanceActions } from '@/components/remittance-actions'
import type { CollectionVisit, PaymentMethod, RemittanceStatus } from '@/types'
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

/** How the Activity tab groups the same set of rows. */
type ActivityView = 'person' | 'store'

export default function CollectionPage() {
  const { profile } = useCurrentProfile()

  const {
    visits, loading: visitsLoading, error: visitsError, createVisit, removeVisit, cancelClaim,
    refresh: refreshVisits,
  } = useCollectionVisits()
  const {
    remittances: allRemittances, error: remittancesError, setStatus: setRemittanceStatus,
  } = useRemittances()
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
  // Which remittance is mid-write, so only that card's buttons go quiet.
  const [remittanceBusyId, setRemittanceBusyId] = useState<string | null>(null)
  const [lightboxPhoto, setLightboxPhoto] = useState<LightboxPhoto | null>(null)

  const router = useRouter()
  const collectors = useMemo(() => byRole(['collector']), [byRole])

  /**
   * Opens on ALL dates. A published list does not stop mattering at midnight —
   * a store still pending, a claim still held, money still unremitted all stay
   * the admin's problem on later days, so hiding them behind today's window
   * would mean the board only ever showed part of the job. The `‹ ›` stepper is
   * there to narrow deliberately.
   *
   * The needs-attention strip below still reads ALL visits rather than the
   * windowed set, so narrowing to a day never silences it.
   */
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })
  const [attention, setAttention] = useState<AttentionKey | null>(null)
  /** True when isolating a signal widened the window the admin had narrowed. */
  const [widened, setWidened] = useState(false)
  const [activityView, setActivityView] = useState<ActivityView>('person')

  /**
   * Counted over ALL visits, never the windowed set — see NeedsAttention for
   * why. `unremitted` is money a collector is still holding: collected on a
   * closed-out store but not yet handed over at any remittance.
   */
  const signals = useMemo<AttentionSignal[]>(() => {
    const remitted = allRemittances.reduce((sum, r) => sum + r.amount_collected, 0)
    const collected = visits.reduce((sum, v) => sum + (v.amount_collected ?? 0), 0)
    return [
      {
        key: 'stuck',
        count: staleClaimCount(visits),
        label: ['claimed, never worked', 'claimed, never worked'],
        hint: 'A collector said they were on their way and never went. Different from "not worked", which nobody picked up at all — this one has a name on it. Claims never expire and each collector may hold only one, so that person cannot take any new store until an admin releases it.',
      },
      {
        key: 'proof',
        count: visits.filter(hasMissingProof).length,
        label: ['missing proof', 'missing proofs'],
        hint: 'Collected without a capture the phone should have required. Chase the collector while they still remember the store.',
      },
      {
        key: 'unremitted',
        // A magnitude, not a tally — see `display` on AttentionSignal.
        count: Math.max(0, Math.round(collected - remitted)),
        label: ['unremitted', 'unremitted'],
        display: `${peso(Math.max(0, collected - remitted))} unremitted`,
        hint: 'Collected but not yet handed over at any remittance — money still on a collector.',
      },
      {
        key: 'notworked',
        count: visits.filter(isNotWorked).length,
        label: ['not worked', 'not worked'],
        hint: 'Listed for a day that has passed and never claimed by anyone — the day was over-listed. Different from "rescheduled" (a collector went and agreed another date) and from "claimed, never worked" (a collector committed and did not go). Nothing re-lists these, so they sit here until an admin puts them on a later day.',
      },
    ]
  }, [visits, allRemittances])

  /**
   * Isolating a signal only makes sense across all of history — the offending
   * row is usually on an older day, which is the whole reason it needs chasing.
   *
   * Widening is a no-op at the default, and only kicks in when the admin has
   * stepped to a specific day. Tracked so the strip mentions it only when it
   * actually happened, rather than narrating a change nobody saw.
   */
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

  /** Rows matching the isolated signal. Identity when nothing is isolated. */
  const matchesAttention = useCallback(
    (v: CollectionVisit) => {
      if (attention === 'stuck') return isStaleClaim(v)
      if (attention === 'proof') return hasMissingProof(v)
      // 'unremitted' is a peso total, not a per-row flag — the closest useful
      // row set is everything collected, which is what the money came from.
      if (attention === 'unremitted') return v.status === 'collected'
      if (attention === 'notworked') return isNotWorked(v)
      return true
    },
    [attention]
  )

  const filteredVisits = useMemo(() => {
    const needle = search.toLowerCase()
    return visits.filter(v => {
      const matchSearch =
        (v.client?.company_name ?? '').toLowerCase().includes(needle) ||
        (v.collector?.full_name ?? '').toLowerCase().includes(needle)
      const matchCollector = collectorFilter === 'all' || v.collector_id === collectorFilter
      const matchMethod = methodFilter === 'all' || v.payment_method === methodFilter
      return matchSearch && matchCollector && matchMethod
        && dateFilter.inRange(v.scheduled_for) && matchesAttention(v)
    })
  }, [visits, search, collectorFilter, methodFilter, dateFilter, matchesAttention])

  /**
   * The daily lists honour the search box and the date window, but still ignore
   * the collector and method filters. Both of those only have a value once a
   * store has been collected, so filtering by either would silently drop every
   * store still waiting to be picked up — the main thing an admin opens this tab
   * to see.
   *
   * The collector selection is not discarded, though: it is handed to ListBoard
   * as a FOCUS, which dims other people's rows instead of removing them. That
   * answers "show me Marisa's stores" without hiding the shared pool.
   *
   * The date window is safe to apply here because `scheduled_for` is set when
   * the admin publishes the row — every store has one, pending or not. Filtering
   * on `visited_at` would reintroduce exactly the bug described above.
   */
  const days = useMemo(() => {
    const needle = search.toLowerCase()
    const scoped = visits.filter(
      v =>
        ((v.client?.company_name ?? '').toLowerCase().includes(needle) ||
          (v.collector?.full_name ?? '').toLowerCase().includes(needle)) &&
        dateFilter.inRange(v.scheduled_for) &&
        matchesAttention(v)
    )
    return buildDays(scoped)
  }, [visits, search, dateFilter, matchesAttention])

  /**
   * One entry per collector per day, in the order they worked it — the other
   * half of the Activity tab, over the same rows as `filteredVisits`.
   *
   * ⚠️ Runs are filtered WHOLE, never stop-by-stop. `collectionTrips` numbers
   * each stop by its position within the group it is given, so handing it a
   * filtered subset would renumber the survivors: a five-store run matching on
   * two would render them ① and ② when they were really the 3rd and 5th stores
   * of the day. That is the same class of lie as the stored `sequence_no` the
   * board stopped showing. So the window and the collector scope build the run
   * (both are day/person selectors, which is exactly what a run IS), and every
   * other filter only decides whether the run appears at all.
   */
  const trips = useMemo(() => {
    const scoped = visits.filter(
      v =>
        (collectorFilter === 'all' || v.collector_id === collectorFilter) &&
        dateFilter.inRange(v.scheduled_for)
    )
    const matched = new Set(filteredVisits.map(v => v.id))
    return collectionTrips(scoped).filter(t => t.stops.some(s => matched.has(s.id)))
  }, [visits, collectorFilter, dateFilter, filteredVisits])

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

  const visitsPage = usePagination(
    filteredVisits, 10, `${search}|${collectorFilter}|${methodFilter}|${dateFilter.key}`
  )
  const remittancesPage = usePagination(remittances, 9, collectorFilter)

  const stats = useMemo(() => {
    // All money actually in hand — a partial store's running total counts too, not
    // just fully-collected ones (migration 070). Every non-open visit and every
    // partial carries a real amount_collected; pending/rescheduled are null.
    const collected = filteredVisits.reduce((sum, v) => sum + (v.amount_collected ?? 0), 0)

    // Built from PAYMENT_METHODS rather than a hand-written literal: a literal
    // silently went stale when 'delivery_receipt' landed, and the miss showed up
    // as `undefined + n` → NaN in a bucket, which the `> 0` filter below then
    // hid completely. A wrong total that hides itself is worse than a crash.
    const byMethod = Object.fromEntries(
      PAYMENT_METHODS.map(m => [m, 0])
    ) as Record<PaymentMethod, number>
    filteredVisits.forEach(v => {
      // Prefer the per-installment rows: a partial (or a store paid off through
      // installments) can span methods, so bucket each payment by its own method.
      // Fall back to the visit level for a store paid in one visit, which has no
      // payment rows.
      if (v.payments && v.payments.length > 0) {
        v.payments.forEach(p => {
          if (byMethod[p.payment_method] !== undefined) byMethod[p.payment_method] += p.amount
        })
      } else if (v.status === 'collected' && v.payment_method && byMethod[v.payment_method] !== undefined) {
        byMethod[v.payment_method] += v.amount_collected ?? 0
      }
    })

    const remitted = remittances.reduce((sum, r) => sum + r.amount_remitted, 0)

    return {
      collected,
      byMethod,
      remitted,
      totalVariance: remittances.reduce((sum, r) => sum + remittanceVariance(r), 0),
      // Money the collector is still holding: collected but not yet handed over.
      unremitted: collected - remitted,
      // What the lists still have to bring in: a pending store's whole due plus a
      // partial store's remaining balance.
      outstanding: filteredVisits.reduce((sum, v) => {
        if (v.status === 'pending') return sum + v.amount_due
        if (v.status === 'partial') return sum + remainingBalance(v)
        return sum
      }, 0),
      pending: filteredVisits.filter(v => v.status === 'pending').length,
      partial: filteredVisits.filter(v => v.status === 'partial').length,
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

      // An "additional" store fires an SMS, so it can't go through the
      // client-side insert (the BusyBee key is server-only). It routes through a
      // server action that lists the row AND texts every active collector; the
      // hook doesn't see that write, so reload after it lands.
      if (draft.isAdditional) {
        const result = await listAdditionalStore({
          clientId: draft.clientId,
          clientName: client.company_name,
          area: client.city ?? null,
          scheduledFor: draft.scheduledFor,
          amountDue: draft.amountDue,
          listedBy: profile?.id ?? null,
        })
        if (result.error) {
          setActionError(result.error)
          return
        }
        setActionError('')
        await refreshVisits()

        const { configured, recipients, sent, failed } = result.sms
        if (!configured) {
          toast.success('Store added as additional', {
            description: 'SMS isn’t configured yet — the store is listed and badged, but no texts were sent.',
          })
        } else if (recipients === 0) {
          toast.success('Store added as additional', {
            description: 'No active collector had a textable number.',
          })
        } else {
          toast.success(`Additional store added — ${sent}/${recipients} collectors notified`, {
            description: failed > 0 ? `${failed} text${failed === 1 ? '' : 's'} could not be sent.` : undefined,
          })
        }
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
    [createVisit, clients, profile?.id, refreshVisits]
  )

  /** Only ever called for stores no collector has touched — see ListBoard. */
  /**
   * Both board actions are icon-only and both reach the field, so neither fires
   * on the first click — they stage a confirmation instead. Removing a store
   * takes it off a collector's phone; releasing a claim unlocks a store someone
   * may already be driving to.
   */
  const [pendingAction, setPendingAction] =
    useState<{ kind: 'remove' | 'release'; visit: CollectionVisit } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const runPendingAction = useCallback(async () => {
    if (!pendingAction) return
    setActionBusy(true)
    const { kind, visit } = pendingAction
    const message = kind === 'remove'
      ? await removeVisit(visit.id)
      : await cancelClaim(visit.id)
    setActionError(message ?? '')
    setActionBusy(false)
    setPendingAction(null)
  }, [pendingAction, removeVisit, cancelClaim])

  /**
   * Close out a remittance, or reopen one. The collector's app can't do this —
   * migration 043 gives it no UPDATE on `remittances` — so this page is the only
   * place the status ever moves off `submitted`.
   */
  const handleRemittanceStatus = useCallback(
    async (id: string, status: RemittanceStatus) => {
      setRemittanceBusyId(id)
      const message = await setRemittanceStatus(id, status)
      setRemittanceBusyId(null)
      setActionError(message ?? '')
    },
    [setRemittanceStatus]
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
                {stats.partial > 0 && ` · ${stats.partial} partly paid`}
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
          <DateRangeFilter filter={dateFilter} />
          <Button className="h-9" onClick={() => openAdd()}>
            <Plus /> Add store
          </Button>
        </div>

        <NeedsAttention
          signals={signals} active={attention} widened={widened} onToggle={toggleAttention}
        />

        <Tabs defaultValue="lists">
          <TabsList>
            {/* One tab per JOB, not per data shape. Lists is the only one with
                write actions; Activity is read-only review; Remittances is
                money. An earlier pass split Activity into "Trips" and "Store
                Visits" — two names for one job, which left an admin guessing
                which to open. They are now one tab and a grouping switch. */}
            <TabsTrigger value="lists">Lists ({days.length})</TabsTrigger>
            <TabsTrigger value="activity">Activity ({filteredVisits.length})</TabsTrigger>
            <TabsTrigger value="remittances">Remittances ({remittances.length})</TabsTrigger>
          </TabsList>

          {/* --- Collection lists: the admin's own work --- */}
          <TabsContent value="lists" className="mt-4 space-y-4">
            <ListBoard
              days={days}
              focusWorkerId={collectorFilter}
              onOpenVisit={setSelectedVisit}
              onAddStore={handleAddStoreToDay}
              onRemoveStore={visit => setPendingAction({ kind: 'remove', visit })}
              onCancelClaim={visit => setPendingAction({ kind: 'release', visit })}
            />
          </TabsContent>

          {/* --- Activity: what came back, grouped the way you need to read it --- */}
          <TabsContent value="activity" className="mt-4 space-y-3">
            {/* Same rows either way — only the grouping changes. "By collector"
                answers "what did Marisa do?", "By store" answers "what happened
                at this store?".

                The two counts differ on purpose and are not in conflict: one
                counts RUNS, the other counts STORES. A run is shown whole once
                any of its stores matches, so its untouched stops keep their true
                numbers rather than being renumbered by the filter. */}
            <Tabs value={activityView} onValueChange={v => setActivityView(v as ActivityView)}>
              <TabsList className="h-8">
                <TabsTrigger value="person" className="text-xs px-3">
                  By collector ({trips.length})
                </TabsTrigger>
                <TabsTrigger value="store" className="text-xs px-3">
                  By store ({filteredVisits.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {activityView === 'person' ? (
              <TripRuns
                trips={trips}
                nouns={{ stop: ['store', 'stores'], worker: ['collector', 'collectors'] }}
                onOpenStop={id => {
                  const visit = visits.find(v => v.id === id)
                  if (visit) setSelectedVisit(visit)
                }}
                onViewOnMap={trip => router.push(
                  `/maps?module=collection&trip=${encodeURIComponent(trip.id)}`
                )}
              />
            ) : (
            <>
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
                            <div className="flex items-center gap-1.5">
                              <p className="font-medium text-foreground truncate max-w-[180px]">
                                {v.client?.company_name}
                              </p>
                              <AdditionalBadge visit={v} showAck={false} />
                            </div>
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
                                {paymentMethodLabel(v.payment_method)}
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
            </>
            )}
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
                        {!r.receiver_signature_url && signatureRequired && (
                          <span className={`inline-flex items-center gap-1 font-medium ${TONE_TEXT.red}`}>
                            <AlertTriangle className="w-3 h-3" /> Signature missing
                          </span>
                        )}
                      </div>

                      {/* The evidence the reconcile decision below rests on, so
                          it has to be readable — not just ticked off. */}
                      {(r.signed_proof_url || r.receiver_signature_url) && (
                        <div className="flex gap-2">
                          {r.signed_proof_url && (
                            <RemittanceProofThumb
                              url={r.signed_proof_url}
                              label="Signed proof"
                              caption={captionFor(r.collector?.full_name, r.submitted_at)}
                              icon={<Camera className="w-3 h-3" />}
                              onOpen={setLightboxPhoto}
                            />
                          )}
                          {r.receiver_signature_url && (
                            <RemittanceProofThumb
                              url={r.receiver_signature_url}
                              label="Signature"
                              caption={captionFor(r.receiver_name, r.submitted_at)}
                              signature
                              icon={<PenLine className="w-3 h-3" />}
                              onOpen={setLightboxPhoto}
                            />
                          )}
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

      <ConfirmDialog
        open={!!pendingAction}
        busy={actionBusy}
        destructive={pendingAction?.kind === 'remove'}
        title={pendingAction?.kind === 'remove' ? 'Remove this store?' : 'Release this claim?'}
        confirmLabel={pendingAction?.kind === 'remove' ? 'Remove store' : 'Release claim'}
        description={
          pendingAction?.kind === 'remove' ? (
            <>
              <span className="font-medium text-foreground">
                {pendingAction.visit.client?.company_name}
              </span>{' '}
              comes off this day&apos;s list and disappears from the collectors&apos; phones. Only a
              store nobody has worked or claimed can be removed, so nothing collected is lost —
              but if it still owes money, re-list it on another day.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">
                {pendingAction?.visit.claimed_by_name ?? 'The collector'}
              </span>{' '}
              is on their way to{' '}
              <span className="font-medium text-foreground">
                {pendingAction?.visit.client?.company_name}
              </span>
              . Releasing puts it back in the shared pool for anyone to work, and frees their one
              claim slot — do it if they have finished for the day or the claim was a mistake.
            </>
          )
        }
        onConfirm={runPendingAction}
        onOpenChange={open => !open && setPendingAction(null)}
      />

      <VisitDetailDialog
        visit={selectedVisit}
        onOpenChange={open => !open && setSelectedVisit(null)}
        listedByName={listedByName}
      />

      {/* Opened from the remittance cards. The detail dialog carries its own,
          for the captures on a visit. */}
      <PhotoLightbox
        photo={lightboxPhoto}
        onOpenChange={open => !open && setLightboxPhoto(null)}
      />
    </div>
  )
}
