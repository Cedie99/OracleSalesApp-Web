'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { fetchAllPages } from '@/lib/supabase/paginate'
import type { Meeting, Profile, Client } from '@/types'

/** Explicit column list — see the note in use-clients.ts for why not `*`. */
export const MEETING_COLUMNS = `
  id, client_id, agent_id, recorded_by, meeting_type, online_platform,
  location_type, location_name, gps_lat, gps_lng, photo_url, agenda, remarks,
  outcome, contact_person, contact_position, meeting_date, created_at,
  start_photo_url, start_captured_at, end_photo_url, end_captured_at,
  end_gps_lat, end_gps_lng, client_status_at_meeting,
  client:clients!client_id ( id, company_name, office_address, city, province, customer_type, status ),
  agent:profiles!agent_id ( id, user_id, full_name, role, team_id, avatar_url, created_at ),
  recorder:profiles!recorded_by ( id, user_id, full_name, role, team_id, avatar_url, created_at )
`

const one = <T,>(v: unknown): T | undefined =>
  (Array.isArray(v) ? v[0] : v) as T | undefined

function normalizeMeeting(row: Record<string, unknown>): Meeting {
  return {
    ...(row as unknown as Meeting),
    // Mobile writes '' rather than NULL for an unfilled contact, and older rows
    // predate the column entirely — the UI treats both as "not recorded".
    contact_person: (row.contact_person as string | null) ?? '',
    agenda: (row.agenda as string[] | null) ?? [],
    client: one<Client>(row.client),
    agent: one<Profile>(row.agent),
    recorder: one<Profile>(row.recorder),
  }
}

/**
 * Real meeting duration in minutes, from the start/end capture pair mobile
 * added. Returns null when either end is missing — which is most historical
 * rows, since the feature postdates them. Callers must render that as "—"
 * rather than 0, because an unrecorded duration is not a zero-length meeting.
 */
export function meetingDurationMinutes(meeting: Meeting): number | null {
  if (!meeting.start_captured_at || !meeting.end_captured_at) return null
  const ms =
    new Date(meeting.end_captured_at).getTime() -
    new Date(meeting.start_captured_at).getTime()
  return ms > 0 ? Math.round(ms / 60000) : null
}

/**
 * Straight-line metres between where the agent opened the meeting and where
 * they closed it.
 *
 * This number is the reason the end fix is captured at all. ADR-019 dropped the
 * photo from the start step precisely because an admin validates a meeting by
 * comparing start against end GPS here on the web — a pair of fixes a few metres
 * apart is someone who sat through a meeting, a pair kilometres apart is someone
 * who opened it at one client and closed it at another.
 *
 * Null when either fix is missing, which is most historical rows: mobile only
 * started sending end_gps_* partway through, and B-011 lost a batch of early
 * ones to a missing column. Callers must render that as "not recorded" — a null
 * shown as "0 m" would read as a confirmed match, the strongest possible claim,
 * from the weakest possible evidence.
 */
export function meetingGpsDriftMeters(meeting: Meeting): number | null {
  const { gps_lat, gps_lng, end_gps_lat, end_gps_lng } = meeting
  if (gps_lat == null || gps_lng == null || end_gps_lat == null || end_gps_lng == null) {
    return null
  }

  // Haversine. Great-circle rather than a flat-earth approximation is not really
  // needed at these distances, but it costs nothing and has no failure mode.
  const R = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(end_gps_lat - gps_lat)
  const dLng = toRad(end_gps_lng - gps_lng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(gps_lat)) * Math.cos(toRad(end_gps_lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

interface UseMeetingsResult {
  meetings: Meeting[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
}

/** Every meeting, most recent first, with client / agent / recorder joined in. */
/**
 * `enabled: false` skips the fetch entirely and leaves the result empty.
 *
 * For a surface that only needs this data behind a tab or a click: the Maps
 * page's Needs Attention lens reads clients, meetings and the attribution
 * ledger, and loading all three on every visit to the page was most of what
 * made Maps slow to open. Defaults to true, so every existing caller is
 * unchanged.
 */
export function useMeetings(
  clientId?: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseMeetingsResult {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    try {
      // Paged, because PostgREST stops at 1,000 rows without saying so. The
      // unfiltered read behind the Meetings page is the one that outgrew the
      // cap — it reported "1000 of 1000 records" while the table held more,
      // and because the order is newest-first it was the oldest meetings that
      // silently vanished. The `id` tiebreaker is load-bearing: mobile syncs a
      // day's meetings up in one batch, so meeting_date alone leaves ties that
      // can reshuffle between pages and make one row arrive twice while
      // another never arrives at all.
      const rows = await fetchAllPages<Record<string, unknown>>((from, to) => {
        let query = supabase
          .from('meetings')
          .select(MEETING_COLUMNS)
          .order('meeting_date', { ascending: false })
          .order('id', { ascending: false })

        if (clientId) query = query.eq('client_id', clientId)

        return query.range(from, to)
      })
      setError('')
      setMeetings(rows.map(row => normalizeMeeting(row)))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load meetings.')
    }
    setLoading(false)
  }, [clientId])

  /** Re-fetch and show the spinner. Safe from event handlers, not from effects. */
  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    if (!enabled) return
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load, enabled])

  // The probe carries the same client filter as the query, so a detail dialog
  // open on one client is not woken by every meeting logged company-wide.
  useAutoRefresh(load, {
    watch: [{ table: 'meetings', ...(clientId ? { match: { client_id: clientId } } : {}) }],
    enabled,
  })

  return { meetings, loading, error, refresh }
}
