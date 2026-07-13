import type { UserRole } from '@/types'

/** Roles allowed to use this web app at all. Every other role is mobile-only. */
export const WEB_ROLES: UserRole[] = ['superadmin', 'admin']

export function hasWebAccess(role: UserRole | null | undefined): boolean {
  return !!role && WEB_ROLES.includes(role)
}

/** Only a superadmin can create/edit/deactivate users. Admins get view-only access to user management. */
export function canManageUsers(role: UserRole | null | undefined): boolean {
  return role === 'superadmin'
}

export const ROLE_LABEL: Record<UserRole, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  sales_specialist: 'Sales Specialist',
  rsr: 'RSR',
  collector: 'Collector',
}
