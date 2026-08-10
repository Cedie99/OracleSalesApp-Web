'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell, Eye, ChevronDown, Banknote, HandCoins, CircleDollarSign, CalendarClock,
  PackageCheck, PackageX, ClipboardCheck, CalendarCheck, Users, FileCheck, Trash2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNotifications } from '@/lib/hooks/use-notifications'
import type { Notification, NotificationModule } from '@/types'
import { format, formatDistanceToNow } from 'date-fns'

/** Short module tag shown under each row so admins can tell the feeds apart. */
const MODULE_LABEL: Record<NotificationModule, string> = {
  collection: 'Collection',
  delivery: 'Delivery',
  sales: 'Sales',
  system: 'System',
}

/**
 * A distinct icon colour per event type/category (not just per module), so
 * each kind of notification is recognisable on sight. `chip` is the soft circle
 * behind the icon; `icon` is the icon's own colour. Tailwind needs these as
 * literal strings, hence the explicit map rather than string interpolation.
 */
const TYPE_STYLE: Record<string, { icon: string; chip: string }> = {
  remittance_submitted:     { icon: 'text-emerald-600 dark:text-emerald-400', chip: 'bg-emerald-500/10' },
  cod_remittance_submitted: { icon: 'text-teal-600 dark:text-teal-400',       chip: 'bg-teal-500/10' },
  collection_completed:     { icon: 'text-green-600 dark:text-green-400',      chip: 'bg-green-500/10' },
  delivery_completed:       { icon: 'text-blue-600 dark:text-blue-400',        chip: 'bg-blue-500/10' },
  partial_payment:          { icon: 'text-amber-600 dark:text-amber-400',      chip: 'bg-amber-500/10' },
  partial_cod:              { icon: 'text-orange-600 dark:text-orange-400',    chip: 'bg-orange-500/10' },
  additional_seen:          { icon: 'text-cyan-600 dark:text-cyan-400',        chip: 'bg-cyan-500/10' },
  collection_rescheduled:   { icon: 'text-yellow-600 dark:text-yellow-400',    chip: 'bg-yellow-500/10' },
  delivery_failed:          { icon: 'text-red-600 dark:text-red-400',          chip: 'bg-red-500/10' },
  edit_request_submitted:   { icon: 'text-violet-600 dark:text-violet-400',    chip: 'bg-violet-500/10' },
  meeting_logged:           { icon: 'text-indigo-600 dark:text-indigo-400',    chip: 'bg-indigo-500/10' },
  tag_along_request:        { icon: 'text-fuchsia-600 dark:text-fuchsia-400',  chip: 'bg-fuchsia-500/10' },
  po_confirmation_request:  { icon: 'text-purple-600 dark:text-purple-400',    chip: 'bg-purple-500/10' },
  prospect_auto_deleted:    { icon: 'text-rose-600 dark:text-rose-400',        chip: 'bg-rose-500/10' },
}
const DEFAULT_TYPE_STYLE = { icon: 'text-slate-600 dark:text-slate-400', chip: 'bg-slate-500/10' }

/** Icon per event type, so the row is scannable at a glance. */
const TYPE_ICON: Record<string, LucideIcon> = {
  remittance_submitted: Banknote,
  cod_remittance_submitted: Banknote,
  collection_completed: HandCoins,
  delivery_completed: PackageCheck,
  partial_payment: CircleDollarSign,
  partial_cod: CircleDollarSign,
  additional_seen: Eye,
  collection_rescheduled: CalendarClock,
  delivery_failed: PackageX,
  edit_request_submitted: ClipboardCheck,
  meeting_logged: CalendarCheck,
  tag_along_request: Users,
  po_confirmation_request: FileCheck,
  prospect_auto_deleted: Trash2,
}

/**
 * Where a notification takes you when clicked. Keyed by type, falling back to
 * the module's home page. Every target sits inside the module's own scope, so a
 * narrowed admin can always reach the page their notification points at.
 */
const MODULE_ROUTE: Record<NotificationModule, string> = {
  collection: '/collection',
  delivery: '/delivery',
  sales: '/clients',
  system: '/clients',
}
const TYPE_ROUTE: Record<string, string> = {
  edit_request_submitted: '/approvals',
  meeting_logged: '/meetings',
  po_confirmation_request: '/approvals',
}
function routeForNotification(n: Notification): string {
  return TYPE_ROUTE[n.type] ?? MODULE_ROUTE[n.module]
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
  /**
   * @deprecated The bell badge now counts unread notifications directly. Kept so
   * existing call sites still type-check; the value is no longer read here.
   */
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

export function Header({ title, subtitle, viewSwitcher, action }: HeaderProps) {
  const router = useRouter()
  const { notifications, unreadCount, seenAt, markAllRead } = useNotifications()

  const [bellOpen, setBellOpen] = useState(false)
  // Snapshot the read watermark at the moment the panel opens, BEFORE markAllRead
  // advances it — so rows that were unread stay highlighted while you read them,
  // instead of clearing the instant the panel appears.
  const [viewSeenAt, setViewSeenAt] = useState<string | null>(null)
  const isUnread = (createdAt: string) => !viewSeenAt || new Date(createdAt) > new Date(viewSeenAt)

  function handleBellOpen(open: boolean) {
    if (open) {
      setViewSeenAt(seenAt)
      markAllRead()
    }
    setBellOpen(open)
  }

  function openNotification(n: Notification) {
    setBellOpen(false)
    router.push(routeForNotification(n))
  }

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
        <DropdownMenu open={bellOpen} onOpenChange={handleBellOpen}>
          <DropdownMenuTrigger className="relative p-2 rounded-full hover:bg-accent transition-colors">
            <Bell className="w-4 h-4 text-muted-foreground" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-card">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-96 p-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <p className="text-sm font-semibold text-foreground">Notifications</p>
              {unreadCount > 0 && (
                <span className="text-[11px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                  {unreadCount} new
                </span>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <Bell className="w-6 h-6 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">You&apos;re all caught up</p>
                </div>
              ) : (
                notifications.map(n => {
                  const style = TYPE_STYLE[n.type] ?? DEFAULT_TYPE_STYLE
                  const Icon = TYPE_ICON[n.type] ?? Bell
                  const unread = isUnread(n.created_at)
                  const created = new Date(n.created_at)
                  return (
                    <DropdownMenuItem
                      key={n.id}
                      onClick={() => openNotification(n)}
                      className={cn(
                        'items-start gap-3 rounded-none border-b border-border px-4 py-3 last:border-0 cursor-pointer',
                        unread && 'bg-primary/[0.04]'
                      )}
                    >
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.chip)}>
                        <Icon className={cn('h-4 w-4', style.icon)} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-semibold text-foreground leading-tight truncate">
                            {n.title}
                          </span>
                          <span
                            className="shrink-0 text-[11px] text-muted-foreground whitespace-nowrap"
                            title={format(created, 'MMM d, yyyy h:mm a')}
                          >
                            {formatDistanceToNow(created, { addSuffix: true })}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground leading-snug whitespace-normal">
                          {n.message}
                        </span>
                        <span className="mt-1.5 flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {MODULE_LABEL[n.module]}
                          </span>
                          {unread && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )
                })
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
