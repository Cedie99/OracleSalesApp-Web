'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { recordAuditLog } from '@/lib/audit/actions'
import { pesoDelta } from '@/lib/money'
import type { ClientCreditEntry, CreditEntryType, Profile } from '@/types'

/**
 * The store credit ledger (migration 117) — the movements behind each store's
 * `clients.credit_balance`.
 *
 * The balance itself rides on the Client rows the page already loads through
 * `useClients`; this hook owns the two things those rows can't give: the recent
 * per-store HISTORY the balances tool shows, and the WRITE path an admin uses to
 * set an opening balance, add a charge, or correct the figure. Every write is one
 * signed-delta `client_credit_entries` row; the database trigger re-derives the
 * balance, so this never touches `clients` directly.
 *
 * Automatic `collection` debits are NOT written here — a trigger mirrors them off
 * `collection_payments` (see migration 117). This hook only ever inserts the two
 * admin entry types, which is why the field can never move a balance.
 */

const PROFILE_JOIN = `id, user_id, full_name, email, role, team_id, is_active, avatar_url, created_at`

const ENTRY_COLUMNS = `
  id, client_id, entry_type, amount, note, created_by, payment_id, created_at,
  author:profiles!created_by ( ${PROFILE_JOIN} )
`

/** PostgREST returns an embedded one-to-one as an object, but typings allow an array. */
function one<T>(value: unknown): T | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return (v as T | null) ?? undefined
}

function normalizeEntry(row: Record<string, unknown>): ClientCreditEntry {
  return {
    ...(row as unknown as ClientCreditEntry),
    // NUMERIC can arrive as a string — coerce so the history renders and sums as
    // numbers, the same boundary rule use-collection.ts documents.
    amount: Number(row.amount ?? 0),
    author: one<Profile>(row.author),
  }
}

/** What the balances tool hands in to move a store's balance. */
export interface CreditAdjustment {
  clientId: string
  /** Store name, for the audit summary — the log is read by people without the schema. */
  clientName: string
  /** Admin-entered movement only: an opening/correcting `adjustment` or a `charge`. */
  entryType: Exclude<CreditEntryType, 'collection'>
  /** Signed delta in PHP. Positive raises the balance, negative lowers it. Never 0. */
  amount: number
  note: string | null
  /** The admin making the entry, stamped onto `created_by`. */
  createdBy: string | null
}

interface UseStoreCreditResult {
  /** Every ledger entry, newest first, grouped by the store it belongs to. */
  entriesByClient: Map<string, ClientCreditEntry[]>
  loading: boolean
  error: string
  refresh: () => Promise<void>
  /** Records one signed-delta entry. Returns an error message, or null on success. */
  adjustBalance: (input: CreditAdjustment) => Promise<string | null>
}

export function useStoreCredit(): UseStoreCreditResult {
  const [entriesByClient, setEntriesByClient] = useState<Map<string, ClientCreditEntry[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const supabase = createClient()
    const { data, error: queryError } = await supabase
      .from('client_credit_entries')
      .select(ENTRY_COLUMNS)
      .order('created_at', { ascending: false })

    if (queryError) {
      setError(queryError.message)
    } else {
      setError('')
      const byClient = new Map<string, ClientCreditEntry[]>()
      for (const raw of data ?? []) {
        const entry = normalizeEntry(raw as Record<string, unknown>)
        const list = byClient.get(entry.client_id)
        if (list) list.push(entry)
        else byClient.set(entry.client_id, [entry])
      }
      setEntriesByClient(byClient)
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

  // A collection landing on a phone writes a 'collection' entry via the trigger,
  // so the ledger moves without an admin touching this page — watch it so an open
  // balances tool reflects a payment as it comes in, alongside admin edits.
  useAutoRefresh(load, {
    watch: [{ table: 'client_credit_entries' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  const adjustBalance = useCallback(
    async (input: CreditAdjustment): Promise<string | null> => {
      if (!Number.isFinite(input.amount) || input.amount === 0) {
        return 'Enter a non-zero amount.'
      }

      const supabase = createClient()
      const { error: insertError } = await supabase.from('client_credit_entries').insert({
        client_id: input.clientId,
        entry_type: input.entryType,
        amount: input.amount,
        note: input.note,
        created_by: input.createdBy,
        // payment_id stays null — a collection debit is the trigger's job, never
        // an admin's.
      })

      if (insertError) return insertError.message

      // A charge reads as "+₱X", a drawdown as "−₱X"; an opening balance is an
      // adjustment carrying its own note ("Set opening balance to ₱30,000").
      const verb = input.entryType === 'charge' ? 'Added charge of' : 'Adjusted credit by'
      void recordAuditLog({
        action: 'client_credit.adjusted',
        entityTable: 'clients',
        entityId: input.clientId,
        entityLabel: input.clientName,
        summary:
          `${verb} ${pesoDelta(input.amount)} for ${input.clientName}` +
          (input.note ? ` — ${input.note}` : ''),
        metadata: { entry_type: input.entryType, amount: input.amount, note: input.note },
      })

      await load()
      return null
    },
    [load]
  )

  return { entriesByClient, loading, error, refresh, adjustBalance }
}
