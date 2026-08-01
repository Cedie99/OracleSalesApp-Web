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
 * Which team IDs are valid for a role. Superadmin/Admin/Collector/Delivery have no
 * team. 'sales_manager' oversees either team type (sales or RSR) — the
 * team type is decided by team_id, not by a separate manager role.
 */
export function teamIdsForRole(role: UserRole): string[] {
  if (role === 'sales_manager') return [...SALES_TEAM_IDS, ...RSR_TEAM_IDS]
  if (role === 'sales_specialist') return SALES_TEAM_IDS
  if (role === 'rsr') return RSR_TEAM_IDS
  return []
}

/** Which side of the org an agent's team falls under, for hierarchy views (Clients, Meetings). */
export type TeamCategory = 'rsr' | 'sales' | 'other'

export const CATEGORY_LABEL: Record<TeamCategory, string> = {
  rsr: 'RSR Department',
  sales: 'Sales Department',
  other: 'Other',
}

/**
 * The agent's `role` decides the category directly for individual contributors
 * ('rsr' and 'sales_specialist' are unambiguous). A 'sales_manager' can lead
 * either kind of team, so that case falls back to `team_id` membership.
 */
export function categoryForAgent(agent: Profile | undefined): TeamCategory {
  if (!agent) return 'other'
  if (agent.role === 'rsr') return 'rsr'
  if (agent.role === 'sales_specialist') return 'sales'
  if (agent.role === 'sales_manager') {
    if (agent.team_id && RSR_TEAM_IDS.includes(agent.team_id)) return 'rsr'
    if (agent.team_id && SALES_TEAM_IDS.includes(agent.team_id)) return 'sales'
  }
  return 'other'
}
