'use client'

import { useMemo } from 'react'
import { Header } from '@/components/header'
import { ModuleSwitcher } from '@/components/module-switcher'
import { SalesMapView } from '@/components/maps/sales-map-view'
import { TripMapView } from '@/components/maps/trip-map-view'
import { useAdminModules } from '@/lib/hooks/use-admin-modules'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useCollectionVisits } from '@/lib/hooks/use-collection'
import { usePurchaseOrders } from '@/lib/hooks/use-delivery'
import { collectionTrips } from '@/lib/collection'
import { deliveryTrips } from '@/lib/delivery'
import { peso } from '@/lib/money'
import type { TripStop } from '@/lib/trips'
import { Loader2 } from 'lucide-react'

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
export default function MapsPage() {
  const { activeModule, modules, setModule, loading, hasChoice } = useAdminModules()

  // Both lenses' data is fetched regardless of which is on screen. They are two
  // small queries and an admin flips between them constantly; refetching on
  // every switch would make the map blank for a beat each time.
  const { visits: collectionVisits } = useCollectionVisits()
  const { orders: purchaseOrders } = usePurchaseOrders()

  // One filter instance for both operational lenses. Defaults to a single day
  // because that is the unit a trip exists in — a run belongs to its day.
  const dateFilter = useDateRangeFilter({ defaultPreset: 'day' })
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
          tone: 'open',
          statusLabel: 'Waiting',
          amountLabel: po.cod && po.cod_due != null ? `${peso(po.cod_due)} COD` : null,
          missingProof: false,
          details: [],
        })),
    }
  }, [purchaseOrders, inRange])

  const switcher = hasChoice ? (
    <ModuleSwitcher modules={modules} value={activeModule} onChange={setModule} />
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
      {activeModule === 'sales' && <SalesMapView headerAction={switcher} />}

      {activeModule === 'collection' && (
        <TripMapView
          title="Collection Trips"
          moduleLabel="collection"
          headerAction={switcher}
          trips={collection.trips}
          openStops={collection.openStops}
          nouns={{ stop: ['store', 'stores'], worker: ['collector', 'collectors'] }}
          dateFilter={dateFilter}
        />
      )}

      {activeModule === 'delivery' && (
        <TripMapView
          title="Delivery Trips"
          moduleLabel="delivery"
          headerAction={switcher}
          trips={delivery.trips}
          openStops={delivery.openStops}
          nouns={{ stop: ['stop', 'stops'], worker: ['driver', 'drivers'] }}
          dateFilter={dateFilter}
        />
      )}
    </div>
  )
}
