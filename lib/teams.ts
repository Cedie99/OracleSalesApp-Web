import type { Profile, Team, TeamKind, UserRole } from '@/types'

// No team ids live in this file any more. The four seeded UUIDs that used to
// sit here were deleted from every environment by migration 089: a team is now
// created when you create the manager who runs it, so there is no fixed row for
// code to name. Teams are rows, and which ones are sales or RSR is `teams.kind`
// (migration 075) — read them with `useTeams()`.

/**
 * The kind of team a role belongs to, or null for roles that have no team at
 * all — superadmin, admin, executive, collector and delivery. An executive
 * reads across every team rather than belonging to one.
 *
 * `sales_manager` returns null too, but for the opposite reason: a manager runs
 * EITHER kind. Since migration 010 folded rsr_manager into sales_manager, the
 * role no longer says which, so a manager may be offered any team and it is
 * their team's kind that types them — not the other way round. Callers that
 * need "which teams may this person join" should use `teamsForRole`, which
 * handles that case; this function only answers the narrower question.
 */
export function teamKindForRole(role: UserRole): TeamKind | null {
  if (role === 'sales_specialist') return 'sales'
  if (role === 'rsr') return 'rsr'
  return null
}

/** Whether a role belongs to a team at all. */
export function roleHasTeam(role: UserRole): boolean {
  return role === 'sales_manager' || teamKindForRole(role) !== null
}

/**
 * The teams a person in this role may be assigned to, in the order given.
 *
 * A manager gets every team because they may run either kind; a specialist or
 * RSR gets only their own kind, because a team is never mixed. Everyone else
 * gets nothing, which is what disables the picker.
 */
export function teamsForRole<T extends { kind: TeamKind }>(role: UserRole, teams: T[]): T[] {
  if (role === 'sales_manager') return teams
  const kind = teamKindForRole(role)
  return kind ? teams.filter(t => t.kind === kind) : []
}

/**
 * The kind of team a manager runs, from their team_id — the only way to tell a
 * sales manager from an RSR manager, since they share one role.
 */
export function managerTeamKind(
  teamId: string | null | undefined,
  teams: Pick<Team, 'id' | 'kind'>[]
): TeamKind | null {
  if (!teamId) return null
  return teams.find(t => t.id === teamId)?.kind ?? null
}

/**
 * The sales_manager profile leading a team — a team's manager isn't a
 * separate role, just the active sales_manager who shares that `team_id`
 * (see migration 010: the old rsr_manager role was folded into sales_manager,
 * with team_id deciding whether they lead a sales or RSR team).
 */
export function managerForTeam(teamId: string | null | undefined, managers: Profile[]): Profile | undefined {
  if (!teamId) return undefined
  return managers.find(m => m.team_id === teamId && m.is_active !== false)
}

/**
 * Teams tagged with who runs them, shaped for a <PersonSelect>.
 *
 * Resolved from `profiles` and not from `teams.manager_id`: that column exists
 * (001_initial) but no migration ever writes to it, so reading it would report
 * every team as unmanaged. Takes the full profile list rather than a
 * pre-filtered manager list so callers don't each have to remember that a
 * team's manager is "the active sales_manager sharing its team_id".
 */
export function teamsWithManagers<T extends { id: string; name: string }>(
  teams: T[],
  profiles: Profile[]
): (T & { managerId?: string; managerName?: string })[] {
  const managers = profiles.filter(p => p.role === 'sales_manager')
  return teams.map(team => {
    const manager = managerForTeam(team.id, managers)
    return { ...team, managerId: manager?.id, managerName: manager?.full_name }
  })
}
