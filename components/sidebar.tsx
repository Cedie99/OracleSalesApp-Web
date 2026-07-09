'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Users, CalendarCheck, ClipboardCheck,
  AlertTriangle, Clock, FileBarChart2, LogOut, UserCog, Map,
} from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { ROLE_LABEL } from '@/lib/permissions'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/users', label: 'User Management', icon: UserCog, adminOnly: true },
  { href: '/clients', label: 'Clients', icon: Users },
  { href: '/meetings', label: 'Meetings', icon: CalendarCheck },
  { href: '/approvals', label: 'Approvals', icon: ClipboardCheck },
  { href: '/lost-opportunities', label: 'Lost Opportunities', icon: AlertTriangle },
  { href: '/clock-records', label: 'Clock Records', icon: Clock },
  { href: '/maps', label: 'Maps', icon: Map },
  { href: '/reports', label: 'Reports', icon: FileBarChart2 },
]

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
  const visibleNavItems = navItems.filter(item => !item.adminOnly || profile?.role === 'admin')

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="flex flex-col h-screen w-60 bg-sidebar border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="flex items-center h-[61px] px-4 border-b border-sidebar-border bg-[oklch(0.22_0.06_145)]">
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
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {visibleNavItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
              )}
            >
              <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* User profile + Logout */}
      <div className="px-2 py-3 border-t border-sidebar-border space-y-0.5">
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg">
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
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-primary/40 text-primary h-4 mt-0.5"
            >
              {profile ? ROLE_LABEL[profile.role] : '—'}
            </Badge>
          </div>
        </div>

        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all duration-150"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Logout
        </button>
      </div>
    </aside>
  )
}
