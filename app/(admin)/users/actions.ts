'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canManageUsers } from '@/lib/permissions'
import type { UserRole } from '@/types'

interface CreateUserPayload {
  full_name: string
  email: string
  password: string
  role: UserRole
  team_id: string | null
}

interface UpdateUserPayload {
  full_name: string
  email: string
  role: UserRole
  team_id: string | null
}

/** Only a superadmin may create/edit/deactivate any user. Admins are view-only. */
async function requireCallerIsSuperadmin(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return 'Not authenticated.'

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()

  if (!canManageUsers(callerProfile?.role as UserRole | undefined)) {
    return 'Only a superadmin can manage users.'
  }
  return null
}

export async function createUser(data: CreateUserPayload): Promise<{ error: string | null }> {
  const permError = await requireCallerIsSuperadmin()
  if (permError) return { error: permError }

  const supabase = createAdminClient()

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: data.email,
    password: data.password,
    email_confirm: true,
    user_metadata: { full_name: data.full_name },
  })
  if (authError) return { error: authError.message }

  const { error: profileError } = await supabase.from('profiles').insert({
    user_id: authData.user.id,
    full_name: data.full_name,
    email: data.email,
    role: data.role,
    team_id: data.team_id || null,
    is_active: true,
  })

  if (profileError) {
    await supabase.auth.admin.deleteUser(authData.user.id)
    return { error: profileError.message }
  }

  return { error: null }
}

export async function updateUser(profileId: string, data: UpdateUserPayload): Promise<{ error: string | null }> {
  const authError = await requireCallerIsSuperadmin()
  if (authError) return { error: authError }

  const supabase = createAdminClient()

  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: data.full_name,
      email: data.email,
      role: data.role,
      team_id: data.team_id || null,
    })
    .eq('id', profileId)

  return { error: error?.message ?? null }
}

export async function toggleUserStatus(profileId: string, isActive: boolean): Promise<{ error: string | null }> {
  const authError = await requireCallerIsSuperadmin()
  if (authError) return { error: authError }

  const supabase = createAdminClient()

  const { error } = await supabase
    .from('profiles')
    .update({ is_active: isActive })
    .eq('id', profileId)

  return { error: error?.message ?? null }
}
