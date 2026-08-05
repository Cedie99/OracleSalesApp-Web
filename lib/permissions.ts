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

/**
 * Shortest password a superadmin may issue, on both create and reset. Lives
 * here rather than beside the actions because a 'use server' module can only
 * export async functions, and the form validates against the same number.
 */
export const PASSWORD_MIN_LENGTH = 8

/**
 * Pre-filled into the create and reset password fields so the common case is
 * one click and the admin always knows what to read out. It is a starting
 * value, not a rule — the field stays editable, and anyone issuing credentials
 * to an account that matters should type something else.
 */
export const DEFAULT_PASSWORD = 'Opc1985!'

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

// --- Business modules ------------------------------------------------------
//
// SCOPE_ROUTES above answers "may this admin open this page?". This answers the
// question the three SHARED pages ask instead — Dashboard, Maps, and Reports are
// reachable by every scope, so the guard lets everyone through and each page has
// to decide what to actually *show*. Before this existed they showed the sales
// view to all three admins, which is what made the roles feel decorative.
//
// A module is one lens on those pages. A narrowed admin gets exactly theirs; the
// unrestricted admin and the superadmin get all three and pick between them.

export type AdminModule = Exclude<AdminScope, 'all'>

/** In the order they appear in a module switcher. */
export const ADMIN_MODULES: AdminModule[] = ['sales', 'collection', 'delivery']

export const MODULE_LABEL: Record<AdminModule, string> = {
  sales: 'Sales',
  collection: 'Collection',
  delivery: 'Delivery',
}

/**
 * The lenses this admin may switch between on a shared page.
 *
 * One entry means no choice to offer — a Collection Admin's dashboard is the
 * collection dashboard, full stop, and a switcher with a single option is noise.
 * Pages should hide their switcher when this has length 1.
 */
export function visibleModules(
  role: UserRole | null | undefined,
  scope: AdminScope | null | undefined
): AdminModule[] {
  const effective = adminScope(role, scope)
  return effective === 'all' ? ADMIN_MODULES : [effective]
}

export const ROLE_LABEL: Record<UserRole, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  // 'executive' is the canonical spelling on both sides — mobile routes on it
  // and the DB constraint stores it. Don't rename it to Director/Owner here.
  executive: 'Executive',
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
 * `executive` itself is a known role now (migration 027, added to UserRole), so
 * these fallbacks currently catch nothing. Keep them anyway: the condition that
 * produced that incident — two repos, one role column, one of them shipping
 * first — has not changed, and the next role will arrive the same way.
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
