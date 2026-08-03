'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { CutoffPeriod, MeetingCutoffAttribution } from '@/types'

/**
 * Cutoff periods and the attribution ledger (migrations 057-060).
 *
 * Read straight from the tables rather than through migration 060's RPCs.
 * Those are scoped to one caller (`get_my_cutoff_usage_summary`) or one client
 * (`get_client_cutoff_allowance`), which is right for mobile but cannot answer
 * the only question the admin surfaces ask: every account at once. Admins hold
 * full SELECT on both tables, so a direct read needs no new server surface.
 *
 * Columns are named explicitly, not `*`, for the reason set out in
 * use-clients.ts: this schema is shared with the mobile repo and gains columns
 * without web knowing.
 */

const PERIOD_COLUMNS = `
  id, label, starts_on, ends_on, sales_target, rsr_target, client_meeting_cap,
  status, supersedes_period_id, version, created_by, created_at, updated_at
`

const ATTRIBUTION_COLUMNS = `
  meeting_id, period_id, client_id, agent_id, captured_client_stage,
  attribution, slot_index, attributed_at
`

interface UseCutoffPeriodsResult {
  periods: CutoffPeriod[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
}

/** Every cutoff period, newest first. */
export function useCutoffPeriods(): UseCutoffPeriodsResult {
  const [periods, setPeriods] = useState<CutoffPeriod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('cutoff_periods')
      .select(PERIOD_COLUMNS)
      .order('starts_on', { ascending: false })

    if (queryError) setError(queryError.message)
    else {
      setError('')
      setPeriods((data ?? []) as unknown as CutoffPeriod[])
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // load() only setStates after its await; same suppression as use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { periods, loading, error, refresh }
}

interface UseCutoffAttributionsResult {
  attributions: MeetingCutoffAttribution[]
  loading: boolean
  error: string
  /**
   * Meetings with no ledger row at all — inserted before migration 059's
   * trigger existed, since nothing backfills. Surfaced so admin screens can say
   * so rather than implying those visits never happened.
   */
  unattributedMeetingCount: number
  refresh: () => Promise<void>
}

/**
 * The whole attribution ledger, plus a count of meetings that predate it.
 *
 * Fetching everything is deliberate at this data size — one row per meeting,
 * and the Maps lens needs to switch periods without a refetch. If the meetings
 * table grows past a few thousand this should take a period_id argument.
 */
export function useCutoffAttributions(): UseCutoffAttributionsResult {
  const [attributions, setAttributions] = useState<MeetingCutoffAttribution[]>([])
  const [unattributedMeetingCount, setUnattributedMeetingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const [ledger, meetingCount] = await Promise.all([
      supabase.from('meeting_cutoff_attributions').select(ATTRIBUTION_COLUMNS),
      supabase.from('meetings').select('id', { count: 'exact', head: true }),
    ])

    if (ledger.error) setError(ledger.error.message)
    else {
      setError('')
      const rows = (ledger.data ?? []) as unknown as MeetingCutoffAttribution[]
      setAttributions(rows)
      // Meetings minus ledger rows. Not a filter on the ledger itself: rows that
      // predate the trigger are ABSENT, not marked 'unattributed'.
      setUnattributedMeetingCount(Math.max(0, (meetingCount.count ?? 0) - rows.length))
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { attributions, unattributedMeetingCount, loading, error, refresh }
}
