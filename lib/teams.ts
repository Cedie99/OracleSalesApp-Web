import type { Profile, UserRole } from '@/types'

/**
 * Fixed team IDs shared between the seed migrations (004_seed_teams.sql,
 * 007_seed_rsr_teams.sql), the mock data, and the Dashboard's "Viewing as"
 * switcher, so a real manager account's profiles.team_id lines up with the
 * demo data. Sales teams and RSR teams are kept separate (no mixed teams).
 */
export const TEAM_1_ID = '00000000-0000-0000-0000-000000000001'
export const TEAM_2_ID = '00000000-0000-0000-0000-000000000002'
export const TEAM_RSR_1_ID = '00000000-0000-0000-0000-000000000003'
export const TEAM_RSR_2_ID = '00000000-0000-0000-0000-000000000004'

export const TEAM_LABELS: Record<string, string> = {
  [TEAM_1_ID]: 'Sales Team 1',
  [TEAM_2_ID]: 'Sales Team 2',
  [TEAM_RSR_1_ID]: 'RSR Team 1',
  [TEAM_RSR_2_ID]: 'RSR Team 2',
}

export const SALES_TEAM_IDS: string[] = [TEAM_1_ID, TEAM_2_ID]
export const RSR_TEAM_IDS: string[] = [TEAM_RSR_1_ID, TEAM_RSR_2_ID]

/**
 * Which team IDs are valid for a role. Superadmin/Admin/Executive/Collector/
 * Delivery have no team — an executive reads across every team rather than
 * belonging to one. 'sales_manager' oversees either team type (sales or RSR) —
 * the team type is decided by team_id, not by a separate manager role.
 */
export function teamIdsForRole(role: UserRole): string[] {
  if (role === 'sales_manager') return [...SALES_TEAM_IDS, ...RSR_TEAM_IDS]
  if (role === 'sales_specialist') return SALES_TEAM_IDS
  if (role === 'rsr') return RSR_TEAM_IDS
  return []
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
