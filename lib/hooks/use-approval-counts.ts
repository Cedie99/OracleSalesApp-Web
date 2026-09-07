'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchPendingApprovalCounts } from '@/lib/approvals/actions'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { subscribeToNotifications } from '@/lib/realtime/notification-feed'

/**
 * The number on the sidebar's Approvals pill.
 *
 * Replaces the pair of full-table hooks the sidebar used to mount
 * (`useEditRequests` + `usePoConfirmations`, every row of both with three joins
 * each) with a single call that returns two integers. See the header of
 * lib/approvals/actions.ts for why both halves go through the server.
 *
 * The Approvals PAGE still mounts the full hooks — it renders the requests, so
 * it genuinely needs them. This hook exists for the ~12 other pages that mount
 * the sidebar and need nothing but the count.
 */
export function useApprovalCounts() {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  // State is only touched after the await — see the note in use-clients.ts.
  const load = useCallback(async () => {
    const result = await fetchPendingApprovalCounts()
    // A failed count keeps the last good number on screen rather than blinking
    // to zero, which would read as "nothing to approve" — the opposite of what
    // an unreachable server means.
    if (!result.error) setCount(result.total)
    setLoading(false)
  }, [])

  useEffect(() => {
    // See the note in use-clients.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  /**
   * No `watch` spec, deliberately.
   *
   * The change-stamp probe exists to avoid re-running an expensive query, and
   * this query is two integers — probing two tables to decide whether to fetch
   * two numbers costs more than just fetching them. It also could not be made
   * correct cheaply: a probe on `client_edit_requests` alone would report
   * "unchanged" when only a PO moved, freezing that half of the pill until the
   * MAX_SKIP_MS backstop fired ten minutes later.
   */
  useAutoRefresh(load, { intervalMs: LIVE_INTERVAL_MS })

  /**
   * ...and an arrival is instant, on the socket the bell already holds open.
   *
   * Both triggers fire in the same transaction as the row they announce
   * (`trg_notify_edit_request`, 083; the PO arm, 085), so hearing the
   * notification and re-counting is the same news the poll would bring 30
   * seconds later. A DECISION emits nothing by design — 083 only rings for
   * pending work — so the pill's decrement still comes from the poll above.
   */
  useEffect(() => {
    return subscribeToNotifications(row => {
      if (row.type === 'edit_request_submitted' || row.type === 'po_confirmation_request') {
        void load()
      }
    })
  }, [load])

  return { count, loading }
}
