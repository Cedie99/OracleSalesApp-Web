'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types'

interface UseCurrentProfileResult {
  profile: Profile | null
  loading: boolean
}

/** The logged-in user's real profile (role, team_id, full_name) from Supabase. */
export function useCurrentProfile(): UseCurrentProfileResult {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const supabase = createClient()

    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        if (active) setLoading(false)
        return
      }

      const { data: profileData } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', data.user.id)
        .single()

      if (active) {
        setProfile(profileData as Profile | null)
        setLoading(false)
      }
    })

    return () => {
      active = false
    }
  }, [])

  return { profile, loading }
}
