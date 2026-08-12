'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canManageUsers, PASSWORD_MIN_LENGTH } from '@/lib/permissions'
import { AVATAR_ACCEPTED_TYPES } from '@/lib/avatar'
import { adminScope } from '@/lib/permissions'
import type { AdminScope, Team, TeamKind, UserRole } from '@/types'

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

interface CallerProfile {
  id: string
  role: UserRole
}

/**
 * Authorizes the caller and hands back who they are.
 *
 * Most actions here only need the yes/no and use requireCallerIsSuperadmin
 * below; toggleUserStatus also needs the caller's own profile id, to stop a
 * superadmin deactivating themselves. Both share this single lookup rather than
 * querying profiles twice for the same row.
 */
async function loadCallerProfile(): Promise<{ error: string | null; caller: CallerProfile | null }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.', caller: null }

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('user_id', user.id)
    .single()

  if (!canManageUsers(callerProfile?.role as UserRole | undefined)) {
    return { error: 'Only a superadmin can manage users.', caller: null }
  }
  return { error: null, caller: { id: callerProfile!.id, role: callerProfile!.role as UserRole } }
}

/** Only a superadmin may create/edit/deactivate any user. Admins are view-only. */
async function requireCallerIsSuperadmin(): Promise<string | null> {
  return (await loadCallerProfile()).error
}

/** Long enough to be recognisable in a dropdown, short enough not to break it. */
const TEAM_NAME_MAX = 60

/**
 * Creates a team.
 *
 * Until migration 075 there was no way to do this from the app at all: the four
 * teams came from seed migrations, and `lib/teams.ts` filtered the Users picker
 * against their hardcoded UUIDs — so even a team inserted by hand in the SQL
 * editor would not appear in the dropdown. Adding a team meant a migration, a
 * code change and a deploy.
 *
 * Service-role, like every other action in this file: 005_teams_read_policy.sql
 * gave `teams` a SELECT policy and nothing more, and the superadmin check is the
 * authorization rather than RLS. The alternative — an INSERT policy on the table
 * — would open a second, weaker path to the same write.
 */
export async function createTeam(
  name: string,
  kind: TeamKind
): Promise<{ error: string | null; team: Team | null }> {
  const permError = await requireCallerIsSuperadmin()
  if (permError) return { error: permError, team: null }

  const trimmed = name.trim()
  if (!trimmed) return { error: 'Team name is required.', team: null }
  if (trimmed.length > TEAM_NAME_MAX) {
    return { error: `Team name must be ${TEAM_NAME_MAX} characters or fewer.`, team: null }
  }
  if (kind !== 'sales' && kind !== 'rsr') {
    return { error: 'Choose whether this is a Sales or an RSR team.', team: null }
  }

  const supabase = createAdminClient()

  const { data: team, error } = await supabase
    .from('teams')
    .insert({ name: trimmed, kind })
    .select('id, name, kind, manager_id, created_at')
    .single()

  if (error) {
    // 075's teams_name_unique is case-insensitive, so the collision the admin
    // needs to hear about is "that name is taken", not the raw index name.
    // 23505 is unique_violation.
    if (error.code === '23505') {
      return { error: `A team called "${trimmed}" already exists.`, team: null }
    }
    return { error: error.message, team: null }
  }

  return { error: null, team: team as Team }
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

  // profiles.email is only a display copy — the address someone actually signs
  // in with lives in auth.users, so an edit has to move both or the account
  // silently keeps accepting the old address.
  const { data: existing, error: lookupError } = await supabase
    .from('profiles')
    .select('user_id, email')
    .eq('id', profileId)
    .single()

  if (lookupError || !existing?.user_id) {
    return { error: lookupError?.message ?? 'User not found.' }
  }

  if (existing.email !== data.email) {
    // Auth first: it is the half that can reject (address already taken), and
    // failing before the profiles write leaves the two in sync.
    // email_confirm skips the confirmation mail — these are admin-issued
    // accounts on addresses that often have no real mailbox, matching
    // createUser above.
    const { error: emailError } = await supabase.auth.admin.updateUserById(
      existing.user_id,
      { email: data.email, email_confirm: true }
    )
    if (emailError) return { error: emailError.message }
  }

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
 * Sets a new password on someone else's account.
 *
 * There is no self-service reset flow: field staff are issued credentials by a
 * superadmin at creation and often have no reachable mailbox, so recovery is
 * the same channel — an admin sets it here and passes it on directly.
 */
export async function resetUserPassword(
  profileId: string,
  password: string
): Promise<{ error: string | null }> {
  const permError = await requireCallerIsSuperadmin()
  if (permError) return { error: permError }

  // Mirrors the create form's rule, re-checked here because the action is
  // reachable without going through it.
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` }
  }

  const supabase = createAdminClient()

  const { data: profile, error: lookupError } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('id', profileId)
    .single()

  if (lookupError || !profile?.user_id) {
    return { error: lookupError?.message ?? 'User not found.' }
  }

  const { error } = await supabase.auth.admin.updateUserById(profile.user_id, { password })

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

/**
 * Activates or deactivates an account.
 *
 * `deactivated_at` is deliberately NOT set here — migration 095 stamps it from
 * a trigger, so the archive clock is correct no matter who flips the flag (this
 * action, the mobile repo, or a hand-edit in the SQL editor).
 *
 * The two guards below only became load-bearing once deactivation started
 * enforcing on web. Before that this was a cosmetic badge and locking yourself
 * out was impossible; now the same click can end your own session, or the last
 * superadmin's, with no way back in through the UI that would fix it.
 */
export async function toggleUserStatus(profileId: string, isActive: boolean): Promise<{ error: string | null }> {
  const { error: authError, caller } = await loadCallerProfile()
  if (authError || !caller) return { error: authError ?? 'Only a superadmin can manage users.' }

  const supabase = createAdminClient()

  if (!isActive) {
    if (caller.id === profileId) {
      return { error: 'You cannot deactivate your own account. Ask another super admin to do it.' }
    }

    const { data: target, error: targetError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', profileId)
      .single()

    if (targetError || !target) return { error: targetError?.message ?? 'User not found.' }

    // Losing the last active superadmin means nobody can create users, reset
    // passwords, or reactivate anyone — and no path through the app to undo it.
    if (target.role === 'superadmin') {
      const { count, error: countError } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'superadmin')
        .eq('is_active', true)

      if (countError) return { error: countError.message }
      if ((count ?? 0) <= 1) {
        return { error: 'This is the only active super admin. Promote another one before deactivating this account.' }
      }
    }
  }

  const { error } = await supabase
    .from('profiles')
    .update({ is_active: isActive })
    .eq('id', profileId)

  return { error: error?.message ?? null }
}
