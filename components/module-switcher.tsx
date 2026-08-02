'use client'

import { Briefcase, Truck, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MODULE_LABEL, type AdminModule } from '@/lib/permissions'

const MODULE_ICON: Record<AdminModule, React.ElementType> = {
  sales: Briefcase,
  collection: Wallet,
  delivery: Truck,
}

interface ModuleSwitcherProps {
  modules: AdminModule[]
  value: AdminModule
  onChange: (module: AdminModule) => void
}

/**
 * Flips the shared pages (Dashboard, Maps, Reports) between business lenses.
 *
 * Only the unrestricted admin and the superadmin ever see this: a Sales Admin's
 * `visibleModules` is `['sales']` and a switcher offering one option is noise,
 * so callers render nothing when `useAdminModules().hasChoice` is false.
 *
 * The icons match the sidebar's own — Wallet for Collection, Truck for Delivery
 * — so the switcher reads as "which section am I looking at" rather than as an
 * unrelated filter.
 */
export function ModuleSwitcher({ modules, value, onChange }: ModuleSwitcherProps) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-muted">
      {modules.map(module => {
        const Icon = MODULE_ICON[module]
        const active = module === value
        return (
          <button
            key={module}
            type="button"
            onClick={() => onChange(module)}
            aria-pressed={active}
            className={cn(
              'flex items-center gap-1.5 px-3 h-7 rounded-full text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className={cn('w-3.5 h-3.5', active && 'text-primary')} />
            {MODULE_LABEL[module]}
          </button>
        )
      })}
    </div>
  )
}
