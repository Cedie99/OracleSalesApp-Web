'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Search, UserPlus, Users, ShieldCheck, Briefcase, User,
  MoreHorizontal, Pencil, Ban, Eye, EyeOff, Store, Wallet, RefreshCw,
} from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { createUser, updateUser, toggleUserStatus } from './actions'
import type { UserRole } from '@/types'

const ROLE_STYLE: Record<UserRole, string> = {
  admin: 'bg-primary/15 text-primary border-primary/30',
  sales_manager: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  sales_specialist: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  rsr: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  collector: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  sales_specialist: 'Sales Specialist',
  rsr: 'RSR',
  collector: 'Collector',
}

const ROLE_ICON: Record<UserRole, React.ElementType> = {
  admin: ShieldCheck,
  sales_manager: Briefcase,
  sales_specialist: User,
  rsr: Store,
  collector: Wallet,
}

const ROLE_DESCRIPTION: Record<UserRole, string> = {
  admin: 'Full system access — can manage users, clients, and all data.',
  sales_manager: 'Oversees a team, approves client changes, and views all team sales.',
  sales_specialist: 'Front-line sales agent that logs meetings, clients, and clock records.',
  rsr: 'Route Sales Representative — visits stores daily and logs field activity.',
  collector: 'Handles payment collection from assigned stores with cash/check proof.',
}

interface UserRow {
  id: string
  user_id: string
  full_name: string
  email: string
  role: UserRole
  team_id: string | null
  is_active: boolean
  created_at: string
}

interface UserFormData {
  full_name: string
  email: string
  password: string
  role: UserRole
  team_id: string
}

const EMPTY_FORM: UserFormData = {
  full_name: '',
  email: '',
  password: '',
  role: 'sales_specialist',
  team_id: '',
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')

  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<UserRow | null>(null)
  const [form, setForm] = useState<UserFormData>(EMPTY_FORM)
  const [showPassword, setShowPassword] = useState(false)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setFetchError('')
    const supabase = createClient()
    const { data, error } = await supabase
      .from('profiles')
      .select('id, user_id, full_name, email, role, team_id, is_active, created_at')
      .order('created_at', { ascending: false })

    if (error) {
      setFetchError(error.message)
    } else {
      setUsers(
        (data ?? []).map(p => ({
          ...p,
          email: p.email ?? '',
          is_active: p.is_active ?? true,
        }))
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  const filtered = users.filter(u => {
    const matchSearch =
      u.full_name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
    const matchRole = roleFilter === 'all' || u.role === roleFilter
    return matchSearch && matchRole
  })

  const counts = {
    total: users.length,
    admin: users.filter(u => u.role === 'admin').length,
    sales_manager: users.filter(u => u.role === 'sales_manager').length,
    sales_specialist: users.filter(u => u.role === 'sales_specialist').length,
    rsr: users.filter(u => u.role === 'rsr').length,
    collector: users.filter(u => u.role === 'collector').length,
    active: users.filter(u => u.is_active).length,
  }

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError('')
    setShowPassword(false)
    setCreateOpen(true)
  }

  function openEdit(user: UserRow) {
    setForm({
      full_name: user.full_name,
      email: user.email,
      password: '',
      role: user.role,
      team_id: user.team_id ?? '',
    } satisfies UserFormData)
    setFormError('')
    setShowPassword(false)
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
    const { error } = await createUser({
      full_name: form.full_name.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      role: form.role,
      team_id: form.team_id || null,
    })
    setSaving(false)
    if (error) { setFormError(error); return }
    setCreateOpen(false)
    loadUsers()
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
      team_id: form.team_id || null,
    })
    setSaving(false)
    if (error) { setFormError(error); return }
    setEditTarget(null)
    loadUsers()
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
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          {([
            { label: 'Total Users', value: counts.total, icon: Users, color: 'text-foreground' },
            { label: 'Admins', value: counts.admin, icon: ShieldCheck, color: 'text-primary' },
            { label: 'Sales Managers', value: counts.sales_manager, icon: Briefcase, color: 'text-blue-400' },
            { label: 'Sales Specialists', value: counts.sales_specialist, icon: User, color: 'text-yellow-400' },
            { label: 'RSR', value: counts.rsr, icon: Store, color: 'text-orange-400' },
            { label: 'Collectors', value: counts.collector, icon: Wallet, color: 'text-purple-400' },
          ] as const).map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="bg-card border-border">
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
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="sales_manager">Sales Manager</SelectItem>
              <SelectItem value="sales_specialist">Sales Specialist</SelectItem>
              <SelectItem value="rsr">RSR</SelectItem>
              <SelectItem value="collector">Collector</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={loadUsers} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={openCreate} size="sm" className="h-9 gap-2">
            <UserPlus className="w-4 h-4" />
            Create User
          </Button>
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
                        {[...Array(4)].map((_, j) => (
                          <td key={j} className="px-5 py-3">
                            <div className="h-3 w-16 bg-muted rounded" />
                          </td>
                        ))}
                        <td className="px-5 py-3" />
                      </tr>
                    ))
                  ) : filtered.map(user => {
                    const RoleIcon = ROLE_ICON[user.role]
                    return (
                      <tr key={user.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-primary">
                                {user.full_name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <p className="font-medium text-foreground leading-tight">{user.full_name}</p>
                              <p className="text-xs text-muted-foreground">{user.email || '—'}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant="outline" className={`text-[11px] px-2 h-5 gap-1 ${ROLE_STYLE[user.role]}`}>
                            <RoleIcon className="w-3 h-3" />
                            {ROLE_LABEL[user.role]}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 hidden md:table-cell">
                          <span className="text-xs text-muted-foreground">{user.team_id ?? '—'}</span>
                        </td>
                        <td className="px-5 py-3 hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {new Date(user.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <Badge
                            variant="outline"
                            className={user.is_active
                              ? 'text-[11px] px-2 h-5 bg-primary/10 text-primary border-primary/30'
                              : 'text-[11px] px-2 h-5 bg-muted text-muted-foreground border-border'
                            }
                          >
                            {user.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-accent transition-colors">
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
          <UserForm form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} isCreate />
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
          <UserForm form={form} setForm={setForm} showPassword={showPassword} setShowPassword={setShowPassword} isCreate={false} />
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
}

function UserForm({ form, setForm, showPassword, setShowPassword, isCreate }: UserFormProps) {
  function set(field: keyof UserFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  return (
    <div className="space-y-4 py-2">
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
        <Select value={form.role} onValueChange={v => set('role', v ?? 'sales_specialist')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="sales_manager">Sales Manager</SelectItem>
            <SelectItem value="sales_specialist">Sales Specialist</SelectItem>
            <SelectItem value="rsr">RSR</SelectItem>
            <SelectItem value="collector">Collector</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTION[form.role]}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="team_id">Team ID <span className="text-muted-foreground">(optional)</span></Label>
        <Input
          id="team_id"
          placeholder="e.g. team-1"
          value={form.team_id}
          onChange={e => set('team_id', e.target.value)}
        />
      </div>
    </div>
  )
}
