'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Notification } from '@/types'

interface UseNotificationsResult {
  notifications: Notification[]
  unreadCount: number
  loading: boolean
  refresh: () => Promise<void>
  /** Marks every currently-unread notification read — called when the bell panel opens. */
  markAllRead: () => Promise<void>
}

const NOTIFICATION_COLUMNS = 'id, type, title, message, client_id, read_at, created_at'
const NOTIFICATION_LIMIT = 50

/** Admin notification feed (bell icon in the header). See migration 047. */
export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('notifications')
      .select(NOTIFICATION_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(NOTIFICATION_LIMIT)
    setNotifications((data as Notification[] | null) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const markAllRead = useCallback(async () => {
    const unreadIds = notifications.filter(n => !n.read_at).map(n => n.id)
    if (unreadIds.length === 0) return

    const now = new Date().toISOString()
    setNotifications(prev => prev.map(n => (n.read_at ? n : { ...n, read_at: now })))

    const supabase = createClient()
    await supabase.from('notifications').update({ read_at: now }).in('id', unreadIds)
  }, [notifications])

  return {
    notifications,
    unreadCount: notifications.filter(n => !n.read_at).length,
    loading,
    refresh: load,
    markAllRead,
  }
}
