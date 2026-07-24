'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canManageUsers } from '@/lib/permissions'
import { AVATAR_ACCEPTED_TYPES } from '@/lib/avatar'
import { adminScope } from '@/lib/permissions'
import type { AdminScope, UserRole } from '@/types'

const AVATAR_BUCKET = 'avatars'

/**
 * The picker downscales to a ~100 KB JPEG first, so anything near this is a
 * client that skipped the resize — reject rather than push Next's action body
 * limit.
 */
const AVATAR_MAX_BYTES = 1024 * 1024

interface CreateUserPayload {
  full_name: string
  email: string
  password: string
  role: UserRole
  admin_scope: AdminScope
  team_id: string | null
}

interface UpdateUserPayload {
  full_name: string
  email: string
  role: UserRole
  admin_scope: AdminScope
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

export async function createUser(
  data: CreateUserPayload
): Promise<{ error: string | null; profileId: string | null }> {
  const permError = await requireCallerIsSuperadmin()
  if (permError) return { error: permError, profileId: null }

  const supabase = createAdminClient()

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: data.email,
    password: data.password,
    email_confirm: true,
    user_metadata: { full_name: data.full_name },
  })
  if (authError) return { error: authError.message, profileId: null }

  // The id comes back so the caller can follow up with uploadUserAvatar —
  // the photo can only be attached once the profile row exists.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .insert({
      user_id: authData.user.id,
      full_name: data.full_name,
      email: data.email,
      role: data.role,
      // Normalised server-side: the DB rejects a narrowed scope on a non-admin
      // (profiles_admin_scope_role_check), so don't rely on the form for it.
      admin_scope: adminScope(data.role, data.admin_scope),
      team_id: data.team_id || null,
      is_active: true,
    })
    .select('id')
    .single()

  if (profileError) {
    await supabase.auth.admin.deleteUser(authData.user.id)
    return { error: profileError.message, profileId: null }
  }

  return { error: null, profileId: profile.id }
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
      admin_scope: adminScope(data.role, data.admin_scope),
      team_id: data.team_id || null,
    })
    .eq('id', profileId)

  return { error: error?.message ?? null }
}

/**
 * Sets a profile photo on someone else's account.
 *
 * Storage RLS only lets a signed-in user write inside their own {user_id}/
 * folder (migration 012), which is right for the mobile app's own profile
 * screen but blocks an admin uploading on a field agent's behalf. This runs
 * on the service-role key instead, so the superadmin check above is the only
 * thing standing between the caller and every avatar in the bucket — the
 * profile id is resolved to a user id here rather than trusted from the client.
 */
export async function uploadUserAvatar(
  formData: FormData
): Promise<{ error: string | null; avatarUrl: string | null }> {
  const permError = await requireCallerIsSuperadmin()
  if (permError) return { error: permError, avatarUrl: null }

  const profileId = formData.get('profileId')
  const file = formData.get('file')

  if (typeof profileId !== 'string' || !profileId) {
    return { error: 'Missing user.', avatarUrl: null }
  }
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'No image was uploaded.', avatarUrl: null }
  }
  if (!AVATAR_ACCEPTED_TYPES.includes(file.type)) {
    return { error: 'Photo must be a JPEG, PNG, or WebP image.', avatarUrl: null }
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return { error: 'Photo is too large.', avatarUrl: null }
  }

  const supabase = createAdminClient()

  const { data: profile, error: lookupError } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('id', profileId)
    .single()

  if (lookupError || !profile?.user_id) {
    return { error: lookupError?.message ?? 'User not found.', avatarUrl: null }
  }

  const path = `${profile.user_id}/avatar.jpg`
  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, await file.arrayBuffer(), {
      contentType: file.type,
      upsert: true,
    })
  if (uploadError) return { error: uploadError.message, avatarUrl: null }

  const { data: { publicUrl } } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path)
  // The path is stable per user, so only a changing query string tells the
  // browser (and the map markers) that the image behind it is new.
  const avatarUrl = `${publicUrl}?v=${Date.now()}`

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', profileId)
  if (updateError) return { error: updateError.message, avatarUrl: null }

  return { error: null, avatarUrl }
}

export async function removeUserAvatar(profileId: string): Promise<{ error: string | null }> {
  const permError = await requireCallerIsSuperadmin()
  if (permError) return { error: permError }

  const supabase = createAdminClient()

  const { data: profile, error: lookupError } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('id', profileId)
    .single()

  if (lookupError || !profile?.user_id) {
    return { error: lookupError?.message ?? 'User not found.' }
  }

  // Clear the whole folder, not just avatar.jpg — the mobile app uploads its
  // own file name and would otherwise leave an orphan behind.
  const { data: objects } = await supabase.storage.from(AVATAR_BUCKET).list(profile.user_id)
  if (objects?.length) {
    await supabase.storage
      .from(AVATAR_BUCKET)
      .remove(objects.map(o => `${profile.user_id}/${o.name}`))
  }

  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: null })
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
