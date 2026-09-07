'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { Meeting, MeetingOutcome, TagAlongRequest } from '@/types'

/**
 * The Meetings page's reads, all bounded.
 *
 * Replaces `useMeetings()` (every meeting in the company, three joins, and —
 * because it never paged — silently truncated at PostgREST's 1,000-row ceiling)
 * together with the `useTagAlongs()` call beside it. The manager and agent
 * bucket counts are aggregates over the whole filtered set, which is why the
 * page downloaded everything; they are `get_meetings_overview()` now (migration
 * 133) and the table is `get_meetings_page()`.
 *
 * Companions travel with each row rather than being looked up in a separate
 * whole-ledger fetch, which is what lets `useTagAlongs()` go away here.
 */

export interface MeetingStats {
  total: number
  f2f: number
  googleMeet: number
  successful: number
  followUp: number
  noDecision: number
  lost: number
}

export interface MeetingManagerBucket {
  key: string
  label: string
  agentCount: number
  meetingCount: number
  ownMeetingCount: number
  tagAlongCount: number
  stats: MeetingStats
}

export interface MeetingAgentGroup {
  agentId: string
  agentName: string
  managerKey: string
  meetingCount: number
  /** Meetings in this group that had a companion — "had someone along". */
  tagAlongCount: number
}

export interface MeetingsOverview {
  /** Every meeting, ignoring the filters — the default stat row. */
  stats: MeetingStats
  filteredTotal: number
  allTotal: number
  managers: MeetingManagerBucket[]
  agents: MeetingAgentGroup[]
}

/** A meeting row as the page renders it, with its companions attached. */
export interface MeetingRow extends Meeting {
  companions: TagAlongRequest[]
}

export interface MeetingsFilters {
  search: string
  outcome: string
  type: string
  /** Resolved window from useDateRangeFilter; null means all time. */
  range: { start: Date; end: Date } | null
}

export type MeetingScope =
  | { kind: 'agent'; id: string }
  | { kind: 'manager'; id: string }
  | null

export type MeetingSortKey = 'client' | 'agent' | 'type' | 'location' | 'date' | 'outcome'

/** Ten rows per page, matching the table the drill-down renders. */
export const MEETINGS_PAGE_SIZE = 10

/**
 * Business ranking for the Outcome column — successful first, lost last, rather
 * than alphabetical.
 *
 * Defined here and passed to `get_meetings_page` as a parameter rather than
 * hardcoded in the SQL, so this stays the single definition and the two cannot
 * drift. Same reasoning as QUALIFIED_AGENDA_MILESTONES in lib/client-progress.ts.
 */
export const MEETING_OUTCOME_ORDER: MeetingOutcome[] = [
  'successful', 'follow_up', 'no_decision', 'lost_opportunity',
]

export const EMPTY_MEETING_STATS: MeetingStats = {
  total: 0, f2f: 0, googleMeet: 0, successful: 0, followUp: 0, noDecision: 0, lost: 0,
}

const EMPTY_OVERVIEW: MeetingsOverview = {
  stats: EMPTY_MEETING_STATS,
  filteredTotal: 0,
  allTotal: 0,
  managers: [],
  agents: [],
}

const EMPTY_PAGE = {
  rows: [] as MeetingRow[],
  total: 0,
  stats: EMPTY_MEETING_STATS,
  tagAlongCount: 0,
}

function filterArgs(filters: MeetingsFilters) {
  return {
    p_search: filters.search.trim() || null,
    p_outcome: filters.outcome,
    p_type: filters.type,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
  }
}

/** The hierarchy: manager buckets, the agents under them, and every count. */
export function useMeetingsOverview(filters: MeetingsFilters) {
  const args = filterArgs(filters)
  const key = `meetings-overview:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<MeetingsOverview>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_meetings_overview', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_OVERVIEW) as MeetingsOverview
    },
    EMPTY_OVERVIEW,
  )

  // Only `meetings` is probed. The tag-along ledger is invisible to this
  // browser session under RLS (019), so a stamp read on it would count zero
  // rows forever and report "nothing changed" until the end of time — the same
  // trap use-tag-alongs.ts documents. In practice a companion is answered at
  // roughly the same time meetings move, and the MAX_SKIP_MS backstop in
  // use-auto-refresh catches the rest.
  useAutoRefresh(reload, { watch: [{ table: 'meetings' }] })

  return { overview: data, loading, error, refresh, reload }
}

/** One screen of meeting rows for the drilled-into agent or manager. */
export function useMeetingsPage(
  filters: MeetingsFilters,
  scope: MeetingScope,
  sort: { key: MeetingSortKey; dir: 'asc' | 'desc' },
  page: number,
  pageSize = MEETINGS_PAGE_SIZE,
) {
  // Not memoised, and it does not need to be — see the note in
  // use-clients-view.ts. Only `key` has to be stable, and it is a string.
  const args = {
    ...filterArgs(filters),
    p_scope_kind: scope?.kind ?? 'agent',
    p_scope_id: scope?.id ?? null,
    p_sort_key: sort.key,
    p_sort_dir: sort.dir,
    p_outcome_order: MEETING_OUTCOME_ORDER,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  }

  const key = scope ? `meetings-page:${JSON.stringify(args)}` : 'meetings-page:none'

  const { data, loading, error, reload, refresh } = useCachedResource<typeof EMPTY_PAGE>(
    key,
    async () => {
      if (!scope) return EMPTY_PAGE
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_meetings_page', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_PAGE) as typeof EMPTY_PAGE
    },
    EMPTY_PAGE,
  )

  useAutoRefresh(reload, { watch: [{ table: 'meetings' }], enabled: !!scope })

  return {
    rows: data.rows,
    total: data.total,
    stats: data.stats,
    tagAlongCount: data.tagAlongCount,
    loading: scope ? loading : false,
    error,
    refresh,
    reload,
  }
}

/**
 * One meeting by id, for the `?meeting=<id>` deep link from the Maps panel.
 *
 * Fetched on its own because with the list paged server-side the linked record
 * is usually not in the current window. Deliberately unscoped by the page's
 * filters: the admin followed a link to one record, not to a search — which is
 * what the old code did too, resolving the id against `meetings` rather than
 * against `filtered`.
 */
export function useMeetingDetail(meetingId: string | null) {
  const key = meetingId ? `meeting-detail:${meetingId}` : 'meeting-detail:none'

  const { data, loading, error } = useCachedResource<MeetingRow | null>(
    key,
    async () => {
      if (!meetingId) return null
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_meeting_detail', { p_meeting_id: meetingId })
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? null) as MeetingRow | null
    },
    null,
  )

  return { meeting: data, loading: meetingId ? loading : false, error }
}
