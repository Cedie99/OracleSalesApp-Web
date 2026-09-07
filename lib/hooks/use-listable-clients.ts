'use client'

import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, SLOW_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import type { Client } from '@/types'

/**
 * The customers the Collection and Delivery pickers may offer.
 *
 * Both pages used `useClients()` for this, which reads every column of every
 * client AND joins each one's agent profile — thousands of wide rows, on every
 * visit to a board that only needs a name and an address to fill a dropdown.
 * The visits and purchase orders on those boards already carry their own client
 * join, so this was never what rendered the board; it was only ever the picker
 * and the snapshot taken when a store is published.
 *
 * Two narrowings, both safe:
 *
 *   1. **Server-side filter.** `isListableCustomer` in lib/client-info.ts is
 *      `status = 'active' and customer_type in ('new','existing')` — a prospect
 *      has never placed an order, so there is nothing to collect or deliver.
 *      The page still calls `listableCustomers()` on the result, which is now a
 *      no-op it can keep as a safety net.
 *
 *   2. **Only the columns these two surfaces read.** The picker needs a name
 *      and an address (`clientWhere` -> `clientAddress`), the Add-store dialog
 *      auto-fills from `credit_balance`, and publishing snapshots the name and
 *      city onto the row because the phone has no RLS read on `clients`. The
 *      joined agent profile — the single largest part of the old payload — is
 *      not read by any of them.
 *
 * NOT a full `Client`, despite the type. Cast for the same reason `useProfiles`
 * casts its narrowed select: every consumer here reads only the columns above,
 * and threading a `Pick<>` through ClientPicker and both dialogs would buy
 * nothing. Do not hand these rows to something expecting a whole client.
 */

const LISTABLE_COLUMNS = `
  id, company_name, customer_type, status, credit_balance,
  office_address, address_line1, address_line2, landmark, city, province
`

const EMPTY: Client[] = []

export function useListableClients({ enabled = true }: { enabled?: boolean } = {}) {
  const { data, loading, error, reload, refresh } = useCachedResource<Client[]>(
    'listable-clients',
    async () => {
      const { data: rows, error: queryError } = await createClient()
        .from('clients')
        .select(LISTABLE_COLUMNS)
        .eq('status', 'active')
        .in('customer_type', ['new', 'existing'])
        .order('company_name')

      if (queryError) throw new Error(queryError.message)
      return (rows ?? []).map(row => ({
        ...(row as unknown as Client),
        // PostgREST can serialise NUMERIC as a string; coerce so the Add-store
        // dialog's auto-fill does arithmetic on a number.
        credit_balance: Number((row as { credit_balance?: unknown }).credit_balance ?? 0),
      }))
    },
    EMPTY,
  )

  // A customer becoming listable is a lifecycle change measured in days, and
  // this list is a dropdown rather than a board — slow lane. The probe still
  // catches a promotion the same tick it happens.
  useAutoRefresh(reload, {
    watch: [{ table: 'clients' }],
    intervalMs: SLOW_INTERVAL_MS,
    enabled,
  })

  return { clients: data, loading, error, refresh, reload }
}
