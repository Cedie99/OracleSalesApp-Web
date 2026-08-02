'use client'

import { Header } from '@/components/header'
import { ModuleSwitcher } from '@/components/module-switcher'
import { SalesDashboard } from '@/components/dashboard/sales-dashboard'
import { CollectionDashboard } from '@/components/dashboard/collection-dashboard'
import { DeliveryDashboard } from '@/components/dashboard/delivery-dashboard'
import { useAdminModules } from '@/lib/hooks/use-admin-modules'
import { Loader2 } from 'lucide-react'

/**
 * Dashboard — one route, three overviews, chosen by the admin's scope.
 *
 * This page is every admin's landing page, which is exactly why it used to be
 * the worst offender: a Collection Admin signed in and was shown meeting
 * outcomes and agent success rates, none of which are theirs. Each lens now
 * reports its own function's numbers, and only the unrestricted admin and the
 * superadmin get the switcher between them.
 *
 * The three are separate components rather than one parameterised dashboard on
 * purpose — the questions genuinely differ. Sales asks about conversion,
 * Collection about money not yet in the office, Delivery about goods that came
 * back. Forcing them through a shared shape would flatten precisely the
 * distinctions the roles exist for.
 */
export default function DashboardPage() {
  const { activeModule, modules, setModule, loading, hasChoice } = useAdminModules()

  const switcher = hasChoice ? (
    <ModuleSwitcher modules={modules} value={activeModule} onChange={setModule} />
  ) : undefined

  // Held until the scope is known — `visibleModules` reports the unrestricted
  // set for a null role, which would flash the sales dashboard at a scoped admin.
  if (loading) {
    return (
      <div className="flex flex-col flex-1">
        <Header title="Dashboard" />
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading dashboard…
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1">
      {activeModule === 'sales' && <SalesDashboard headerAction={switcher} />}
      {activeModule === 'collection' && <CollectionDashboard headerAction={switcher} />}
      {activeModule === 'delivery' && <DeliveryDashboard headerAction={switcher} />}
    </div>
  )
}
