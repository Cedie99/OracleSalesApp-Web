import type { AdminScope, UserRole } from '@/types'

/** Roles allowed to use this web app at all. Every other role is mobile-only. */
export const WEB_ROLES: UserRole[] = ['superadmin', 'admin']

export function hasWebAccess(role: UserRole | null | undefined): boolean {
  return !!role && WEB_ROLES.includes(role)
}

/** Which app a role signs in through. Web roles never use the mobile app and vice versa. */
export function platformForRole(role: UserRole): 'web' | 'mobile' {
  return WEB_ROLES.includes(role) ? 'web' : 'mobile'
}

/** Only a superadmin can create/edit/deactivate users. Admins get view-only access to user management. */
export function canManageUsers(role: UserRole | null | undefined): boolean {
  return role === 'superadmin'
}

// --- Admin scope (migration 024) -------------------------------------------

export const ADMIN_SCOPES: AdminScope[] = ['all', 'sales', 'collection', 'delivery']

/** How each category names itself in the UI. 'all' is the plain, unrestricted admin. */
export const ADMIN_SCOPE_LABEL: Record<AdminScope, string> = {
  all: 'Admin',
  sales: 'Sales Admin',
  collection: 'Collection Admin',
  delivery: 'Delivery Admin',
}

export const ADMIN_SCOPE_DESCRIPTION: Record<AdminScope, string> = {
  all: 'Oversees every module — sales, collection, and delivery.',
  sales: 'Clients, meetings, maps, lost opportunities, and the approval queue.',
  collection: 'Collection runs and remittances, plus maps and reports.',
  delivery: 'Delivery runs and proof of receipt, plus maps and reports.',
}

/**
 * Pages each scope may reach, as route prefixes.
 *
 * Dashboard, Maps, and Reports are common ground on purpose: the dashboard is
 * every admin's landing page, maps is the shared field view (a collection admin
 * needs to see where their collectors are as much as a sales admin does), and
 * reports is the export surface each function pulls its own numbers from.
 *
 * '/users' is absent from every narrowed scope — account administration belongs
 * to the unrestricted admin and the superadmin, regardless of business function.
 */
const SCOPE_ROUTES: Record<Exclude<AdminScope, 'all'>, string[]> = {
  sales: [
    '/dashboard', '/clients', '/meetings', '/maps', '/lost-opportunities',
    '/approvals', '/clock-records', '/reports',
  ],
  collection: ['/dashboard', '/collection', '/maps', '/reports'],
  delivery: ['/dashboard', '/delivery', '/maps', '/reports'],
}

/** Scope of a profile, tolerating rows written before migration 024. */
export function adminScope(
  role: UserRole | null | undefined,
  scope: AdminScope | null | undefined
): AdminScope {
  // Only a plain admin is ever narrowed — superadmin is unrestricted by
  // definition, and a stray scope on any other role is meaningless.
  if (role !== 'admin') return 'all'
  return scope && ADMIN_SCOPES.includes(scope) ? scope : 'all'
}

/**
 * Display name for a user's category — "Collection Admin" rather than a bare
 * "Admin" pill that says nothing about which half of the business they run.
 */
export function roleScopeLabel(
  role: string | null | undefined,
  scope: AdminScope | null | undefined
): string {
  if (role === 'admin') return ADMIN_SCOPE_LABEL[adminScope('admin', scope)]
  return roleLabel(role)
}

/** True when a scoped admin may open `pathname`. */
export function canAccessRoute(
  role: UserRole | null | undefined,
  scope: AdminScope | null | undefined,
  pathname: string
): boolean {
  const effective = adminScope(role, scope)
  if (effective === 'all') return true
  return SCOPE_ROUTES[effective].some(
    route => pathname === route || pathname.startsWith(route + '/')
  )
}

/** Where a scoped admin lands when they hit a page they can't open. */
export function homeRouteForScope(scope: AdminScope): string {
  return scope === 'all' ? '/dashboard' : SCOPE_ROUTES[scope][0]
}

export const ROLE_LABEL: Record<UserRole, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  sales_specialist: 'Sales Specialist',
  rsr: 'RSR',
  collector: 'Collector',
  delivery: 'Delivery',
}

/**
 * Label for a role string that came out of the database rather than out of
 * `UserRole`. Falls back to a humanised form of the raw value.
 *
 * This exists because profiles.role is plain text shared with the mobile repo,
 * which has shipped a role before web knew about it — an `executive` account
 * appeared in production on 2026-07-24 and hard-crashed the Users page, since
 * `ROLE_ICON[role]` resolved to undefined and React rejects an undefined
 * element type. An unfamiliar role must render as an obvious "we don't know
 * this one" pill so it prompts a schema sync, never a white screen.
 *
 * Use this (and `roleTone`) for any role that originates from a query. Index
 * ROLE_LABEL directly only for roles this app itself chose.
 */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—'
  return (
    ROLE_LABEL[role as UserRole] ??
    role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  )
}

/** True when the database handed us a role this build has no definition for. */
export function isKnownRole(role: string | null | undefined): role is UserRole {
  return !!role && role in ROLE_LABEL
}
