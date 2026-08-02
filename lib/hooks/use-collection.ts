'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Client, CollectionVisit, Profile, Remittance } from '@/types'

/**
 * Live Collection data (migration 043).
 *
 * Columns are named explicitly rather than `*`, for the reason use-clients.ts
 * documents: the database is shared with the mobile repo, and `*` would let a
 * column mobile adds reach the UI untyped instead of surfacing as a loud error.
 */

const CLIENT_JOIN = `
  id, company_name, contact_person, contact_position, contact_number,
  office_address, customer_type, sales_channel, assigned_agent_id, status,
  city, province, lost_at, reassignable_at, created_at, updated_at
`

const PROFILE_JOIN = `id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at`

const VISIT_COLUMNS = `
  id, client_id, client_name, area, status, scheduled_for, listed_by, listed_at, amount_due,
  claimed_by, claimed_at, claimed_by_name,
  collector_id, amount_collected, payment_method, payment_photo_url,
  delivery_receipt_photo_url, gps_lat, gps_lng, remarks, rescheduled_to,
  visited_at, created_at,
  client:clients!client_id ( ${CLIENT_JOIN} ),
  collector:profiles!collector_id ( ${PROFILE_JOIN} )
`

const REMITTANCE_COLUMNS = `
  id, collector_id, destination, amount_remitted, amount_collected, status,
  receiver_name, signed_proof_url, receiver_signature_url, visit_ids,
  submitted_at, created_at,
  collector:profiles!collector_id ( ${PROFILE_JOIN} )
`

/**
 * PostgREST can serialise a `NUMERIC` column as a JSON *string* rather than a
 * number, depending on the value and driver. Every amount in this module is
 * summed (`reduce((sum, v) => sum + v.amount_collected)`), and string
 * concatenation there fails silently and spectacularly — "5600" + "5600" is
 * "56005600", which then renders as a peso figure. Coerce once, here, at the
 * boundary rows enter the app.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** PostgREST returns an embedded one-to-one as an object, but typings allow an array. */
function one<T>(value: unknown): T | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return (v as T | null) ?? undefined
}

function normalizeVisit(row: Record<string, unknown>): CollectionVisit {
  return {
    ...(row as unknown as CollectionVisit),
    amount_due: num(row.amount_due) ?? 0,
    amount_collected: num(row.amount_collected),
    gps_lat: num(row.gps_lat),
    gps_lng: num(row.gps_lng),
    client: one<Client>(row.client),
    collector: one<Profile>(row.collector),
  }
}

function normalizeRemittance(row: Record<string, unknown>): Remittance {
  return {
    ...(row as unknown as Remittance),
    amount_remitted: num(row.amount_remitted) ?? 0,
    amount_collected: num(row.amount_collected) ?? 0,
    collector: one<Profile>(row.collector),
  }
}

/** What the admin fills in when putting a store on a day's list. */
export interface NewCollectionVisit {
  clientId: string
  /**
   * The selected client's `company_name`, denormalized onto the row (migration
   * 045). Not looked up here: the collector's phone can't read `clients`, so
   * the name has to be written at publish time by the admin, who has it.
   */
  clientName: string
  /** The selected client's `city`, denormalized for the same reason. */
  area: string | null
  /** `yyyy-MM-dd` from the date input. */
  scheduledFor: string
  amountDue: number
  /** The admin publishing the list. */
  listedBy: string | null
}

interface UseCollectionVisitsResult {
  visits: CollectionVisit[]
  loading: boolean
  error: string
  refresh: () => Promise<void>
  createVisit: (draft: NewCollectionVisit) => Promise<string | null>
  removeVisit: (id: string) => Promise<string | null>
  cancelClaim: (id: string) => Promise<string | null>
}

/**
 * Every listed store, newest collection day first, with its client and whoever
 * worked it joined in.
 *
 * Not filtered by day here: the page groups into daily lists itself
 * (`buildDays`), the maps page slices by date range, and the dashboard
 * aggregates — all three want the same unfiltered set.
 */
export function useCollectionVisits(): UseCollectionVisitsResult {
  const [visits, setVisits] = useState<CollectionVisit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('collection_visits')
      .select(VISIT_COLUMNS)
      .order('scheduled_for', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setVisits((data ?? []).map(row => normalizeVisit(row as Record<string, unknown>)))
    }
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  /** Returns an error message, or null on success. */
  const createVisit = useCallback(
    async (draft: NewCollectionVisit): Promise<string | null> => {
      const supabase = createClient()
      const { error: insertError } = await supabase.from('collection_visits').insert({
        client_id: draft.clientId,
        // Denormalized at publish time — the phone can't resolve client_id
        // itself. See migration 045.
        client_name: draft.clientName,
        area: draft.area,
        status: 'pending',
        // Midday, so the store lands on the intended day whatever timezone the
        // browser is in — a bare date string would drift a day either side.
        scheduled_for: new Date(`${draft.scheduledFor}T12:00:00`).toISOString(),
        listed_by: draft.listedBy,
        amount_due: draft.amountDue,
        // Everything the collector fills in stays null: the store belongs to
        // nobody until someone actually works it.
      })

      if (insertError) return insertError.message
      await load()
      return null
    },
    [load]
  )

  const removeVisit = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      const { error: deleteError } = await supabase
        .from('collection_visits')
        .delete()
        .eq('id', id)

      if (deleteError) return deleteError.message
      await load()
      return null
    },
    [load]
  )

  /**
   * Release a collector's claim so the store returns to the shared pool
   * (migration 046). Admin-only in practice — RLS lets the claimer clear their
   * own, but web is only ever used by admins.
   *
   * The main reason this exists: claims never expire, so a store claimed at 4pm
   * and never worked stays locked, and with one claim per person that collector
   * can't take anything the next morning until someone clears it.
   */
  const cancelClaim = useCallback(
    async (id: string): Promise<string | null> => {
      const supabase = createClient()
      // All three together — `collection_visits_claim_complete` rejects a
      // partial claim.
      const { error: updateError } = await supabase
        .from('collection_visits')
        .update({ claimed_by: null, claimed_at: null, claimed_by_name: null })
        .eq('id', id)

      if (updateError) return updateError.message
      await load()
      return null
    },
    [load]
  )

  return { visits, loading, error, refresh, createVisit, removeVisit, cancelClaim }
}

/** Money handed over by collectors, most recent first. */
export function useRemittances() {
  const [remittances, setRemittances] = useState<Remittance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('remittances')
      .select(REMITTANCE_COLUMNS)
      .order('submitted_at', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      setRemittances((data ?? []).map(row => normalizeRemittance(row as Record<string, unknown>)))
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

  return { remittances, loading, error, refresh }
}
