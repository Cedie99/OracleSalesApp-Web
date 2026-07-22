'use client'

import { Bell, Eye, ChevronDown } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface ViewSwitcherOption {
  id: string
  label: string
}

interface ViewSwitcherProps {
  options: ViewSwitcherOption[]
  value: string
  activeLabel: string
  onChange: (id: string) => void
}

interface HeaderProps {
  title: string
  subtitle?: string
  pendingApprovals?: number
  /** "Viewing as" control for filtering the dashboard to a specific team. Omit to hide it. */
  viewSwitcher?: ViewSwitcherProps
}

export function Header({ title, subtitle, pendingApprovals = 0, viewSwitcher }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 h-[61px] border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {viewSwitcher && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-medium text-muted-foreground border border-border hover:bg-accent hover:text-foreground transition-colors">
              <Eye className="w-3.5 h-3.5" />
              {viewSwitcher.activeLabel}
              <ChevronDown className="w-3 h-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={viewSwitcher.value}
                onValueChange={v => viewSwitcher.onChange(v as string)}
              >
                {viewSwitcher.options.map(opt => (
                  <DropdownMenuRadioItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button className="relative p-2 rounded-full hover:bg-accent transition-colors">
          <Bell className="w-4 h-4 text-muted-foreground" />
          {pendingApprovals > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary" />
          )}
        </button>
      </div>
    </header>
  )
}
