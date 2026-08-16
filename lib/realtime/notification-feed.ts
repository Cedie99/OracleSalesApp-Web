'use client'

import { createClient } from '@/lib/supabase/client'
import type { Notification } from '@/types'

/**
 * The one realtime socket this app opens, shared by everything that wants to
 * know the instant something happened.
 *
 * `notifications` is the ONLY table in the `supabase_realtime` publication
 * (migration 083, and 085 says so explicitly). That turns out to be enough for
 * more than the bell, because the notification triggers fire on the same writes
 * the badges count — a pending `client_edit_requests` row inserts an
 * `edit_request_submitted` notification in the same transaction
 * (`trg_notify_edit_request`, 083). So a hook that wants sub-second news about
 * edit requests does not need `client_edit_requests` added to the publication
 * and a second socket opened; it needs to hear the notification that already
 * travels down this one.
 *
 * Why a module-level channel rather than a `useEffect` per hook:
 *
 *  - **One socket per tab, not one per subscriber.** Two hooks subscribing used
 *    to mean two websockets carrying identical rows.
 *  - **Its lifetime is not one component's.** The channel used to live inside
 *    `useNotifications`, which is mounted by the header — so any other hook
 *    listening in would have silently gone deaf the moment a page rendered
 *    without a header. Refcounting here means the socket is open exactly while
 *    somebody is listening, whoever that is.
 *
 * This is deliberately the live path, not the only path. Realtime carries the
 * raw inserted row and nothing else — no joins, no updates, no deletes, and
 * nothing at all if the socket quietly dies. The polling in use-auto-refresh.ts
 * is what makes those cases correct; this just makes the common one instant.
 */

type Listener = (row: Notification) => void

const listeners = new Set<Listener>()

/**
 * Held so the channel can be removed from the same client that created it —
 * `createClient()` hands back a new browser client per call, and removing a
 * channel from a different instance is a no-op that leaks the socket.
 */
let supabase: ReturnType<typeof createClient> | null = null
let channel: ReturnType<ReturnType<typeof createClient>['channel']> | null = null

function open() {
  supabase = createClient()
  channel = supabase
    .channel('notifications-feed')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications' },
      payload => {
        const row = payload.new as Notification
        // Copied out first: a listener that throws must not cost the others
        // their event, and one may unsubscribe while we are iterating.
        for (const listener of [...listeners]) {
          try {
            listener(row)
          } catch {
            // A subscriber's own failure is its own problem.
          }
        }
      }
    )
    .subscribe()
}

function close() {
  if (supabase && channel) supabase.removeChannel(channel)
  supabase = null
  channel = null
}

/**
 * Hear every notification inserted while this tab is open, as it lands.
 *
 * RLS is applied per subscriber on the publication, so a listener is only ever
 * handed rows the signed-in admin may see — a Collection Admin never learns that
 * a sales edit request exists.
 *
 * Returns the unsubscribe function; call it from the effect's cleanup. The
 * socket closes when the last listener leaves.
 */
export function subscribeToNotifications(listener: Listener): () => void {
  listeners.add(listener)
  if (!channel) open()

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) close()
  }
}
