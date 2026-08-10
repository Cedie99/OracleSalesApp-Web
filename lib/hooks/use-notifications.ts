'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Notification } from '@/types'

interface UseNotificationsResult {
  notifications: Notification[]
  unreadCount: number
  /** This admin's read watermark; a row is unread when created after it. */
  seenAt: string | null
  loading: boolean
  refresh: () => Promise<void>
  /** Advances this admin's seen watermark — called when the bell panel opens. */
  markAllRead: () => Promise<void>
}

const NOTIFICATION_COLUMNS = 'id, type, title, message, module, entity_id, client_id, read_at, created_at'
const NOTIFICATION_LIMIT = 50

/**
 * Admin notification feed (bell icon in the header). See migrations 047 & 083.
 *
 * Visibility is enforced server-side by RLS: this query only returns rows for
 * the signed-in admin's module (plus system-wide alerts), so no scope filtering
 * is needed here. Read state is per-admin via the notification_reads watermark:
 * anything created after `seenAt` is unread. New rows arrive live over realtime.
 */
export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [seenAt, setSeenAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [{ data: rows }, { data: userData }] = await Promise.all([
      supabase
        .from('notifications')
        .select(NOTIFICATION_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(NOTIFICATION_LIMIT),
      supabase.auth.getUser(),
    ])

    let watermark: string | null = null
    const userId = userData.user?.id
    if (userId) {
      const { data: readRow } = await supabase
        .from('notification_reads')
        .select('seen_at')
        .eq('profile_id', userId)
        .maybeSingle()
      watermark = (readRow?.seen_at as string | undefined) ?? null
    }

    setNotifications((rows as Notification[] | null) ?? [])
    setSeenAt(watermark)
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // Live updates: prepend any notification inserted while this session is open.
  // RLS on the publication means only rows this admin may see are delivered.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('notifications-feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        payload => {
          const row = payload.new as Notification
          setNotifications(prev =>
            prev.some(n => n.id === row.id) ? prev : [row, ...prev].slice(0, NOTIFICATION_LIMIT)
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString()
    setSeenAt(now)

    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) return
    await supabase
      .from('notification_reads')
      .upsert({ profile_id: userId, seen_at: now }, { onConflict: 'profile_id' })
  }, [])

  const unreadCount = notifications.filter(
    n => !seenAt || new Date(n.created_at) > new Date(seenAt)
  ).length

  return {
    notifications,
    unreadCount,
    seenAt,
    loading,
    refresh: load,
    markAllRead,
  }
}
