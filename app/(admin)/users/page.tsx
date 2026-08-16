'use client'

import { useState, useEffect, useRef } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Pagination } from '@/components/ui/pagination'
import { usePagination } from '@/lib/hooks/use-pagination'
import {
  Search, UserPlus, Users, ShieldCheck, ShieldEllipsis, Briefcase, User,
  MoreHorizontal, Pencil, Ban, Eye, EyeOff, Store, Wallet, RefreshCw,
  Monitor, Smartphone, Truck, CircleHelp, ImagePlus, Trash2, KeyRound,
  ArrowUp, ArrowDown, ArrowUpDown, LineChart, UserCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import {
  createUser, updateUser, toggleUserStatus, uploadUserAvatar, removeUserAvatar, resetUserPassword,
  createTeam,
} from './actions'
import {
  AVATAR_ACCEPT_ATTR, AVATAR_ACCEPTED_TYPES, AVATAR_MAX_SOURCE_BYTES, resizeAvatar,
} from '@/lib/avatar'
import {
  ADMIN_SCOPES, ADMIN_SCOPE_DESCRIPTION, ADMIN_SCOPE_LABEL, adminScope,
  canManageUsers, platformForRole, roleScopeLabel, phoneRequiredForRole,
  PASSWORD_MIN_LENGTH, DEFAULT_PASSWORD,
} from '@/lib/permissions'
import {
  ARCHIVE_AFTER_DAYS, ACCOUNT_STATUS_LABEL, accountStatus, deactivatedSinceLabel,
  type AccountStatus,
} from '@/lib/users'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh'
import { teamsForRole, teamKindForRole, roleHasTeam, managerForTeam } from '@/lib/teams'
import type { AdminScope, TeamKind, UserRole } from '@/types'
import { TEAM_KIND_LABEL } from '@/types'
import { PLATFORM_TONE, ROLE_TONE, TONE_CLASS, TONE_TEXT, roleTone } from '@/lib/status-styles'

const ROLE_ICON: Record<UserRole, React.ElementType> = {
  superadmin: ShieldEllipsis,
  admin: ShieldCheck,
  // Not a shield: an executive administers nothing. The chart says what the
  // account is actually for — reading the numbers everyone else produces.
  executive: LineChart,
  sales_manager: Briefcase,
  sales_specialist: User,
  rsr: Store,
  collector: Wallet,
  delivery: Truck,
}

/**
 * Icon per admin category. The icon carries the business function (wallet =
 * collection) while the label carries the level ("Collection Admin"), so it
 * intentionally matches the icon of the field role that function belongs to.
 */
const ADMIN_SCOPE_ICON: Record<AdminScope, LucideIcon> = {
  all: ShieldCheck,
  sales: Briefcase,
  collection: Wallet,
  delivery: Truck,
}

const PLATFORM_META = {
  web: { label: 'Web', icon: Monitor, style: TONE_CLASS[PLATFORM_TONE.web] },
  mobile: { label: 'Mobile App', icon: Smartphone, style: TONE_CLASS[PLATFORM_TONE.mobile] },
} as const

const ROLE_DESCRIPTION: Record<UserRole, string> = {
  superadmin: 'Full system access — the only role that can create or edit admin accounts.',
  admin: 'Operational access to the modules its category covers — user management is view-only.',
  executive: 'Read-only oversight of every team in the mobile app — dashboards, reports, and maps. Records and approves nothing.',
  sales_manager: 'Oversees a team of sales specialists or RSRs, approves client changes, and views all team sales.',
  sales_specialist: 'Front-line sales agent that logs meetings, clients, and clock records.',
  rsr: 'Route Sales Representative — visits stores daily and logs field activity.',
  collector: 'Handles payment collection from assigned stores with cash/check proof.',
  delivery: 'Delivers purchase orders and captures receiver name plus a proof photo — no GPS, per confirmed scope.',
}

interface TeamRow {
  id: string
  name: string
  kind: TeamKind
}

interface UserRow {
  id: string
  user_id: string
  full_name: string
  email: string
  role: UserRole
  admin_scope: AdminScope
  team_id: string | null
  is_active: boolean
  deactivated_at: string | null
  avatar_url: string | null
  contact_number: string | null
  created_at: string
}

interface UserFormData {
  full_name: string
  email: string
  password: string
  role: UserRole
  admin_scope: AdminScope
  team_id: string
  contact_number: string
}

type SortKey = 'user' | 'role' | 'platform' | 'team' | 'created' | 'status'

/** 'current' is everything that is not archived — see the statusFilter state. */
type StatusFilter = 'current' | AccountStatus

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  current: 'Active & Inactive',
  active: 'Active only',
  inactive: 'Inactive only',
  archived: `Archived (${ARCHIVE_AFTER_DAYS}+ days)`,
}

/** Active reads as live, inactive as a state someone should act on, archived as dormant. */
const STATUS_TONE: Record<AccountStatus, 'brand' | 'amber' | 'neutral'> = {
  active: 'brand',
  inactive: 'amber',
  archived: 'neutral',
}

/** Archived sorts last: it is the furthest from "in use". */
const STATUS_RANK: Record<AccountStatus, number> = {
  active: 0,
  inactive: 1,
  archived: 2,
}

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

/**
 * Role column order — seniority, not the alphabet. Sorting by role is a
 * question about the org chart ("show me the admins"), and A-Z would open on
 * Collector and bury Super Admin in the middle.
 */
const ROLE_ORDER: UserRole[] = [
  'superadmin', 'admin', 'executive', 'sales_manager', 'sales_specialist', 'rsr', 'collector', 'delivery',
]

