import type { UserRole } from '@/types'

/** Roles allowed to use this web app at all. Field roles are mobile-only. */
export const WEB_ROLES: UserRole[] = ['admin', 'sales_manager', 'rsr_manager']

/** Route prefixes only 'admin' may access, even though a sales_manager is logged in. */
export const ADMIN_ONLY_PATHS = ['/users']

export function hasWebAccess(role: UserRole | null | undefined): boolean {
  return !!role && WEB_ROLES.includes(role)
}

export function canAccessPath(role: UserRole | null | undefined, pathname: string): boolean {
  if (!hasWebAccess(role)) return false
  if (role === 'admin') return true
  return !ADMIN_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  sales_specialist: 'Sales Specialist',
  rsr_manager: 'RSR Manager',
  rsr: 'RSR',
  collector: 'Collector',
}
