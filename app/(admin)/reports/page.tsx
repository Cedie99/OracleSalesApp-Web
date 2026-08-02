'use client'

import { Header } from '@/components/header'
import { ModuleSwitcher } from '@/components/module-switcher'
import { SalesReports } from '@/components/reports/sales-reports'
import { CollectionReports } from '@/components/reports/collection-reports'
import { DeliveryReports } from '@/components/reports/delivery-reports'
import { useAdminModules } from '@/lib/hooks/use-admin-modules'
import { MODULE_LABEL } from '@/lib/permissions'
import { Loader2 } from 'lucide-react'

/**
 * Reports — the export surface, scoped to the admin's function.
 *
 * Previously every scope got the same three sales exports and an agent filter
 * listing sales staff only, which left a Collection Admin with a page that could
 * export nothing they own. Each lens now offers its own module's exports and
 * filters by the people who actually work it — collectors, drivers, or agents.
 */
export default function ReportsPage() {
  const { activeModule, modules, setModule, loading, hasChoice } = useAdminModules()

  const switcher = hasChoice ? (
    <ModuleSwitcher modules={modules} value={activeModule} onChange={setModule} />
  ) : undefined

  return (
    <div className="flex flex-col flex-1">
      <Header
        title="Reports"
        subtitle={loading ? 'Export data as Excel files' : `${MODULE_LABEL[activeModule]} exports as Excel files`}
        action={switcher}
      />

      <div className="flex-1 p-6 space-y-5">
        {/* Held until the scope resolves — otherwise a scoped admin sees the
            sales exports flash before their own. */}
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            {activeModule === 'sales' && <SalesReports />}
            {activeModule === 'collection' && <CollectionReports />}
            {activeModule === 'delivery' && <DeliveryReports />}
          </>
        )}
      </div>
    </div>
  )
}
