'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAutoRefresh, LIVE_INTERVAL_MS } from '@/lib/hooks/use-auto-refresh'
import { useCachedResource } from '@/lib/hooks/use-cached-resource'
import { subscribeToNotifications } from '@/lib/realtime/notification-feed'
import { FIELD_LABEL } from '@/lib/status-styles'
import type { ClientEditRequest, PoConfirmationRequest } from '@/types'
import type { EditDecisionTarget } from '@/lib/approvals/decisions'

/**
 * The Approvals queue, paged in Postgres.
 *
 * Replaces `useEditRequests` + `usePoConfirmations`, which between them fetched
 * every edit request and every PO confirmation — including every historically
 * decided one, three joins each — so the page could show nine cards.
 *
 * They could not be paged independently, either: the page MERGES the two and
 * sorts the merge, so a window of one is meaningless without the other. That is
 * why `get_approval_feed()` (migration 137) unions them in the database.
 */

export type ApprovalKind = 'all' | 'edit' | 'po'

export type ApprovalItem =
  | { kind: 'edit'; key: string; item: ClientEditRequest }
  | { kind: 'po'; key: string; item: PoConfirmationRequest }

/** A pending edit as the bulk selection sees it: enough to decide and to log. */
export interface PendingEditEntry extends EditDecisionTarget {
  /** Whose queue it belongs to — the selection is locked to one agent. */
  requestedBy: string
}

export interface ApprovalRequester {
  id: string
  name: string
  teamId: string | null
}

export interface ApprovalFeed {
  pending: { rows: ApprovalItem[]; total: number }
  resolved: { rows: ApprovalItem[]; total: number }
  /**
   * Every filtered PENDING edit, not just the visible page — the bulk
   * selection's scope. "Select all 12 from this agent" must mean all twelve,
   * including the three on page two: pagination is a viewport here, not a
   * scope. Bounded by the backlog rather than by history.
   */
  pendingEditIndex: PendingEditEntry[]
  requesters: ApprovalRequester[]
}

export const APPROVALS_PAGE_SIZE = 9

export const EMPTY_APPROVAL_FEED: ApprovalFeed = {
  pending: { rows: [], total: 0 },
  resolved: { rows: [], total: 0 },
  pendingEditIndex: [],
  requesters: [],
}

export interface ApprovalFilters {
  search: string
  kind: ApprovalKind
  /** 'all', or a profile id. */
  agentId: string
  range: { start: Date; end: Date } | null
}

export function useApprovalFeed(
  filters: ApprovalFilters,
  pendingPage: number,
  resolvedPage: number,
  pageSize = APPROVALS_PAGE_SIZE,
) {
  const args = {
    p_search: filters.search.trim() || null,
    p_kind: filters.kind,
    p_agent_id: filters.agentId === 'all' ? null : filters.agentId,
    p_from: filters.range?.start.toISOString() ?? null,
    p_to: filters.range?.end.toISOString() ?? null,
    // The search box matches the HUMAN label of a changed field, so the map
    // travels to the query rather than being duplicated in SQL.
    p_field_labels: FIELD_LABEL,
    p_pending_limit: pageSize,
    p_pending_offset: (pendingPage - 1) * pageSize,
    p_resolved_limit: pageSize,
    p_resolved_offset: (resolvedPage - 1) * pageSize,
  }

  const key = `approval-feed:${JSON.stringify(args)}`

  const { data, loading, error, reload, refresh } = useCachedResource<ApprovalFeed>(
    key,
    async () => {
      const { data: result, error: rpcError } = await createClient()
        .rpc('get_approval_feed', args)
      if (rpcError) throw new Error(rpcError.message)
      return (result ?? EMPTY_APPROVAL_FEED) as ApprovalFeed
    },
    EMPTY_APPROVAL_FEED,
  )

  /**
   * Only `client_edit_requests` is probed.
   *
   * `po_confirmation_requests` deliberately is not: the change-stamp probe goes
   * through the browser's Supabase client, and 039's SELECT policy hides that
   * table from admins — the probe would read an empty set forever and the stamp
   * would never move, which would freeze this whole feed rather than just the
   * PO half of it. Watching the half that IS visible, on the fast lane, keeps
   * the queue current; the MAX_SKIP_MS backstop in use-auto-refresh covers a
   * PO that moves while edits are quiet.
   */
  useAutoRefresh(reload, {
    watch: [{ table: 'client_edit_requests' }],
    intervalMs: LIVE_INTERVAL_MS,
  })

  /**
   * ...and an arrival is instant, on the socket the bell already holds open.
   *
   * Both triggers fire in the same transaction as the row they announce
   * (`trg_notify_edit_request`, 083; the PO arm, 085), so hearing the
   * notification and re-reading is the same news the poll would bring 30
   * seconds later. A DECISION emits nothing by design — 083 only rings for
   * pending work — so a queue shrinking still comes from the poll above.
   */
  useEffect(() => {
    return subscribeToNotifications(row => {
      if (row.type === 'edit_request_submitted' || row.type === 'po_confirmation_request') {
        void reload()
      }
    })
  }, [reload])

  return { feed: data, loading, error, refresh, reload }
}
