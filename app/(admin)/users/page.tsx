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
import {
  Search, UserPlus, Users, ShieldCheck, ShieldEllipsis, Briefcase, User,
  MoreHorizontal, Pencil, Ban, Eye, EyeOff, Store, Wallet, RefreshCw,
  Monitor, Smartphone, Truck, CircleHelp, ImagePlus, Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { createUser, updateUser, toggleUserStatus, uploadUserAvatar, removeUserAvatar } from './actions'
import {
  AVATAR_ACCEPT_ATTR, AVATAR_ACCEPTED_TYPES, AVATAR_MAX_SOURCE_BYTES, resizeAvatar,
} from '@/lib/avatar'
import {
  ADMIN_SCOPES, ADMIN_SCOPE_DESCRIPTION, ADMIN_SCOPE_LABEL, adminScope,
  canManageUsers, platformForRole, roleScopeLabel,
} from '@/lib/permissions'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { teamIdsForRole } from '@/lib/teams'
import type { AdminScope, UserRole } from '@/types'
import { PLATFORM_TONE, ROLE_TONE, TONE_CLASS, TONE_TEXT, roleTone } from '@/lib/status-styles'

const ROLE_ICON: Record<UserRole, React.ElementType> = {
  superadmin: ShieldEllipsis,
  admin: ShieldCheck,
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
  sales_manager: 'Oversees a team of sales specialists or RSRs, approves client changes, and views all team sales.',
  sales_specialist: 'Front-line sales agent that logs meetings, clients, and clock records.',
  rsr: 'Route Sales Representative — visits stores daily and logs field activity.',
  collector: 'Handles payment collection from assigned stores with cash/check proof.',
  delivery: 'Delivers purchase orders and captures receiver name plus a proof photo — no GPS, per confirmed scope.',
}

interface TeamRow {
  id: string
  name: string
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
  avatar_url: string | null
  created_at: string
}

interface UserFormData {
  full_name: string
  email: string
  password: string
  role: UserRole
  admin_scope: AdminScope
  team_id: string
}

const EMPTY_FORM: UserFormData = {
  full_name: '',
  email: '',
  password: '',
  role: 'sales_specialist',
  admin_scope: 'all',
  team_id: '',
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
  const [teams, setTeams] = useState<TeamRow[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<UserRow | null>(null)
  const [form, setForm] = useState<UserFormData>(EMPTY_FORM)
  const [showPassword, setShowPassword] = useState(false)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

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

  async function loadUsers() {
    setLoading(true)
    setFetchError('')
    const supabase = createClient()
    const { data, error } = await supabase
      .from('profiles')
      .select('id, user_id, full_name, email, role, admin_scope, team_id, is_active, avatar_url, created_at')
      .order('created_at', { ascending: false })

    if (error) {
      setFetchError(error.message)
    } else {
      setUsers(
        (data ?? []).map(p => ({
          ...p,
          email: p.email ?? '',
          is_active: p.is_active ?? true,
          admin_scope: adminScope(p.role, p.admin_scope),
        }))
      )
    }
    setLoading(false)
  }

  async function loadTeams() {
    const supabase = createClient()
    const { data, error } = await supabase.from('teams').select('id, name').order('name')
    if (error) console.error('Failed to load teams:', error.message)
    setTeams(data ?? [])
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers()
    loadTeams()
  }, [])

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
    return matchSearch && matchRole && matchPlatform
  })

  const counts = {
    total: users.length,
    superadmin: users.filter(u => u.role === 'superadmin').length,
    admin: users.filter(u => u.role === 'admin').length,
    sales_manager: users.filter(u => u.role === 'sales_manager').length,
    sales_specialist: users.filter(u => u.role === 'sales_specialist').length,
    rsr: users.filter(u => u.role === 'rsr').length,
    collector: users.filter(u => u.role === 'collector').length,
    delivery: users.filter(u => u.role === 'delivery').length,
    active: users.filter(u => u.is_active).length,
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
    if (isCreate && form.password.length < 8) return 'Password must be at least 8 characters.'
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
    })
    if (error) { setSaving(false); setFormError(error); return }

    const avatarError = await syncAvatar(editTarget.id, !!editTarget.avatar_url)
    setSaving(false)
    setEditTarget(null)
    await loadUsers()
    // After loadUsers — it clears fetchError on entry.
    if (avatarError) setFetchError(avatarError)
  }

  async function handleToggleStatus(user: UserRow) {
    const { error } = await toggleUserStatus(user.id, !user.is_active)
    if (!error) loadUsers()
  }

  return (
    <div className="flex flex-col flex-1">
      <Header title="User Management" subtitle={`${counts.active} active · ${counts.total} total users`} />

      <div className="flex-1 p-6 space-y-6">

        {fetchError && (
          <Alert variant="destructive">
            <AlertDescription>{fetchError}</AlertDescription>
          </Alert>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          {([
            { label: 'Total Users', value: counts.total, icon: Users, color: 'text-foreground' },
            { label: 'Super Admins', value: counts.superadmin, icon: ShieldEllipsis, color: 'text-primary' },
            { label: 'Admins', value: counts.admin, icon: ShieldCheck, color: 'text-primary' },
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
              <SelectItem value="admin">Admins — any category</SelectItem>
              {ADMIN_SCOPES.map(scope => (
                <SelectItem key={scope} value={`admin:${scope}`}>
                  {scope === 'all' ? 'Admin (all modules)' : ADMIN_SCOPE_LABEL[scope]}
                </SelectItem>
              ))}
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
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={loadUsers} disabled={loading}>
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
                    <th className="text-left px-5 py-3 font-medium">User</th>
                    <th className="text-left px-5 py-3 font-medium">Role</th>
                    <th className="text-left px-5 py-3 font-medium">Platform</th>
                    <th className="text-left px-5 py-3 font-medium hidden md:table-cell">Team</th>
                    <th className="text-left px-5 py-3 font-medium hidden lg:table-cell">Created</th>
                    <th className="text-left px-5 py-3 font-medium">Status</th>
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
                  ) : filtered.map(user => {
                    // Falls back for roles added to the DB by the mobile repo that
                    // this build has no icon for — an undefined element type here
                    // takes the whole page down. See roleLabel in lib/permissions.
                    const RoleIcon =
                      user.role === 'admin'
                        ? ADMIN_SCOPE_ICON[user.admin_scope]
                        : ROLE_ICON[user.role] ?? CircleHelp
                    const platform = PLATFORM_META[platformForRole(user.role)]
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
                          <Badge
                            variant="tone"
                            className={TONE_CLASS[user.is_active ? 'brand' : 'neutral']}
                          >
                            {user.is_active ? 'Active' : 'Inactive'}
                          </Badge>
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
                                  <DropdownMenuItem
                                    onClick={() => handleToggleStatus(user)}
                                    className={`gap-2 ${user.is_active ? 'text-destructive focus:text-destructive' : ''}`}
                                  >
                                    <Ban className="w-3.5 h-3.5" />
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
      </div>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={open => { if (!saving) setCreateOpen(open) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
          </DialogHeader>
          <UserForm form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} isCreate teams={teams} canCreateAdmins={canManage}
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
          <UserForm form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} isCreate={false} teams={teams} canCreateAdmins={canManage}
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
    </div>
  )
}

interface UserFormProps {
  form: UserFormData
  setForm: React.Dispatch<React.SetStateAction<UserFormData>>
  showPassword: boolean
  setShowPassword: (v: boolean) => void
  isCreate: boolean
  teams: TeamRow[]
  canCreateAdmins: boolean
  avatarPreview: string | null
  onAvatarPick: (file: File) => void
  onAvatarClear: () => void
}

function UserForm({
  form, setForm, showPassword, setShowPassword, isCreate, teams, canCreateAdmins,
  avatarPreview, onAvatarPick, onAvatarClear,
}: UserFormProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function set(field: keyof UserFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function setRole(role: UserRole) {
    const validTeamIds = teamIdsForRole(role)
    setForm(prev => ({
      ...prev,
      role,
      // Only admins carry a category; anything else must go back to 'all' or
      // the DB's profiles_admin_scope_role_check rejects the row.
      admin_scope: role === 'admin' ? prev.admin_scope : 'all',
      team_id: validTeamIds.includes(prev.team_id) ? prev.team_id : '',
    }))
  }

  const availableTeams = teams.filter(t => teamIdsForRole(form.role).includes(t.id))

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
        <Label>Team <span className="text-muted-foreground">(optional)</span></Label>
        <Select
          value={form.team_id || 'none'}
          onValueChange={v => set('team_id', v === 'none' ? '' : (v ?? ''))}
          disabled={availableTeams.length === 0}
        >
          <SelectTrigger>
            <SelectValue placeholder={availableTeams.length === 0 ? 'This role has no teams' : 'No team'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No team</SelectItem>
            {availableTeams.map(t => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
