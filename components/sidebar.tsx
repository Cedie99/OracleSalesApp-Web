'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Users, CalendarCheck, ClipboardCheck,
  AlertTriangle, Clock, FileBarChart2, LogOut, UserCog, Map, Wallet, Truck,
} from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { canAccessRoute, roleScopeLabel } from '@/lib/permissions'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { TONE_CLASS, roleTone } from '@/lib/status-styles'
import { useEditRequests } from '@/lib/hooks/use-edit-requests'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
  adminOnly?: boolean
  /** Renders a live count pill on the right of the row. Only actionable queues get one. */
  count?: number
}

interface NavGroup {
  /** null = no header; used for the standalone Dashboard row at the top. */
  label: string | null
  items: NavItem[]
}

/**
 * Grouped by what the sections actually mean to an admin, not by page count.
 *
 * SALES holds the entity spine (Clients -> Meetings) plus its two lenses: Maps is
 * those same clients plotted geographically, and Lost Opportunities is literally
 * `clients.filter(status === 'lost')` with the 14-day reassignment rule layered on.
 * They sit beside Clients because that is what they are views of.
 *
 * MANAGEMENT is the oversight surface — the things an admin acts on or exports,
 * rather than the records themselves. ADMIN is account administration only.
 */
function buildNavGroups(pendingApprovals: number): NavGroup[] {
  return [
    {
      label: null,
      items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
    },
    {
      label: 'Sales',
      items: [
        { href: '/clients', label: 'Clients', icon: Users },
        { href: '/meetings', label: 'Meetings', icon: CalendarCheck },
        { href: '/maps', label: 'Maps', icon: Map },
        { href: '/lost-opportunities', label: 'Lost Opportunities', icon: AlertTriangle },
      ],
    },
    {
      // Collection/Delivery (F-007) are a different business function from sales
      // — different role (collector), different data, different people.
      label: 'Operations',
      items: [
        { href: '/collection', label: 'Collection', icon: Wallet },
        { href: '/delivery', label: 'Delivery', icon: Truck },
      ],
    },
    {
      label: 'Management',
      items: [
        // The only queue with work waiting in it, so it's the only row with a count.
        { href: '/approvals', label: 'Approvals', icon: ClipboardCheck, count: pendingApprovals },
        { href: '/clock-records', label: 'Clock Records', icon: Clock },
        { href: '/reports', label: 'Reports', icon: FileBarChart2 },
      ],
    },
    {
      label: 'Admin',
      // adminOnly is currently a no-op — WEB_ROLES is already just superadmin+admin,
      // so nobody who can load this sidebar fails the check. Kept as a guard in case
      // a lower role is ever granted web access.
      items: [{ href: '/users', label: 'User Management', icon: UserCog, adminOnly: true }],
    },
  ]
}

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { profile } = useCurrentProfile()

  const name = profile?.full_name ?? 'User'
  const initials = name
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
  const { requests: editRequests } = useEditRequests()
  const pendingApprovals = editRequests.filter(r => r.status === 'pending').length

  // Filter items first, then drop any group left empty so its header doesn't orphan.
  // A scoped admin (Sales/Collection/Delivery) only sees their own function's
  // pages — the same rule proxy.ts enforces, so the nav can't offer a link that
  // would bounce them straight back.
  const visibleGroups = buildNavGroups(pendingApprovals)
    .map(group => ({
      ...group,
      items: group.items.filter(
        item =>
          (!item.adminOnly || profile?.role === 'admin' || profile?.role === 'superadmin') &&
          canAccessRoute(profile?.role, profile?.admin_scope, item.href)
      ),
    }))
    .filter(group => group.items.length > 0)

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="flex flex-col h-screen w-60 bg-sidebar border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="flex items-center h-[61px] px-4 border-b border-sidebar-border bg-ink">
        <div className="relative h-9 w-40 shrink-0">
          <Image
            src="/oracle-logo.png"
            alt="Oracle logo"
            fill
            className="object-contain object-left"
          />
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {visibleGroups.map((group, groupIndex) => (
          <div key={group.label ?? 'primary'} className={cn(groupIndex > 0 && 'mt-5')}>
            {group.label && (
              // Matches the BizLink wireframe's own sidebar group label
              // (`aside .grp`): 10.5px / 600 / uppercase / .6px tracking.
              <p className="px-3 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon, count }) => {
                const active = pathname === href || pathname.startsWith(href + '/')
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-full text-sm font-medium transition-all duration-150',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
                    )}
                  >
                    <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="flex-1 truncate">{label}</span>
                    {count !== undefined && count > 0 && (
                      <Badge variant="tone" className={cn('shrink-0 tabular-nums', TONE_CLASS.amber)}>
                        {count}
                      </Badge>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User profile + Logout */}
      <div className="px-2 py-3 border-t border-sidebar-border space-y-0.5">
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-full">
          <Avatar className="w-8 h-8 shrink-0">
            <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
              {initials || 'U'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-foreground truncate">
              {name}
            </p>
            <Badge
              variant="tone"
              className={`h-4 mt-0.5 ${TONE_CLASS[roleTone(profile?.role)]}`}
            >
              {roleScopeLabel(profile?.role, profile?.admin_scope)}
            </Badge>
          </div>
        </div>

        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-full text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all duration-150"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Logout
        </button>
      </div>
    </aside>
  )
}
