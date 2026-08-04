'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type {
  CutoffPeriod,
  CutoffPeriodChange,
  Holiday,
  MeetingCutoffAttribution,
  QuotaSettings,
} from '@/types'

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
  id, label, starts_on, ends_on, sales_target, rsr_target, rsr_daily_target,
  working_days_override, client_meeting_cap, status, supersedes_period_id,
  version, created_by, created_at, updated_at
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

interface UseQuotaSettingsResult {
  settings: QuotaSettings | null
  holidays: Holiday[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
}

/**
 * The standing quota numbers and the working calendar (migration 063).
 *
 * Loaded together because neither is useful alone: an RSR daily target means
 * nothing until you know how many working days a period holds, and every
 * surface that shows one shows the other.
 */
export function useQuotaSettings(): UseQuotaSettingsResult {
  const [settings, setSettings] = useState<QuotaSettings | null>(null)
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const [settingsRow, holidayRows] = await Promise.all([
      supabase
        .from('quota_settings')
        .select('id, sales_target, rsr_daily_target, client_meeting_cap, updated_by, updated_at')
        .maybeSingle(),
      supabase
        .from('holidays')
        .select('holiday_date, label, created_by, created_at')
        .order('holiday_date', { ascending: true }),
    ])

    if (settingsRow.error) setError(settingsRow.error.message)
    else if (holidayRows.error) setError(holidayRows.error.message)
    else {
      setError('')
      setSettings((settingsRow.data ?? null) as unknown as QuotaSettings | null)
      setHolidays((holidayRows.data ?? []) as unknown as Holiday[])
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

  return { settings, holidays, loading, error, refresh }
}

interface UsePeriodChangesResult {
  changes: CutoffPeriodChange[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
}

/** The quota-policy audit trail, newest first (ADR-053 Batch 7B). */
export function usePeriodChanges(limit = 100): UsePeriodChangesResult {
  const [changes, setChanges] = useState<CutoffPeriodChange[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('cutoff_period_changes')
      .select('id, period_id, changed_by, changed_at, field, old_value, new_value')
      .order('changed_at', { ascending: false })
      .limit(limit)

    if (queryError) setError(queryError.message)
    else {
      setError('')
      setChanges((data ?? []) as unknown as CutoffPeriodChange[])
    }
    setLoading(false)
  }, [limit])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { changes, loading, error, refresh }
}
