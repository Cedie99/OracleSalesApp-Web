'use client'

import { Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/header'
import { ModuleSwitcher } from '@/components/module-switcher'
import { SalesMapView } from '@/components/maps/sales-map-view'
import { TripMapView } from '@/components/maps/trip-map-view'
import { useAdminModules } from '@/lib/hooks/use-admin-modules'
import { fromDateInput, useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useCollectionVisits } from '@/lib/hooks/use-collection'
import { usePurchaseOrders } from '@/lib/hooks/use-delivery'
import { collectionTrips } from '@/lib/collection'
import { deliveryTrips } from '@/lib/delivery'
import { peso } from '@/lib/money'
import type { TripStop } from '@/lib/trips'
import { ADMIN_MODULES, type AdminModule } from '@/lib/permissions'
import { Loader2 } from 'lucide-react'

/** Narrows a raw `?module=` string before it is trusted as a module name. */
function isAdminModule(value: string): value is AdminModule {
  return (ADMIN_MODULES as string[]).includes(value)
}

/**
 * Maps — one page, three lenses, chosen by the admin's scope.
 *
 * Every scope reaches this route (see SCOPE_ROUTES in lib/permissions.ts), which
 * used to mean every scope got the SALES map: a Collection Admin opened "Maps"
 * and saw client meetings they have no part in. What each admin actually needs
 * is their own function's field activity, so the page dispatches on
 * `useAdminModules()` and an unrestricted admin gets a switcher.
 *
 * The two operational lenses share `TripMapView` because Collection and Delivery
 * ask the identical question — where did this person go, in what order — while
 * Sales asks a different one and keeps its own view. See the note on
 * `SalesMapView` for why a sales "trip" would be a fiction.
 *
 * Collection and Delivery read the live tables (migrations 043/044), the same
 * ones their admin pages publish into.
 */
/**
 * `useSearchParams` forces the client tree up to the nearest Suspense boundary
 * to render on the client. This page is otherwise statically prerendered, and
 * Next's docs are explicit that a static page calling it from a Client Component
 * **fails the production build** without a boundary — while working fine in dev,
 * where routes render on demand. Hence the split: the default export below is
 * that boundary, and this is what it wraps.
 */
function MapsPageContent() {
  const { activeModule, modules, setModule, loading, hasChoice } = useAdminModules()

  /**
   * Deep link from a module's Activity tab:
   * `?module=collection&trip=<workerId>|<day>`.
   *
   * Derived, not synced: `linkedModule` only stands in until the admin touches
   * the switcher, after which their choice wins. Re-asserting the param would
   * make the switcher spring back every time they used it.
   */
  const searchParams = useSearchParams()
  const rawModule = searchParams.get('module')
  const linkedTripId = searchParams.get('trip')
  const linkedModule =
    rawModule && isAdminModule(rawModule) && modules.includes(rawModule) ? rawModule : null
  /**
   * A `Trip.id` is `${workerId}|${day}`, so the link already carries everything
   * needed to scope the map to that one run: whose it is and which day.
   *
   * Both matter. The map's own default is a single day anchored on today, so a
   * link to a run from last Tuesday would land on an empty map and read as a
   * broken link — the trip simply would not be in `trips` to select.
   */
  const [linkedWorkerId, linkedDay] = linkedTripId?.split('|') ?? []
  const [switched, setSwitched] = useState(false)
  const effectiveModule = !switched && linkedModule ? linkedModule : activeModule
  const chooseModule = (m: AdminModule) => {
    setSwitched(true)
    setModule(m)
  }

  // Both lenses' data is fetched regardless of which is on screen. They are two
  // small queries and an admin flips between them constantly; refetching on
  // every switch would make the map blank for a beat each time.
  const { visits: collectionVisits } = useCollectionVisits()
  const { orders: purchaseOrders } = usePurchaseOrders()

  // One filter instance for both operational lenses. Defaults to a single day
  // because that is the unit a trip exists in — a run belongs to its day.
  const dateFilter = useDateRangeFilter({
    defaultPreset: 'day',
    // Open on the linked run's day rather than today. Initial state only — the
    // stepper and the picker take over from the first interaction.
    defaultAnchorDay: linkedDay ? fromDateInput(linkedDay) : undefined,
  })
  const { inRange } = dateFilter

  const collection = useMemo(() => {
    const visits = collectionVisits.filter(v => inRange(v.scheduled_for))
    return {
      trips: collectionTrips(visits),
      openStops: visits
        .filter(v => v.status === 'pending')
        .map<TripStop>(v => ({
          id: v.id,
          sequence: 0,
          label: v.client?.company_name ?? 'Unknown store',
          sublabel: v.client?.office_address ?? '',
          lat: null,
          lng: null,
          at: null,
          startedAt: null,
          durationMinutes: null,
          tone: 'open',
          statusLabel: 'Pending',
          // The amount OWED is what an admin needs on an unworked store — it is
          // the outstanding figure. (Collectors never see it; admins always do.)
          amountLabel: peso(v.amount_due),
          missingProof: false,
          details: [],
        })),
    }
  }, [collectionVisits, inRange])

  const delivery = useMemo(() => {
    const orders = purchaseOrders.filter(po => inRange(po.scheduled_for))
    return {
      trips: deliveryTrips(orders),
      openStops: orders
        .filter(po => po.status === 'pending')
        .map<TripStop>(po => ({
          id: po.id,
          sequence: 0,
          label: po.client?.company_name ?? 'Unknown customer',
          sublabel: po.area,
          lat: null,
          lng: null,
          at: null,
          startedAt: null,
          durationMinutes: null,
          tone: 'open',
          statusLabel: 'Waiting',
          amountLabel: po.cod && po.cod_due != null ? `${peso(po.cod_due)} COD` : null,
          missingProof: false,
          details: [],
        })),
    }
  }, [purchaseOrders, inRange])

  const switcher = hasChoice ? (
    <ModuleSwitcher modules={modules} value={effectiveModule} onChange={chooseModule} />
  ) : undefined

  // Holding here rather than rendering through the unresolved scope: until the
  // profile lands, `visibleModules` reports the unrestricted set, which would
  // flash the sales map at a Delivery Admin before snapping to theirs.
  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <Header title="Maps" />
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading map…
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {effectiveModule ==='sales' && <SalesMapView headerAction={switcher} />}

      {effectiveModule ==='collection' && (
        <TripMapView
          title="Collection Trips"
          moduleLabel="collection"
          headerAction={switcher}
          trips={collection.trips}
          openStops={collection.openStops}
          nouns={{ stop: ['store', 'stores'], worker: ['collector', 'collectors'] }}
          dateFilter={dateFilter}
          initialTripId={linkedModule === 'collection' ? linkedTripId : null}
          initialWorkerId={linkedModule === 'collection' ? linkedWorkerId : null}
        />
      )}

      {effectiveModule ==='delivery' && (
        <TripMapView
          title="Delivery Trips"
          moduleLabel="delivery"
          headerAction={switcher}
          trips={delivery.trips}
          openStops={delivery.openStops}
          nouns={{ stop: ['stop', 'stops'], worker: ['driver', 'drivers'] }}
          dateFilter={dateFilter}
          initialTripId={linkedModule === 'delivery' ? linkedTripId : null}
          initialWorkerId={linkedModule === 'delivery' ? linkedWorkerId : null}
        />
      )}
    </div>
  )
}

/**
 * The Suspense boundary `useSearchParams` requires — see MapsPageContent. The
 * fallback mirrors that component's own loading state so following a deep link
 * doesn't flash a different shape on the way in.
 */
export default function MapsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col flex-1 min-h-0">
          <Header title="Maps" />
          <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading map…
          </div>
        </div>
      }
    >
      <MapsPageContent />
    </Suspense>
  )
}
