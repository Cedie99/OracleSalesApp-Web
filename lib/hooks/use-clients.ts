'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Client, Profile } from '@/types'

/**
 * Columns selected explicitly rather than with `*`.
 *
 * The database is shared with the mobile repo, which adds columns without a
 * migration landing here first (that drift is what put an unmodelled
 * `executive` role into profiles). `*` would quietly widen every row and let
 * unmodelled fields reach the UI untyped; naming the columns means a rename on
 * the mobile side surfaces as a loud PostgREST error instead of an undefined
 * cell halfway down a table.
 */
const CLIENT_COLUMNS = `
  id, company_name, contact_person, contact_position, contact_number,
  office_address, customer_type, sales_channel, assigned_agent_id, status,
  lost_at, reassignable_at, created_at, updated_at,
  address_line1, address_line2, landmark, province, city,
  details_deadline_at, details_completed_at, inactive_reason,
  agent:profiles!assigned_agent_id (
    id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at
  )
`

/**
 * Supabase returns NULL for text columns the mobile app left blank, but most of
 * the web UI predates that and calls `.toLowerCase()` / `.trim()` on them
 * directly. Coercing here — at the one boundary rows enter the app — keeps that
 * assumption true instead of scattering `?? ''` across every page.
 *
 * Nullable-by-design fields (lost_at, city, details_completed_at…) are left
 * null, because for those "absent" is real information the UI must render as an
 * em-dash rather than an empty string.
 */
function normalizeClient(row: Record<string, unknown>): Client {
  const agent = Array.isArray(row.agent) ? row.agent[0] : row.agent

  return {
    ...(row as unknown as Client),
    contact_person: (row.contact_person as string | null) ?? '',
    contact_number: (row.contact_number as string | null) ?? '',
    office_address: (row.office_address as string | null) ?? '',
    agent: (agent as Profile | null) ?? undefined,
  }
}

interface UseClientsResult {
  clients: Client[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
  /** Apply a local change optimistically; call refresh() to resync with the server. */
  setClients: React.Dispatch<React.SetStateAction<Client[]>>
}

/** Every client, newest first, with the assigned agent's profile joined in. */
export function useClients(): UseClientsResult {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Every setState happens after the await. Touching state synchronously here
  // would make the mount effect below cascade renders, which the React Compiler
  // lint (react-hooks/set-state-in-effect) rejects outright.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('clients')
      .select(CLIENT_COLUMNS)
      .order('created_at', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setClients((data ?? []).map(row => normalizeClient(row as Record<string, unknown>)))
    }
    setLoading(false)
  }, [])

  /** Re-fetch and show the spinner. Safe from event handlers, not from effects. */
  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // load() only setStates after its await, but the rule can't see through the
    // useCallback to prove that. Same suppression as app/(admin)/users/page.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return { clients, loading, error, refresh, setClients }
}
