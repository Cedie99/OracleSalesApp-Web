'use client'

import { Bell, Eye, ChevronDown } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNotifications } from '@/lib/hooks/use-notifications'
import type { NotificationModule } from '@/types'
import { format } from 'date-fns'

/** Short tag shown per notification so the unrestricted admin can tell feeds apart. */
const NOTIFICATION_MODULE_LABEL: Record<NotificationModule, string> = {
  sales: 'Sales',
  collection: 'Collection',
  delivery: 'Delivery',
  system: 'System',
}

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
  /**
   * Page-level control rendered ahead of the view switcher — currently the
   * Sales/Collection/Delivery module switcher an unrestricted admin gets on the
   * shared pages. Narrowed admins have one module, so they pass nothing and the
   * header stays as it was.
   */
  action?: React.ReactNode
}

export function Header({ title, subtitle, pendingApprovals = 0, viewSwitcher, action }: HeaderProps) {
  const { notifications, unreadCount, seenAt, markAllRead } = useNotifications()
  const isUnread = (createdAt: string) => !seenAt || new Date(createdAt) > new Date(seenAt)

  return (
    <header className="flex items-center justify-between px-6 h-[61px] border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {action}
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
        <DropdownMenu onOpenChange={open => { if (open) markAllRead() }}>
          <DropdownMenuTrigger className="relative p-2 rounded-full hover:bg-accent transition-colors">
            <Bell className="w-4 h-4 text-muted-foreground" />
            {(pendingApprovals > 0 || unreadCount > 0) && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 p-0">
            <div className="px-3 py-2.5 border-b border-border">
              <p className="text-sm font-semibold text-foreground">Notifications</p>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">No notifications yet</p>
              ) : (
                notifications.map(n => (
                  <div
                    key={n.id}
                    className={`px-3 py-2.5 border-b border-border last:border-0 ${isUnread(n.created_at) ? 'bg-primary/5' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{n.title}</p>
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
                        {NOTIFICATION_MODULE_LABEL[n.module]}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}
                    </p>
                  </div>
                ))
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