/**
 * Roles this build has no definition for sort last rather than crashing or
 * landing at the top — profiles.role is shared with the mobile repo, which has
 * shipped a role web didn't know about before (see roleLabel).
 */
function roleRank(role: string): number {
  const i = ROLE_ORDER.indexOf(role as UserRole)
  return i === -1 ? ROLE_ORDER.length : i
}

/**
 * Which direction a column opens on first click. Dates read newest-first
 * everywhere else in the app, so Created matches; the rest start A-Z.
 */
const DEFAULT_SORT_DIR: Record<SortKey, SortState['dir']> = {
  user: 'asc',
  role: 'asc',
  platform: 'asc',
  team: 'asc',
  created: 'desc',
  status: 'asc',
}

/** Split out so the deactivated_at fallback in loadUsers can reuse the list verbatim. */
const USER_COLUMNS = 'id, user_id, full_name, email, role, admin_scope, team_id, is_active, avatar_url, created_at'

const EMPTY_FORM: UserFormData = {
  full_name: '',
  email: '',
  // Pre-filled, not forced — the admin can overwrite it before saving.
  password: DEFAULT_PASSWORD,
  role: 'sales_specialist',
  admin_scope: 'all',
  team_id: '',
  contact_number: '',
}

export default function UsersPage() {
  const { profile } = useCurrentProfile()
  const canManage = canManageUsers(profile?.role)
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')

  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  // Defaults to 'current' (active + inactive), NOT 'all' — an account inactive
  // for a year drops off this list, and that hiding is the whole point of the
  // archive rule. 'archived' is how you get them back.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('current')
  const [teams, setTeams] = useState<TeamRow[]>([])
  // Matches the query's own .order('created_at', desc), so the first paint is
  // sorted the same way with or without a click.
  const [sort, setSort] = useState<SortState>({ key: 'created', dir: 'desc' })

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<UserRow | null>(null)
  const [form, setForm] = useState<UserFormData>(EMPTY_FORM)
  const [showPassword, setShowPassword] = useState(false)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const [deactivateTarget, setDeactivateTarget] = useState<UserRow | null>(null)
  const [deactivateError, setDeactivateError] = useState('')
  const [deactivating, setDeactivating] = useState(false)

  // Password reset keeps its own state: it is a separate dialog from the
  // create/edit form and must not inherit a half-filled UserFormData.
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [resetError, setResetError] = useState('')

  // Avatar lives outside UserFormData because it is a File, not a text field.
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarCleared, setAvatarCleared] = useState(false)
  const objectUrlRef = useRef<string | null>(null)

  function releasePreview() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }

  function resetAvatar(existingUrl: string | null) {
    releasePreview()
    setAvatarFile(null)
    setAvatarPreview(existingUrl)
    setAvatarCleared(false)
  }

  useEffect(() => releasePreview, [])

  async function handleAvatarPick(file: File) {
    if (!AVATAR_ACCEPTED_TYPES.includes(file.type)) {
      setFormError('Photo must be a JPEG, PNG, or WebP image.')
      return
    }
    if (file.size > AVATAR_MAX_SOURCE_BYTES) {
      setFormError('Photo is too large — pick an image under 5 MB.')
      return
    }

    let resized: File
    try {
      resized = await resizeAvatar(file)
    } catch {
      setFormError('That image could not be read.')
      return
    }

    releasePreview()
    objectUrlRef.current = URL.createObjectURL(resized)
    setAvatarFile(resized)
    setAvatarPreview(objectUrlRef.current)
    setAvatarCleared(false)
    setFormError('')
  }

  function handleAvatarClear() {
    releasePreview()
    setAvatarFile(null)
    setAvatarPreview(null)
    setAvatarCleared(true)
  }

  /**
   * Runs after the profile row is saved — the photo needs an existing profile
   * to hang off. Returns a message if the profile saved but the photo didn't,
   * which the callers surface at page level rather than in the (now closed)
   * dialog.
   */
  async function syncAvatar(profileId: string, hadAvatar: boolean): Promise<string> {
    if (avatarFile) {
      const payload = new FormData()
      payload.append('profileId', profileId)
      payload.append('file', avatarFile)
      const { error } = await uploadUserAvatar(payload)
      return error ? `Profile saved, but the photo failed to upload: ${error}` : ''
    }
    if (avatarCleared && hadAvatar) {
      const { error } = await removeUserAvatar(profileId)
      return error ? `Profile saved, but the photo could not be removed: ${error}` : ''
    }
    return ''
  }

  /**
   * `silent` skips the spinner: the background refresh below re-reads the same
   * rows on a timer, and raising `loading` for that would blank the table under
   * an admin who is only reading it.
   */
  async function loadUsers(options?: { silent?: boolean }) {
    if (!options?.silent) setLoading(true)
    setFetchError('')
    const supabase = createClient()
    let { data, error } = await supabase
      .from('profiles')
      .select(`${USER_COLUMNS}, deactivated_at, contact_number`)
      .order('created_at', { ascending: false })

    // Retry without deactivated_at (095) / contact_number (104) if a migration
    // hasn't landed yet — USER_COLUMNS holds neither, so this survives the
    // deploy/migration race for both.
    //
    // The migrations workflow and the Vercel deploy both fire on the same push
    // and race, so there is a window where this build is live against the older
    // schema — and PostgREST rejects the ENTIRE select on one unknown column,
    // which would blank the whole page rather than lose one field. Same
    // fallback shape proxy.ts uses for admin_scope/024.
    //
    // Degrades safely: with no timestamp, accountStatus() reports 'inactive'
    // and never 'archived', which is exactly the pre-095 behaviour.
    if (error) {
      const fallback = await supabase
        .from('profiles')
        .select(USER_COLUMNS)
        .order('created_at', { ascending: false })
      if (!fallback.error) {
        data = fallback.data as typeof data
        error = null
      }
    }

    if (error) {
      setFetchError(error.message)
    } else {
      setUsers(
        (data ?? []).map(p => ({
          ...p,
          email: p.email ?? '',
          is_active: p.is_active ?? true,
          deactivated_at: p.deactivated_at ?? null,
          contact_number: p.contact_number ?? null,
          admin_scope: adminScope(p.role, p.admin_scope),
        }))
      )
    }
    setLoading(false)
  }

  async function loadTeams() {
    const supabase = createClient()
    const { data, error } = await supabase.from('teams').select('id, name, kind').order('name')
    if (error) console.error('Failed to load teams:', error.message)
    setTeams(data ?? [])
  }

  /**
   * Creates a team from inside the user form and selects it.
   *
   * The new row is spliced into local state rather than refetched: the admin is
   * mid-form, and a reload would race the select they are about to make. Sorted
   * on insert to match loadTeams' .order('name').
   */
  async function handleCreateTeam(name: string, kind: TeamKind): Promise<string> {
    const { error, team } = await createTeam(name, kind)
    if (error || !team) return error ?? 'Could not create the team.'

    const row: TeamRow = { id: team.id, name: team.name, kind: team.kind }
    setTeams(prev => [...prev, row].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    ))
    setForm(prev => ({ ...prev, team_id: row.id }))
    return ''
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers()
    loadTeams()
  }, [])

  // This page reads its rows inline rather than through use-profiles.ts (it
  // needs `deactivated_at` and the pre-095 fallback), so it wires the background
  // refresh up itself. Two admins managing accounts at once is the case it
  // covers: a deactivation done on one screen shows up on the other.
  useAutoRefresh(
    async () => {
      await loadUsers({ silent: true })
      await loadTeams()
    },
    { watch: [{ table: 'profiles' }, { table: 'teams' }] }
  )

  const teamName = (teamId: string | null) => teams.find(t => t.id === teamId)?.name ?? '—'

  const filtered = users.filter(u => {
    const matchSearch =
      u.full_name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
    // 'admin' matches every category; 'admin:sales' narrows to one of them.
    const matchRole =
      roleFilter === 'all' ||
      (roleFilter.startsWith('admin:')
        ? u.role === 'admin' && u.admin_scope === roleFilter.slice('admin:'.length)
        : u.role === roleFilter)
    const matchPlatform = platformFilter === 'all' || platformForRole(u.role) === platformFilter
    const status = accountStatus(u)
    const matchStatus =
      statusFilter === 'current' ? status !== 'archived' : status === statusFilter
    return matchSearch && matchRole && matchPlatform && matchStatus
  })

  function toggleSort(key: SortKey) {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: DEFAULT_SORT_DIR[key] }
    )
  }

  const sorted = [...filtered].sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1
    // Every column falls back to name so equal rows keep a stable, readable
    // order instead of shuffling between renders.
    const byName = a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })

    switch (sort.key) {
      case 'user':
        return dir * byName

      case 'role': {
        const rank = roleRank(a.role) - roleRank(b.role)
        if (rank) return dir * rank
        // Only admins differ on the second key — keeps Collection/Delivery/
        // Sales Admin grouped rather than interleaved by name.
        const scope = roleScopeLabel(a.role, a.admin_scope)
          .localeCompare(roleScopeLabel(b.role, b.admin_scope))
        return scope ? dir * scope : byName
      }

      case 'platform': {
        const platform = platformForRole(a.role).localeCompare(platformForRole(b.role))
        return platform ? dir * platform : byName
      }

      case 'team': {
        const at = teams.find(t => t.id === a.team_id)?.name ?? ''
        const bt = teams.find(t => t.id === b.team_id)?.name ?? ''
        // Unassigned sinks to the bottom in BOTH directions — most users here
        // have no team, and a screen of dashes is never what someone sorting
        // by team is looking for.
        if (!at || !bt) return at ? -1 : bt ? 1 : byName
        // numeric, so Team 10 follows Team 9 rather than Team 1.
        const team = at.localeCompare(bt, undefined, { numeric: true, sensitivity: 'base' })
        return team ? dir * team : byName
      }

      case 'created': {
        const created = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        return created ? dir * created : byName
      }

      case 'status': {
        // Active → Inactive → Archived when ascending.
        const status = STATUS_RANK[accountStatus(a)] - STATUS_RANK[accountStatus(b)]
        return status ? dir * status : byName
      }
    }
  })

  const { pageItems, page, pageCount, from, to, total, setPage } = usePagination(
    sorted, 10, `${search}|${roleFilter}|${platformFilter}|${statusFilter}|${sort.key}|${sort.dir}`,
  )

  const counts = {
    total: users.length,
    superadmin: users.filter(u => u.role === 'superadmin').length,
    admin: users.filter(u => u.role === 'admin').length,
    executive: users.filter(u => u.role === 'executive').length,
    sales_manager: users.filter(u => u.role === 'sales_manager').length,
    sales_specialist: users.filter(u => u.role === 'sales_specialist').length,
    rsr: users.filter(u => u.role === 'rsr').length,
    collector: users.filter(u => u.role === 'collector').length,
    delivery: users.filter(u => u.role === 'delivery').length,
    active: users.filter(u => u.is_active).length,
    archived: users.filter(u => accountStatus(u) === 'archived').length,
  }

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError('')
    setShowPassword(false)
    resetAvatar(null)
    setCreateOpen(true)
  }

  function openEdit(user: UserRow) {
    setForm({
      full_name: user.full_name,
      email: user.email,
      password: '',
      role: user.role,
      admin_scope: user.admin_scope,
      team_id: user.team_id ?? '',
      contact_number: user.contact_number ?? '',
    } satisfies UserFormData)
    setFormError('')
    setShowPassword(false)
    resetAvatar(user.avatar_url)
    setEditTarget(user)
  }

  function validateForm(isCreate: boolean): string {
    if (!form.full_name.trim()) return 'Full name is required.'
    if (!form.email.trim()) return 'Email is required.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address.'
    if (isCreate && !form.password) return 'Password is required.'
    if (isCreate && form.password.length < PASSWORD_MIN_LENGTH) {
      return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
    }
    // Required for managers only. A manager's team is the sole record of which
    // kind they run — the role has covered both since migration 010 folded
    // rsr_manager into sales_manager — so a teamless manager cannot be scoped,
    // and from migration 076 cannot be given a visit limit either. Specialists
    // and RSRs stay optional so that opening an existing teamless agent's row to
    // change something unrelated doesn't block on a field the admin didn't come
    // here to fill.
    if (form.role === 'sales_manager' && !form.team_id) {
      return 'A manager must be assigned to a team. Pick one, or create it here.'
    }
    // Required only for the roles the app sends SMS to (collector, delivery);
    // the server re-checks and also validates the format. Optional here for
    // everyone else, so editing an office account doesn't block on a number
    // that role never needed.
    if (phoneRequiredForRole(form.role) && !form.contact_number.trim()) {
      return 'A mobile number is required for collectors and delivery staff.'
    }
    return ''
  }

  async function handleCreate() {
    const err = validateForm(true)
    if (err) { setFormError(err); return }
    setSaving(true)
    const { error, profileId } = await createUser({
      full_name: form.full_name.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      role: form.role,
      admin_scope: form.admin_scope,
      team_id: form.team_id || null,
      contact_number: form.contact_number.trim() || null,
    })
    if (error) { setSaving(false); setFormError(error); return }

    const avatarError = profileId ? await syncAvatar(profileId, false) : ''
    setSaving(false)
    setCreateOpen(false)
    await loadUsers()
    // After loadUsers — it clears fetchError on entry.
    if (avatarError) setFetchError(avatarError)
  }

  async function handleEdit() {
    if (!editTarget) return
    const err = validateForm(false)
    if (err) { setFormError(err); return }
    setSaving(true)
    const { error } = await updateUser(editTarget.id, {
      full_name: form.full_name.trim(),
      email: form.email.trim().toLowerCase(),
      role: form.role,
      admin_scope: form.admin_scope,
      team_id: form.team_id || null,
      contact_number: form.contact_number.trim() || null,
    })
    if (error) { setSaving(false); setFormError(error); return }

    const avatarError = await syncAvatar(editTarget.id, !!editTarget.avatar_url)
    setSaving(false)
    setEditTarget(null)
    await loadUsers()
    // After loadUsers — it clears fetchError on entry.
    if (avatarError) setFetchError(avatarError)
  }

  function openDeactivate(user: UserRow) {
    setDeactivateError('')
    setDeactivateTarget(user)
  }

  /**
   * Deactivation now ends the target's session on both web and mobile, so it
   * gets a confirm step and its errors are shown. The server refuses two cases
   * outright — deactivating yourself, and the last active superadmin — and the
   * dialog is where those messages have to land, since the row itself gives no
   * hint that either rule exists.
   */
  async function handleDeactivate() {
    if (!deactivateTarget) return
    setDeactivating(true)
    const { error } = await toggleUserStatus(deactivateTarget.id, false)
    setDeactivating(false)
    if (error) {
      setDeactivateError(error)
      return
    }
    setDeactivateTarget(null)
    await loadUsers()
  }

  /** Restoring access is not destructive, so it skips the confirm step. */
  async function handleReactivate(user: UserRow) {
    const { error } = await toggleUserStatus(user.id, true)
    // Before loadUsers, which clears fetchError on entry.
    if (error) {
      setFetchError(error)
      return
    }
    await loadUsers()
  }

  function openReset(user: UserRow) {
    // Pre-filled with the default so the usual "they forgot it" case is one
    // click, and visible by default so the admin can read it out as-is.
    setResetPassword(DEFAULT_PASSWORD)
    setResetConfirm(DEFAULT_PASSWORD)
    setShowResetPassword(true)
    setResetError('')
    setNotice('')
    setResetTarget(user)
  }

  async function handleReset() {
    if (!resetTarget) return
    if (resetPassword.length < PASSWORD_MIN_LENGTH) {
      setResetError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
      return
    }
    // The admin reads this out to the agent, so a typo here locks them out of
    // an account that reports itself as reset. Confirm before sending.
    if (resetPassword !== resetConfirm) {
      setResetError('The two passwords do not match.')
      return
    }

    setSaving(true)
    const { error } = await resetUserPassword(resetTarget.id, resetPassword)
    setSaving(false)
    if (error) { setResetError(error); return }

    setNotice(`Password updated for ${resetTarget.full_name}. Give it to them directly — they will not receive an email.`)
    setResetTarget(null)
  }

  return (
    <div className="flex flex-col flex-1">
      {/* Archived is only named once there is one — the usual case shouldn't
          carry a "0 archived" that explains nothing. */}
      <Header
        title="User Management"
        subtitle={
          counts.archived
            ? `${counts.active} active · ${counts.archived} archived · ${counts.total} total users`
            : `${counts.active} active · ${counts.total} total users`
        }
      />

      <div className="flex-1 p-6 space-y-6">

        {fetchError && (
          <Alert variant="destructive">
            <AlertDescription>{fetchError}</AlertDescription>
          </Alert>
        )}

        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {/* Stats */}
        {/* Nine tiles, so the breakpoints step 2 → 3 → 9 rather than 2 → 4 → 8:
            every row divides evenly and no tile is orphaned on a row of its own. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-3">
          {([
            { label: 'Total Users', value: counts.total, icon: Users, color: 'text-foreground' },
            { label: 'Super Admins', value: counts.superadmin, icon: ShieldEllipsis, color: 'text-primary' },
            { label: 'Admins', value: counts.admin, icon: ShieldCheck, color: 'text-primary' },
            { label: 'Executives', value: counts.executive, icon: LineChart, color: TONE_TEXT[ROLE_TONE.executive] },
            { label: 'Sales Managers', value: counts.sales_manager, icon: Briefcase, color: TONE_TEXT[ROLE_TONE.sales_manager] },
            { label: 'Sales Specialists', value: counts.sales_specialist, icon: User, color: TONE_TEXT[ROLE_TONE.sales_specialist] },
            { label: 'RSR', value: counts.rsr, icon: Store, color: TONE_TEXT[ROLE_TONE.rsr] },
            { label: 'Collectors', value: counts.collector, icon: Wallet, color: TONE_TEXT[ROLE_TONE.collector] },
            { label: 'Delivery', value: counts.delivery, icon: Truck, color: TONE_TEXT[ROLE_TONE.delivery] },
          ] as const).map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="bg-card border-border last:col-span-2 sm:last:col-span-1">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Icon className={`w-4 h-4 ${color}`} />
                </div>
                <div>
                  <p className={`text-xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-card border-border h-9"
            />
          </div>
          <Select value={roleFilter} onValueChange={v => setRoleFilter(v ?? 'all')}>
            <SelectTrigger className="w-44 h-9 bg-card border-border">
              <SelectValue placeholder="All Roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Roles</SelectItem>
              <SelectItem value="superadmin">Super Admin</SelectItem>
              <SelectItem value="admin">All Admins</SelectItem>
              {ADMIN_SCOPES.filter(scope => scope !== 'all').map(scope => (
                <SelectItem key={scope} value={`admin:${scope}`}>
                  {ADMIN_SCOPE_LABEL[scope]}
                </SelectItem>
              ))}
              <SelectItem value="executive">Executive</SelectItem>
              <SelectItem value="sales_manager">Sales Manager</SelectItem>
              <SelectItem value="sales_specialist">Sales Specialist</SelectItem>
              <SelectItem value="rsr">RSR</SelectItem>
              <SelectItem value="collector">Collector</SelectItem>
              <SelectItem value="delivery">Delivery</SelectItem>
            </SelectContent>
          </Select>
          <Select value={platformFilter} onValueChange={v => setPlatformFilter(v ?? 'all')}>
            <SelectTrigger className="w-40 h-9 bg-card border-border">
              <SelectValue placeholder="All Platforms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Platforms</SelectItem>
              <SelectItem value="web">Web</SelectItem>
              <SelectItem value="mobile">Mobile App</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={v => setStatusFilter((v as StatusFilter) ?? 'current')}>
            <SelectTrigger className="w-48 h-9 bg-card border-border">
              <SelectValue placeholder="Active & Inactive" />
            </SelectTrigger>
            <SelectContent>
              {(['current', 'active', 'inactive', 'archived'] as StatusFilter[]).map(value => (
                <SelectItem key={value} value={value}>
                  {STATUS_FILTER_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Wrapped, not passed directly: loadUsers now takes options, and the
              click event would arrive as one. */}
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => loadUsers()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {canManage && (
            <Button onClick={openCreate} size="sm" className="h-9 gap-2">
              <UserPlus className="w-4 h-4" />
              Create User
            </Button>
          )}
        </div>

        {/* Table */}
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <SortHeader label="User" sortKey="user" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Role" sortKey="role" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Platform" sortKey="platform" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Team" sortKey="team" sort={sort} onSort={toggleSort} className="hidden md:table-cell" />
                    <SortHeader label="Created" sortKey="created" sort={sort} onSort={toggleSort} className="hidden lg:table-cell" />
                    <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-muted" />
                            <div className="space-y-1.5">
                              <div className="h-3 w-32 bg-muted rounded" />
                              <div className="h-2.5 w-24 bg-muted rounded" />
                            </div>
                          </div>
                        </td>
                        {[...Array(5)].map((_, j) => (
                          <td key={j} className="px-5 py-3">
                            <div className="h-3 w-16 bg-muted rounded" />
                          </td>
                        ))}
                        <td className="px-5 py-3" />
                      </tr>
                    ))
                  ) : pageItems.map(user => {
                    // Falls back for roles added to the DB by the mobile repo that
                    // this build has no icon for — an undefined element type here
                    // takes the whole page down. See roleLabel in lib/permissions.
                    const RoleIcon =
                      user.role === 'admin'
                        ? ADMIN_SCOPE_ICON[user.admin_scope]
                        : ROLE_ICON[user.role] ?? CircleHelp
                    const platform = PLATFORM_META[platformForRole(user.role)]
                    const status = accountStatus(user)
                    return (
                      <tr key={user.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <Avatar className="shrink-0">
                              {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} />}
                              <AvatarFallback className="bg-primary/20 text-xs font-bold text-primary">
                                {user.full_name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-foreground leading-tight">{user.full_name}</p>
                              <p className="text-xs text-muted-foreground">{user.email || '—'}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant="tone" className={`gap-1 ${TONE_CLASS[roleTone(user.role)]}`}>
                            <RoleIcon className="w-3 h-3" />
                            {roleScopeLabel(user.role, user.admin_scope)}
                          </Badge>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant="outline" className={`text-[11px] px-2 h-5 gap-1 ${platform.style}`}>
                            <platform.icon className="w-3 h-3" />
                            {platform.label}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 hidden md:table-cell">
                          <span className="text-xs text-muted-foreground">{teamName(user.team_id)}</span>
                        </td>
                        <td className="px-5 py-3 hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {new Date(user.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant="tone" className={TONE_CLASS[STATUS_TONE[status]]}>
                            {ACCOUNT_STATUS_LABEL[status]}
                          </Badge>
                          {/* The date the archive clock started — without it,
                              "Inactive" gives no sense of how close this account
                              is to dropping off the list. */}
                          {status !== 'active' && (
                            <p className="text-[11px] text-muted-foreground mt-1">
                              {deactivatedSinceLabel(user)}
                            </p>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {(() => {
                            const locked = !canManage
                            return (
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-accent transition-colors disabled:opacity-40"
                                  disabled={locked}
                                >
                                  <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => openEdit(user)} className="gap-2">
                                    <Pencil className="w-3.5 h-3.5" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => openReset(user)} className="gap-2">
                                    <KeyRound className="w-3.5 h-3.5" />
                                    Reset Password
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => user.is_active ? openDeactivate(user) : handleReactivate(user)}
                                    className={`gap-2 ${user.is_active ? 'text-destructive focus:text-destructive' : ''}`}
                                  >
                                    {user.is_active
                                      ? <Ban className="w-3.5 h-3.5" />
                                      : <UserCheck className="w-3.5 h-3.5" />}
                                    {user.is_active ? 'Deactivate' : 'Reactivate'}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )
                          })()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {!loading && filtered.length === 0 && (
                <div className="text-center py-16 text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No users found</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {!loading && (
          <Pagination
            page={page} pageCount={pageCount} onPageChange={setPage}
            from={from} to={to} total={total} itemLabel="users"
          />
        )}
      </div>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={open => { if (!saving) setCreateOpen(open) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
          </DialogHeader>
          <UserForm form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} isCreate teams={teams} users={users} canCreateAdmins={canManage}
            editingUserId={null} onCreateTeam={handleCreateTeam}
            avatarPreview={avatarPreview} onAvatarPick={handleAvatarPick} onAvatarClear={handleAvatarClear} />
          {formError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={!!editTarget} onOpenChange={open => { if (!saving && !open) setEditTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <UserForm form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} isCreate={false} teams={teams} users={users} canCreateAdmins={canManage}
            editingUserId={editTarget?.id ?? null} onCreateTeam={handleCreateTeam}
            avatarPreview={avatarPreview} onAvatarPick={handleAvatarPick} onAvatarClear={handleAvatarClear} />
          {formError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={saving}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!resetTarget} onOpenChange={open => { if (!saving && !open) setResetTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sets a new password for{' '}
              <span className="font-medium text-foreground">{resetTarget?.full_name}</span>{' '}
              ({resetTarget?.email}). They are not notified — pass it on directly.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="reset-password">New Password</Label>
              <div className="relative">
                <Input
                  id="reset-password"
                  type={showResetPassword ? 'text' : 'password'}
                  placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`}
                  value={resetPassword}
                  onChange={e => { setResetPassword(e.target.value); setResetError('') }}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowResetPassword(!showResetPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showResetPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {resetPassword === DEFAULT_PASSWORD && (
                <p className="text-xs text-muted-foreground">
                  This is the shared default. Type a different one for admin accounts.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-confirm">Confirm Password</Label>
              <Input
                id="reset-confirm"
                type={showResetPassword ? 'text' : 'password'}
                placeholder="Re-enter the password"
                value={resetConfirm}
                onChange={e => { setResetConfirm(e.target.value); setResetError('') }}
              />
            </div>
          </div>

          {resetError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{resetError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={saving}>Cancel</Button>
            <Button onClick={handleReset} disabled={saving}>
              {saving ? 'Resetting…' : 'Reset Password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate Confirmation */}
      <Dialog
        open={!!deactivateTarget}
        onOpenChange={open => { if (!deactivating && !open) setDeactivateTarget(null) }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Deactivate account</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{deactivateTarget?.full_name}</span>{' '}
              ({deactivateTarget?.email}) will be signed out and blocked from both the web
              dashboard and the mobile app.
            </p>
            <p className="text-sm text-muted-foreground">
              Their clients, meetings and records are untouched, and you can reactivate them at
              any time. After {ARCHIVE_AFTER_DAYS} days the account moves to the Archived filter
              and drops off this list.
            </p>
          </div>

          {deactivateError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{deactivateError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeactivateTarget(null)}
              disabled={deactivating}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeactivate} disabled={deactivating}>
              {deactivating ? 'Deactivating…' : 'Deactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * A clickable column header. Carries a faint neutral arrow when idle so the
 * column reads as sortable before anyone hovers it, and a solid directional
 * arrow once it is the active sort.
 */
function SortHeader({
  label, sortKey, sort, onSort, className,
}: {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sort.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown

  return (
    <th
      className={`text-left px-5 py-3 font-medium ${className ?? ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1.5 transition-colors hover:text-foreground ${
          active ? 'text-foreground' : ''
        }`}
      >
        {label}
        <Icon className={`w-3.5 h-3.5 ${active ? '' : 'opacity-40'}`} />
      </button>
    </th>
  )
}

interface UserFormProps {
  form: UserFormData
  setForm: React.Dispatch<React.SetStateAction<UserFormData>>
  showPassword: boolean
  setShowPassword: (v: boolean) => void
  isCreate: boolean
  teams: TeamRow[]
  users: UserRow[]
  canCreateAdmins: boolean
  /** Null while creating. Lets the takeover warning ignore the user's own team. */
  editingUserId: string | null
  /** Resolves to an error message, or '' on success. */
  onCreateTeam: (name: string, kind: TeamKind) => Promise<string>
  avatarPreview: string | null
  onAvatarPick: (file: File) => void
  onAvatarClear: () => void
}

/** Sentinel for the picker's "+ New team…" row, which is not a team id. */
const NEW_TEAM = '__new__'

function UserForm({
  form, setForm, showPassword, setShowPassword, isCreate, teams, users, canCreateAdmins,
  editingUserId, onCreateTeam,
  avatarPreview, onAvatarPick, onAvatarClear,
}: UserFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  // The inline create-a-team panel. Local to the form: nothing outside it needs
  // to know a team is half-typed, and closing the dialog should discard it.
  const [newTeamOpen, setNewTeamOpen] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [newTeamKind, setNewTeamKind] = useState<TeamKind>('sales')
  const [newTeamError, setNewTeamError] = useState('')
  const [creatingTeam, setCreatingTeam] = useState(false)

  function set(field: keyof UserFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const availableTeams = teamsForRole(form.role, teams)

  function setRole(role: UserRole) {
    const validIds = teamsForRole(role, teams).map(t => t.id)
    setForm(prev => ({
      ...prev,
      role,
      // Only admins carry a category; anything else must go back to 'all' or
      // the DB's profiles_admin_scope_role_check rejects the row.
      admin_scope: role === 'admin' ? prev.admin_scope : 'all',
      team_id: validIds.includes(prev.team_id) ? prev.team_id : '',
    }))
    // A half-typed team belongs to the role that was on screen when it started.
    closeNewTeam()
  }

  function closeNewTeam() {
    setNewTeamOpen(false)
    setNewTeamName('')
    setNewTeamError('')
  }

  function openNewTeam() {
    // A specialist or RSR can only ever be in a team of their own kind, so the
    // choice is theirs to make only when the role permits both — a manager.
    setNewTeamKind(teamKindForRole(form.role) ?? 'sales')
    setNewTeamName('')
    setNewTeamError('')
    setNewTeamOpen(true)
  }

  async function submitNewTeam() {
    setCreatingTeam(true)
    const error = await onCreateTeam(newTeamName, newTeamKind)
    setCreatingTeam(false)
    if (error) { setNewTeamError(error); return }
    // The parent selected it for us; this just puts the panel away.
    closeNewTeam()
  }

  const managers = users.filter(u => u.role === 'sales_manager')

  function managerNameForTeam(teamId: string): string | undefined {
    return managerForTeam(teamId, managers)?.full_name
  }

  const selectedTeamManager = form.team_id ? managerNameForTeam(form.team_id) : undefined

  const teamRequired = form.role === 'sales_manager'

  /**
   * The manager this save would displace.
   *
   * A team has one manager, so assigning a second is a handover — and because a
   * manager now requires a team, the outgoing one is left without one rather
   * than quietly sharing. That is worth saying out loud before the click, not
   * discovering afterwards in the list. Excludes the user being edited, who is
   * not taking over from themselves.
   */
  const displacedManager = (() => {
    if (!teamRequired || !form.team_id) return undefined
    const current = managerForTeam(form.team_id, managers)
    if (!current || current.id === editingUserId) return undefined
    return current
  })()

  return (
    <div className="space-y-4 py-2">
      {/* Profile photo — mobile users can set their own from the app, but an
          admin can supply one here so field agents show a face on map pins. */}
      <div className="flex items-center gap-4">
        <Avatar className="size-16 shrink-0">
          {avatarPreview && <AvatarImage src={avatarPreview} alt="" />}
          <AvatarFallback className="bg-primary/20 text-lg font-bold text-primary">
            {form.full_name.trim().charAt(0).toUpperCase() || '?'}
          </AvatarFallback>
        </Avatar>
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="w-3.5 h-3.5" />
              {avatarPreview ? 'Change photo' : 'Upload photo'}
            </Button>
            {avatarPreview && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-destructive hover:text-destructive"
                onClick={onAvatarClear}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">JPG, PNG or WebP — cropped square, max 5 MB.</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={AVATAR_ACCEPT_ATTR}
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            // Reset so re-picking the same file still fires a change event.
            e.target.value = ''
            if (file) onAvatarPick(file)
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="full_name">Full Name</Label>
        <Input
          id="full_name"
          placeholder="e.g. Juan dela Cruz"
          value={form.full_name}
          onChange={e => set('full_name', e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email Address</Label>
        <Input
          id="email"
          type="email"
          placeholder="user@oracle.com"
          value={form.email}
          onChange={e => set('email', e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="contact_number">
          Mobile Number
          {phoneRequiredForRole(form.role)
            ? <span className="ml-1 text-destructive">*</span>
            : <span className="ml-1 text-muted-foreground font-normal">(optional)</span>}
        </Label>
        <Input
          id="contact_number"
          type="tel"
          inputMode="tel"
          placeholder="e.g. 0917 123 4567"
          value={form.contact_number}
          onChange={e => set('contact_number', e.target.value)}
        />
        {phoneRequiredForRole(form.role) && (
          <p className="text-xs text-muted-foreground">
            Collectors and delivery staff receive SMS notifications on this number.
          </p>
        )}
      </div>

      {isCreate && (
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Min. 8 characters"
              value={form.password}
              onChange={e => set('password', e.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>Role</Label>
        <Select value={form.role} onValueChange={v => setRole((v as UserRole | null) ?? 'sales_specialist')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {canCreateAdmins && <SelectItem value="superadmin">Super Admin</SelectItem>}
            {canCreateAdmins && <SelectItem value="admin">Admin</SelectItem>}
            {/* Ungated, unlike the two above: an executive is a mobile account
                with no administrative power, so it isn't an admin to mint. */}
            <SelectItem value="executive">Executive</SelectItem>
            <SelectItem value="sales_manager">Sales Manager</SelectItem>
            <SelectItem value="sales_specialist">Sales Specialist</SelectItem>
            <SelectItem value="rsr">RSR</SelectItem>
            <SelectItem value="collector">Collector</SelectItem>
            <SelectItem value="delivery">Delivery</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTION[form.role]}</p>
        {(() => {
          const platform = PLATFORM_META[platformForRole(form.role)]
          return (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <platform.icon className="w-3 h-3" />
              Signs in via: <span className="text-foreground font-medium">{platform.label}</span>
            </p>
          )
        })()}
      </div>

      {/* Admin category (migration 024). Hidden for every other role — scope is
          meaningless there and the DB constraint forbids narrowing it. */}
      {form.role === 'admin' && (
        <div className="space-y-1.5">
          <Label>Admin Category</Label>
          <Select
            value={form.admin_scope}
            onValueChange={v => set('admin_scope', (v as AdminScope | null) ?? 'all')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADMIN_SCOPES.map(scope => (
                <SelectItem key={scope} value={scope}>
                  {scope === 'all' ? 'Admin (all modules)' : ADMIN_SCOPE_LABEL[scope]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {ADMIN_SCOPE_DESCRIPTION[form.admin_scope]}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>
          Team{' '}
          <span className="text-muted-foreground">
            {teamRequired ? '(required)' : '(optional)'}
          </span>
        </Label>
        <Select
          value={form.team_id || 'none'}
          onValueChange={v => {
            if (v === NEW_TEAM) { openNewTeam(); return }
            closeNewTeam()
            set('team_id', v === 'none' ? '' : (v ?? ''))
          }}
          disabled={!roleHasTeam(form.role)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={roleHasTeam(form.role) ? 'No team' : 'This role has no teams'} />
          </SelectTrigger>
          <SelectContent className="min-w-[280px]">
            {/* A manager must land on a real team, so "No team" is not offered
                to them — leaving it selectable would only produce a save error
                further down the form. */}
            {!teamRequired && <SelectItem value="none">No team</SelectItem>}
            {availableTeams.map(t => {
              const manager = managerNameForTeam(t.id)
              return (
                <SelectItem key={t.id} value={t.id}>
                  {/* The kind is shown only to managers: for a specialist or an
                      RSR every option is their own kind already, so the label
                      would repeat on every row and distinguish nothing. */}
                  {teamRequired ? `${t.name} · ${TEAM_KIND_LABEL[t.kind]} — ` : `${t.name} — `}
                  {manager ?? 'No manager assigned'}
                </SelectItem>
              )
            })}
            <SelectItem value={NEW_TEAM}>+ New team…</SelectItem>
          </SelectContent>
        </Select>

        {newTeamOpen && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
            <Label htmlFor="new-team-name" className="text-xs">New team</Label>
            <Input
              id="new-team-name"
              value={newTeamName}
              onChange={e => setNewTeamName(e.target.value)}
              placeholder="e.g. Sales Team 3"
              maxLength={60}
              autoFocus
            />
            {/* Only a manager gets the choice — see openNewTeam. */}
            {teamKindForRole(form.role) === null ? (
              <Select value={newTeamKind} onValueChange={v => setNewTeamKind(v as TeamKind)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sales">Sales team</SelectItem>
                  <SelectItem value="rsr">RSR team</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground">
                Created as a {TEAM_KIND_LABEL[newTeamKind]} team, matching this role.
              </p>
            )}
            {newTeamError && (
              <Alert variant="destructive" className="py-2">
                <AlertDescription className="text-xs">{newTeamError}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closeNewTeam} disabled={creatingTeam}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={submitNewTeam}
                disabled={creatingTeam || !newTeamName.trim()}
              >
                {creatingTeam ? 'Creating…' : 'Create team'}
              </Button>
            </div>
          </div>
        )}

        {displacedManager ? (
          <Alert className="py-2">
            <AlertDescription className="text-xs">
              <span className="text-foreground font-medium">{displacedManager.full_name}</span>{' '}
              currently manages this team. Saving hands it over, and leaves them without a
              team until you assign one.
            </AlertDescription>
          </Alert>
        ) : form.team_id && !teamRequired ? (
          <p className="text-xs text-muted-foreground">
            {selectedTeamManager
              ? <>Managed by <span className="text-foreground font-medium">{selectedTeamManager}</span></>
              : 'No manager is currently assigned to this team.'}
          </p>
        ) : null}
      </div>
    </div>
  )
}
