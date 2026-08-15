'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CircularProgress } from '@/components/ui/circular-progress'
import { Pagination } from '@/components/ui/pagination'
import { usePagination } from '@/lib/hooks/use-pagination'
import { ClientDetailDialog } from '@/components/clients/client-detail-dialog'
import { getQualifiedAgendaMilestones } from '@/lib/client-progress'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { useClients } from '@/lib/hooks/use-clients'
import { useMeetings } from '@/lib/hooks/use-meetings'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { useTagAlongs } from '@/lib/hooks/use-tag-alongs'
import { createClient as createSupabaseClient } from '@/lib/supabase/client'
import { recordAuditLog } from '@/lib/audit/actions'
import { buildChanges, type AuditField, type KnownAuditAction } from '@/lib/audit/entries'
import type { Client, CustomerType, SalesChannel, ClientStatus, Profile } from '@/types'
import {
  Search, Building2, Phone, MapPin, Map as MapIcon, User, Plus, RefreshCw, Loader2, ChevronRight, ChevronDown, ArrowLeft, Users,
  TrendingUp, Handshake, Target, CheckCircle2, XCircle,
} from 'lucide-react'
import { format } from 'date-fns'
import { reassignableFrom } from '@/lib/lost-opportunity'
import { toast } from 'sonner'
import {
  CHANNEL_TONE,
  CLIENT_STATUS_TONE,
  CUSTOMER_TYPE_TONE,
  customerTypeBadge,
  TONE_CLASS,
  TONE_TEXT,
  VALUE_LABEL as LABEL,
} from '@/lib/status-styles'
import { managerForTeam } from '@/lib/teams'
import { PSGC_LOCALITIES } from '@/lib/data/psgc-localities'

const ASSIGNABLE_ROLES = ['sales_specialist', 'sales_manager', 'rsr']

interface ClientFormData {
  company_name: string
  contact_person: string
  contact_position: string
  contact_number: string
  office_address: string
  city: string
  customer_type: CustomerType
  sales_channel: SalesChannel
  status: ClientStatus
  assigned_agent_id: string
}

const EMPTY_CLIENT_FORM: ClientFormData = {
  company_name: '',
  contact_person: '',
  contact_position: '',
  contact_number: '',
  office_address: '',
  city: '',
  customer_type: 'new',
  sales_channel: 'distributor',
  status: 'active',
  assigned_agent_id: '',
}

export default function ClientsPage() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const { profile } = useCurrentProfile()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'superadmin'
  const { clients, loading, error, refresh } = useClients()
  // Meetings drive the progress ring (see lib/client-progress.ts), so the page
  // needs them even though it never lists a meeting.
  const { meetings } = useMeetings()
  const { byInvitee: tagAlongsByInviteeId } = useTagAlongs()
  const { byRole } = useProfiles()
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [expandedManagerKey, setExpandedManagerKey] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedManagerKey, setSelectedManagerKey] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Client | null>(null)
  const [form, setForm] = useState<ClientFormData>(EMPTY_CLIENT_FORM)
  const [formError, setFormError] = useState('')
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  const selectedClient = clients.find(c => c.id === selectedClientId) ?? null

  const assignableAgents = byRole(ASSIGNABLE_ROLES)
  const canEditClient = (client: Client) => isAdmin || profile?.id === client.assigned_agent_id

  // The actual managers, so the top of the hierarchy lists real people ("Test
  // manager Two") instead of a generic RSR/Sales bucket. byRole() is stable
  // across renders unless `profiles` itself changes, so this only recomputes
  // on a real profile refresh.
  const managers = useMemo(
    () => [...byRole(['sales_manager'])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [byRole],
  )

  // Deleted clients (see app/api/cron/prospect-cleanup) are gone from this
  // page entirely — there's no "Deleted" option in the Status filter, so
  // "All Status" must not silently include them. They're only surfaced via
  // the header's notification bell.
  const visibleClients = clients.filter(c => c.status !== 'deleted')

  /**
   * Clients each person was actually invited along to, from the tag-along
   * ledger — both contexts, since a companion can be picked when the client is
   * created as well as per meeting. Read straight off `related_client_id`; no
   * detour through meetings, which would miss the client-creation rows entirely.
   */
  const tagAlongClientIds = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const [inviteeId, requests] of tagAlongsByInviteeId) {
      const ids = new Set(
        requests
          .filter(r => r.related_client_id && (r.status === 'accepted' || r.status === 'pending'))
          .map(r => r.related_client_id as string)
      )
      if (ids.size > 0) map.set(inviteeId, ids)
    }
    return map
  }, [tagAlongsByInviteeId])

  // Every visible client's manager, computed once regardless of this page's
  // own search/type/channel/status filters — so scoping the stat row to a
  // manager below doesn't inherit those filters either, same convention as
  // the unscoped totals previously had. A client also lands in a manager's
  // own bucket when they recorded a meeting for it or were tagged along on
  // it — otherwise a manager who only holds clients directly (no agents, or
  // clients their agents don't own) shows an all-zero stat row for clients
  // that very much involve them.
  const clientsByManagerKey = useMemo(() => {
    const byId = new Map(visibleClients.map(c => [c.id, c]))
    const idsByKey = new Map<string, Set<string>>()
    const add = (key: string, id: string) => {
      let set = idsByKey.get(key)
      if (!set) { set = new Set(); idsByKey.set(key, set) }
      set.add(id)
    }
    for (const c of visibleClients) {
      add(managerForTeam(c.agent?.team_id, managers)?.id ?? 'unassigned', c.id)
    }
    for (const mt of meetings) {
      if (mt.agent_id) add(mt.agent_id, mt.client_id)
      if (mt.recorded_by) add(mt.recorded_by, mt.client_id)
    }
    for (const [inviteeId, ids] of tagAlongClientIds) {
      for (const id of ids) add(inviteeId, id)
    }
    const result = new Map<string, Client[]>()
    for (const [key, ids] of idsByKey) {
      result.set(key, [...ids].map(id => byId.get(id)).filter((c): c is Client => !!c))
    }
    return result
  }, [visibleClients, managers, meetings, tagAlongClientIds])


  const filtered = visibleClients.filter(c => {
    const matchSearch = c.company_name.toLowerCase().includes(search.toLowerCase()) ||
      c.contact_person.toLowerCase().includes(search.toLowerCase()) ||
      (c.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase())
    // 'Prospect' is the family, not the single value: it returns in-progress rows
    // too, matching how their badge reads. The 'in_progress' option isolates the
    // subset — the near-term pipeline, which is the reason to keep it filterable
    // at all now that it no longer has a pill of its own.
    const matchType =
      typeFilter === 'all' ||
      c.customer_type === typeFilter ||
      (typeFilter === 'prospect' && c.customer_type === 'in_progress')
    const matchChannel = channelFilter === 'all' || c.sales_channel === channelFilter
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    return matchSearch && matchType && matchChannel && matchStatus
  })

  // Group clients by agent so the grid isn't a wall of 60+ cards at once —
  // the hierarchy view (manager -> agent -> clients) reveals one level at a
  // time on click. Each agent is bucketed under whichever manager shares
  // their team_id ('unassigned' if no manager leads that team).
  interface AgentGroup { agentId: string; agentName: string; managerKey: string; clients: Client[] }
  const groups = useMemo(() => {
    const map = new Map<string, AgentGroup>()
    for (const c of filtered) {
      const agentId = c.assigned_agent_id ?? 'unassigned'
      const agentName = c.agent?.full_name ?? 'Unassigned'
      let group = map.get(agentId)
      if (!group) {
        const managerKey = managerForTeam(c.agent?.team_id, managers)?.id ?? 'unassigned'
        group = { agentId, agentName, managerKey, clients: [] }
        map.set(agentId, group)
      }
      group.clients.push(c)
    }
    return Array.from(map.values()).sort((a, b) => a.agentName.localeCompare(b.agentName))
  }, [filtered, managers])

  // Level 0: one bucket per real manager, plus "Unassigned" only if it has anyone in it.
  const managerBuckets = useMemo(() => {
    const buckets = managers.map(m => {
      const managerGroups = groups.filter(g => g.managerKey === m.id)
      // Two figures, not one. `recorded_by` means the manager filled in the
      // meeting form — it had been standing in for "tagged along", which it is
      // not: a manager invited along on an agent's visit records nothing and
      // counted as zero. Real tag-alongs now come from the ledger.
      const ownClientIds = new Set(
        meetings.filter(mt => mt.agent_id === m.id || mt.recorded_by === m.id).map(mt => mt.client_id)
      )
      const ownClientCount = filtered.filter(c => ownClientIds.has(c.id)).length
      const invited = tagAlongClientIds.get(m.id)
      const tagAlongCount = invited ? filtered.filter(c => invited.has(c.id)).length : 0
      const managerClientCount = filtered.filter(c => ownClientIds.has(c.id) || (invited?.has(c.id) ?? false)).length
      // Team total: clients reached via an agent under this manager, unioned
      // with the manager's own direct clients — a manager with no agents (or
      // whose agents have none) still has their own clients counted here, and
      // a client who's both agent-assigned and directly held isn't double-counted.
      const teamClientIds = new Set(managerGroups.flatMap(g => g.clients.map(c => c.id)))
      const clientCount = filtered.filter(
        c => teamClientIds.has(c.id) || ownClientIds.has(c.id) || (invited?.has(c.id) ?? false)
      ).length
      return {
        key: m.id,
        label: m.full_name,
        agentCount: managerGroups.length,
        clientCount,
        ownClientCount,
        tagAlongCount,
        managerClientCount,
      }
    })
    const unassignedGroups = groups.filter(g => g.managerKey === 'unassigned')
    if (unassignedGroups.length > 0) {
      buckets.push({
        key: 'unassigned',
        label: 'Unassigned',
        agentCount: unassignedGroups.length,
        clientCount: unassignedGroups.reduce((sum, g) => sum + g.clients.length, 0),
        ownClientCount: 0,
        tagAlongCount: 0,
        managerClientCount: 0,
      })
    }
    return buckets
  }, [managers, groups, meetings, filtered, tagAlongClientIds])

  // The selected agent's clients (drill-down screen, unchanged regardless of
  // which team's dropdown is open).
  const selectedGroup = selectedAgentId ? groups.find(g => g.agentId === selectedAgentId) ?? null : null

  // A manager's own records — clients they personally met with, whether solo
  // or tagging along on an agent's visit. Deliberately *not* the whole
  // team's clients — just the manager's own footprint, matching the mobile app.
  const selectedManagerBucket = selectedManagerKey
    ? managerBuckets.find(b => b.key === selectedManagerKey) ?? null
    : null
  const managerClients = useMemo(() => {
    if (!selectedManagerKey) return []
    const ownClientIds = new Set(
      meetings.filter(mt => mt.agent_id === selectedManagerKey || mt.recorded_by === selectedManagerKey).map(mt => mt.client_id)
    )
    const invited = tagAlongClientIds.get(selectedManagerKey)
    return filtered.filter(c => ownClientIds.has(c.id) || invited?.has(c.id))
  }, [selectedManagerKey, meetings, filtered, tagAlongClientIds])
  const activeClients = selectedGroup?.clients ?? (selectedManagerBucket ? managerClients : null)

  // The stat row must match whatever the table below it actually shows — a
  // fully selected agent or manager uses their own footprint (activeClients,
  // the exact set the table renders), so the two numbers never disagree. A
  // manager who's only expanded in the list (previewing, not yet drilled in)
  // uses the team-wide total instead; otherwise it's the global total.
  const statsClients =
    activeClients ?? (expandedManagerKey ? clientsByManagerKey.get(expandedManagerKey) ?? [] : visibleClients)

  const counts = {
    total: statsClients.length,
    existing: statsClients.filter(c => c.customer_type === 'existing').length,
    new: statsClients.filter(c => c.customer_type === 'new').length,
    inProgress: statsClients.filter(c => c.customer_type === 'in_progress').length,
    prospect: statsClients.filter(c => c.customer_type === 'prospect').length,
    active: statsClients.filter(c => c.status === 'active').length,
    lost: statsClients.filter(c => c.status === 'lost').length,
  }

  const { pageItems: pageClients, page: clientPage, pageCount: clientPageCount, from: clientFrom, to: clientTo, total: clientTotal, setPage: setClientPage } = usePagination(
    activeClients ?? [], 9, `${selectedAgentId}|${selectedManagerKey}|${search}|${typeFilter}|${channelFilter}|${statusFilter}`,
  )

  function openCreate() {
    setForm({ ...EMPTY_CLIENT_FORM, assigned_agent_id: assignableAgents[0]?.id ?? '' })
    setFormError('')
    setPhoneTouched(false)
    setCreateOpen(true)
  }

  function openEdit(client: Client) {
    setForm({
      company_name: client.company_name,
      contact_person: client.contact_person,
      contact_position: client.contact_position ?? '',
      contact_number: client.contact_number,
      office_address: client.office_address,
      city: client.city ?? '',
      customer_type: client.customer_type,
      sales_channel: client.sales_channel,
      status: client.status === 'deleted' ? 'active' : client.status,
      assigned_agent_id: client.assigned_agent_id,
    })
    setFormError('')
    setPhoneTouched(false)
    setEditTarget(client)
  }

  /** Sentinel returned instead of a message: the phone field shows its own red outline. */
  const PHONE_INVALID = 'PHONE_INVALID'

  function validateForm(): string {
    if (!form.company_name.trim()) return 'Company name is required.'
    if (!form.contact_person.trim()) return 'Contact person is required.'
    if (!/^\d{11}$/.test(form.contact_number)) { setPhoneTouched(true); return PHONE_INVALID }
    if (!form.office_address.trim()) return 'Office address is required.'
    if (!form.assigned_agent_id) return 'Assign an agent to this client.'
    return ''
  }

  /** The form fields that map 1:1 onto columns, trimmed. */
  function formColumns() {
    return {
      company_name: form.company_name.trim(),
      contact_person: form.contact_person.trim(),
      contact_position: form.contact_position.trim() || null,
      contact_number: form.contact_number.trim(),
      office_address: form.office_address.trim(),
      city: form.city.trim() || null,
      customer_type: form.customer_type,
      sales_channel: form.sales_channel,
      assigned_agent_id: form.assigned_agent_id,
      status: form.status,
    }
  }

  /** An agent's name for the audit log — a bare UUID tells a reader nothing. */
  function agentName(id: string | null | undefined): string | null {
    if (!id) return null
    return assignableAgents.find(a => a.id === id)?.full_name ?? null
  }

  /**
   * The client fields worth a before/after line in the log, and how each one
   * reads. Everything on the form is here: any of it can be the change someone
   * later needs to account for.
   */
  const CLIENT_AUDIT_FIELDS: AuditField<Record<string, unknown>>[] = [
    { field: 'company_name', label: 'Company' },
    { field: 'contact_person', label: 'Contact person' },
    { field: 'contact_position', label: 'Contact position' },
    { field: 'contact_number', label: 'Contact number' },
    { field: 'office_address', label: 'Office address' },
    { field: 'city', label: 'Municipality/City' },
    { field: 'customer_type', label: 'Customer type', format: v => (v ? LABEL[v as string] ?? String(v) : null) },
    { field: 'sales_channel', label: 'Sales channel', format: v => (v ? LABEL[v as string] ?? String(v) : null) },
    { field: 'status', label: 'Status', format: v => (v ? LABEL[v as string] ?? String(v) : null) },
    { field: 'assigned_agent_id', label: 'Assigned agent', format: v => agentName(v as string | null) },
  ]

  async function handleCreate() {
    const err = validateForm()
    if (err) { setFormError(err); return }

    setSaving(true)
    setFormError('')
    const now = new Date().toISOString()
    const isLost = form.status === 'lost'
    const columns = formColumns()

    const { data: created, error: insertError } = await createSupabaseClient()
      .from('clients')
      .insert({
        ...columns,
        lost_at: isLost ? now : null,
        // One-month cooling-off before a lost client can be reassigned. The
        // BEFORE UPDATE trigger that normally stamps this does NOT fire on an
        // insert, so this path has to compute it — see lib/lost-opportunity.ts.
        reassignable_at: isLost ? reassignableFrom(new Date()).toISOString() : null,
      })
      .select('id')
      .single()

    setSaving(false)
    if (insertError) {
      setFormError(insertError.message)
      return
    }

    // Logged after the write, and never awaited into the error path — a broken
    // audit table must not make a saved client look unsaved. See lib/audit.
    void recordAuditLog({
      action: 'client.created',
      entityTable: 'clients',
      entityId: created?.id ?? null,
      entityLabel: columns.company_name,
      summary: `Created client ${columns.company_name}`,
      // Everything is "new" on a create, so the diff is the starting values
      // rather than a set of changes — from is null throughout.
      changes: buildChanges(null, columns, CLIENT_AUDIT_FIELDS),
    })

    setCreateOpen(false)
    toast.success('Client created successfully')
    await refresh()
  }

  async function handleEdit() {
    if (!editTarget) return
    const err = validateForm()
    if (err) { setFormError(err); return }

    setSaving(true)
    setFormError('')
    const wasLost = editTarget.status === 'lost'
    const isLost = form.status === 'lost'

    // Only stamp lost_at/reassignable_at on the transition. Re-saving an
    // already-lost client must not restart its reassignment clock.
    const lostFields = isLost
      ? {
          lost_at: editTarget.lost_at ?? new Date().toISOString(),
          reassignable_at: editTarget.reassignable_at ?? reassignableFrom(new Date()).toISOString(),
        }
      : wasLost
        ? { lost_at: null, reassignable_at: null }
        : {}

    const columns = formColumns()

    const { error: updateError } = await createSupabaseClient()
      .from('clients')
      .update({ ...columns, ...lostFields, updated_at: new Date().toISOString() })
      .eq('id', editTarget.id)

    setSaving(false)
    if (updateError) {
      setFormError(updateError.message)
      return
    }

    void recordAuditLog({
      ...describeClientEdit(editTarget, columns, wasLost, isLost),
      entityTable: 'clients',
      entityId: editTarget.id,
      entityLabel: columns.company_name,
      changes: buildChanges(
        editTarget as unknown as Record<string, unknown>,
        columns,
        CLIENT_AUDIT_FIELDS,
      ),
    })

    setEditTarget(null)
    toast.success('Client updated successfully')
    await refresh()
  }

  /**
   * Which of the four client actions an edit actually was, and how to say it.
   *
   * One "Edited client" for all of them would be technically true and useless:
   * the three that matter to a reader — declaring a lost opportunity, undoing
   * one, and handing a client to a different agent — are exactly the ones
   * someone opens this log to find, and they are indistinguishable from a phone
   * number correction once flattened into a generic update. The full field diff
   * rides along either way; this only decides the headline.
   *
   * Order is deliberate. A lost/active transition outranks a reassignment
   * because it is the bigger event, and because the two travel together: moving
   * a client to lost and off its agent in one save is one act, and it reads as
   * the loss.
   */
  function describeClientEdit(
    before: Client,
    after: ReturnType<typeof formColumns>,
    wasLost: boolean,
    isLost: boolean,
  ): { action: KnownAuditAction; summary: string } {
    const name = after.company_name

    if (!wasLost && isLost) {
      return { action: 'client.marked_lost', summary: `Marked ${name} as a lost opportunity` }
    }
    if (wasLost && !isLost) {
      return { action: 'client.reinstated', summary: `Reinstated ${name} from lost opportunities` }
    }

    if (before.assigned_agent_id !== after.assigned_agent_id) {
      const from = agentName(before.assigned_agent_id) ?? 'nobody'
      const to = agentName(after.assigned_agent_id) ?? 'nobody'
      // Naming it as a lost opportunity matters here: reassigning one is
      // governed by the cooling-off rule, so the entry should say which kind of
      // reassignment this was without the reader cross-checking the status.
      const what = isLost ? `lost opportunity ${name}` : name
      return { action: 'client.reassigned', summary: `Reassigned ${what} from ${from} to ${to}` }
    }

    return { action: 'client.updated', summary: `Edited client ${name}` }
  }

  return (
    <div className="flex flex-col flex-1">
      <Header title="Clients" subtitle={`${filtered.length} of ${visibleClients.length} clients`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {([
            { label: 'Total Clients', value: counts.total, icon: Building2, color: 'text-foreground' },
            { label: 'Existing', value: counts.existing, icon: Users, color: TONE_TEXT[CUSTOMER_TYPE_TONE.existing] },
            { label: 'New', value: counts.new, icon: TrendingUp, color: TONE_TEXT[CUSTOMER_TYPE_TONE.new] },
            { label: 'In Progress', value: counts.inProgress, icon: Handshake, color: TONE_TEXT[CUSTOMER_TYPE_TONE.in_progress] },
            { label: 'Prospect', value: counts.prospect, icon: Target, color: TONE_TEXT[CUSTOMER_TYPE_TONE.prospect] },
            { label: 'Active', value: counts.active, icon: CheckCircle2, color: TONE_TEXT[CLIENT_STATUS_TONE.active] },
            { label: 'Lost', value: counts.lost, icon: XCircle, color: TONE_TEXT[CLIENT_STATUS_TONE.lost] },
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

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search company, contact, or agent..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-card border-border h-9"
            />
          </div>
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Select value={typeFilter} onValueChange={v => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="w-36 h-9 bg-card border-border">
              <SelectValue placeholder="Customer Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="existing">Existing</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="prospect">Prospect</SelectItem>
              {/* Indented because it is a subset of the option above it, not a peer. */}
              <SelectItem value="in_progress" className="pl-5">In Progress only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={channelFilter} onValueChange={v => setChannelFilter(v ?? 'all')}>
            <SelectTrigger className="w-36 h-9 bg-card border-border">
              <SelectValue placeholder="Sales Channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Channels</SelectItem>
              <SelectItem value="distributor">Distributor</SelectItem>
              <SelectItem value="dealer">Dealer</SelectItem>
              <SelectItem value="end_user">End-User</SelectItem>
              <SelectItem value="private_label">Private Label</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
            <SelectTrigger className="w-32 h-9 bg-card border-border">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
            </SelectContent>
          </Select>
          {/* Hidden for now, will bring back later */}
          {/* <Button onClick={openCreate} size="sm" className="h-9 gap-2">
            <Plus className="w-4 h-4" />
            New Client
          </Button> */}
        </div>

        {!selectedGroup && !selectedManagerBucket ? (
          <>
            {/* Teams — click one to drop down their team's agents right below it */}
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Teams
            </p>
            <div className="space-y-3">
              {managerBuckets.map(({ key, label, agentCount, clientCount, managerClientCount }) => {
                const isOpen = expandedManagerKey === key
                const bucketGroups = groups.filter(g => g.managerKey === key)
                return (
                  <div
                    key={key}
                    className={`rounded-lg border bg-card overflow-hidden transition-colors ${isOpen ? 'border-primary/50 shadow-sm' : 'border-border'}`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedManagerKey(isOpen ? null : key)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Users className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{label}</p>
                          <p className="text-xs text-muted-foreground">
                            {agentCount} agent{agentCount === 1 ? '' : 's'} · {clientCount} client{clientCount === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="bg-muted/40 border-t border-border p-4 pl-6 space-y-4">
                        {key !== 'unassigned' && (
                          <div className="space-y-2.5">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                              Manager
                            </p>
                            <button
                              type="button"
                              onClick={() => { setSelectedManagerKey(key); setSelectedAgentId(null) }}
                              className="w-full flex items-center justify-between gap-3 p-3 rounded-lg bg-card border border-primary/50 shadow-sm text-left hover:border-primary hover:bg-primary/5 transition-colors"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                                  <span className="text-xs font-bold text-primary">
                                    {label.charAt(0)}
                                  </span>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-foreground truncate">{label}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {managerClientCount} client{managerClientCount === 1 ? '' : 's'}
                                  </p>
                                </div>
                              </div>
                              <ChevronRight className="w-4 h-4 text-primary shrink-0" />
                            </button>
                          </div>
                        )}

                        <div className="space-y-2.5">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                            Agents under {label}
                          </p>
                          {bucketGroups.map(group => (
                            <button
                              key={group.agentId}
                              type="button"
                              onClick={() => { setSelectedAgentId(group.agentId); setSelectedManagerKey(null) }}
                              className="w-full flex items-center justify-between gap-3 p-3 rounded-lg bg-card border border-border shadow-sm text-left hover:border-primary/40 hover:bg-accent/30 transition-colors"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                                  <span className="text-xs font-bold text-primary">
                                    {group.agentName.charAt(0)}
                                  </span>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-foreground truncate">{group.agentName}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {group.clients.length} client{group.clients.length === 1 ? '' : 's'}
                                  </p>
                                </div>
                              </div>
                              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <>
            {/* Selected agent's or manager's clients */}
            <div className="space-y-3">
              <Button
                variant="outline" size="sm" className="h-9 gap-2"
                onClick={() => { setSelectedAgentId(null); setSelectedManagerKey(null) }}
              >
                <ArrowLeft className="w-4 h-4" />
                Back to agents
              </Button>

              <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-primary">
                    {(selectedGroup?.agentName ?? selectedManagerBucket?.label ?? '').charAt(0)}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    {selectedGroup ? 'Agent' : 'Manager · Recorded and tagged along'}
                  </p>
                  <p className="text-base font-semibold text-foreground truncate">
                    {selectedGroup?.agentName ?? selectedManagerBucket?.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(activeClients ?? []).length} client{(activeClients ?? []).length === 1 ? '' : 's'}
                  </p>
                </div>
                {/* Same deep link for a manager as an agent — SalesMapView's `agent`
                    param already resolves a manager's own tag-along footprint
                    (see the comment on `scopedTagAlongs` there), not just a literal
                    sales agent's assigned clients. 'unassigned' isn't a real person
                    to scope by, so it gets no button. */}
                {selectedGroup && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => router.push(`/maps?module=sales&agent=${encodeURIComponent(selectedGroup.agentId)}`)}
                  >
                    <MapIcon /> View on map
                  </Button>
                )}
                {!selectedGroup && selectedManagerKey && selectedManagerKey !== 'unassigned' && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => router.push(`/maps?module=sales&agent=${encodeURIComponent(selectedManagerKey)}`)}
                  >
                    <MapIcon /> View on map
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {pageClients.map(client => (
                <Card
                  key={client.id}
                  onClick={() => setSelectedClientId(client.id)}
                  className="bg-card border-border hover:border-primary/30 transition-colors cursor-pointer"
                >
                  <CardContent className="p-4 flex-1 flex flex-col">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2.5 mb-3">
                          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                            <Building2 className="w-4 h-4 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground truncate leading-tight">{client.company_name}</p>
                            <Badge variant="tone" className={`h-4 mt-0.5 ${TONE_CLASS[CLIENT_STATUS_TONE[client.status]]}`}>
                              {LABEL[client.status]}
                            </Badge>
                          </div>
                        </div>

                        <div className="space-y-1.5 text-xs text-muted-foreground mb-3">
                          <div className="flex items-center gap-1.5">
                            <User className="w-3 h-3 shrink-0" />
                            <span className="truncate">{client.contact_person}{client.contact_position ? ` · ${client.contact_position}` : ''}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Phone className="w-3 h-3 shrink-0" />
                            <span>{client.contact_number}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <MapPin className="w-3 h-3 shrink-0" />
                            <span className="truncate">{client.office_address}</span>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="tone" className={TONE_CLASS[customerTypeBadge(client.customer_type).tone]}>
                            {customerTypeBadge(client.customer_type).label}
                          </Badge>
                          <Badge variant="tone" className={TONE_CLASS[CHANNEL_TONE[client.sales_channel]]}>
                            {LABEL[client.sales_channel]}
                          </Badge>
                        </div>
                      </div>

                      <CircularProgress value={getQualifiedAgendaMilestones(client.id, meetings).percent} size={80} strokeWidth={7} className="shrink-0" />
                    </div>

                    <div className="flex-1" />

                    <div className="flex items-center justify-end pt-2 border-t border-border">
                      <span className="text-sm text-muted-foreground">
                        {format(new Date(client.created_at), 'MMM d, yyyy')}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {!loading && !error && (
              <Pagination
                page={clientPage} pageCount={clientPageCount} onPageChange={setClientPage}
                from={clientFrom} to={clientTo} total={clientTotal} itemLabel="clients"
              />
            )}
          </>
        )}

        {loading && (
          <div className="text-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
            <p className="text-sm">Loading clients…</p>
          </div>
        )}

        {!loading && error && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              Couldn&apos;t load clients: {error}
            </AlertDescription>
          </Alert>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {visibleClients.length === 0 ? 'No clients yet' : 'No clients match these filters'}
            </p>
          </div>
        )}
      </div>

      <ClientDetailDialog
        client={selectedClient}
        meetings={meetings}
        onOpenChange={open => { if (!open) setSelectedClientId(null) }}
        canEdit={!!selectedClient && canEditClient(selectedClient)}
        onEdit={openEdit}
      />

      {/* Create Client Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Client</DialogTitle>
          </DialogHeader>
          <ClientForm
            form={form}
            setForm={setForm}
            agents={assignableAgents}
            phoneInvalid={phoneTouched && !/^\d{11}$/.test(form.contact_number)}
            onPhoneBlur={() => setPhoneTouched(true)}
          />
          {formError && formError !== PHONE_INVALID && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create Client'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Client Dialog */}
      <Dialog open={!!editTarget} onOpenChange={open => { if (!open) setEditTarget(null) }}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Client</DialogTitle>
          </DialogHeader>
          <ClientForm
            form={form}
            setForm={setForm}
            agents={assignableAgents}
            phoneInvalid={phoneTouched && !/^\d{11}$/.test(form.contact_number)}
            onPhoneBlur={() => setPhoneTouched(true)}
          />
          {formError && formError !== PHONE_INVALID && (
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

interface ClientFormProps {
  form: ClientFormData
  setForm: React.Dispatch<React.SetStateAction<ClientFormData>>
  agents: Profile[]
  phoneInvalid: boolean
  onPhoneBlur: () => void
}

// Suggestions for the Municipality/City field's native autocomplete — same
// PSGC dataset the mobile app bundles, so "Quezon" surfaces "Quezon City"
// with the same spelling on both platforms. Deduped by name: the dataset
// carries province too, but a <datalist> has no way to show it, and repeat
// names (Santa Maria, San Fernando...) would otherwise appear several times.
const CITY_SUGGESTIONS = Array.from(new Set(PSGC_LOCALITIES.map(l => l.name))).sort((a, b) => a.localeCompare(b))

function ClientForm({ form, setForm, agents, phoneInvalid, onPhoneBlur }: ClientFormProps) {
  function set<K extends keyof ClientFormData>(field: K, value: ClientFormData[K]) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  return (
    <div className="space-y-5 py-2">
      <div className="rounded-lg border border-border p-4 space-y-4">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Company Details</p>

        <div className="space-y-1.5">
          <Label htmlFor="company_name" className="flex items-center gap-1.5 text-xs">
            <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
            Company Name
          </Label>
          <Input
            id="company_name"
            placeholder="e.g. Oracle Petroleum"
            value={form.company_name}
            onChange={e => set('company_name', e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="contact_person" className="flex items-center gap-1.5 text-xs">
              <User className="w-3.5 h-3.5 text-muted-foreground" />
              Contact Person
            </Label>
            <Input
              id="contact_person"
              placeholder="e.g. Bong Aquino"
              value={form.contact_person}
              onChange={e => set('contact_person', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact_position" className="text-xs">
              Position <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="contact_position"
              placeholder="e.g. Procurement Manager"
              value={form.contact_position}
              onChange={e => set('contact_position', e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="contact_number" className="flex items-center gap-1.5 text-xs">
              <Phone className="w-3.5 h-3.5 text-muted-foreground" />
              Phone Number
            </Label>
            <Input
              id="contact_number"
              placeholder="09171234567"
              value={form.contact_number}
              onChange={e => set('contact_number', e.target.value.replace(/\D/g, '').slice(0, 11))}
              onBlur={onPhoneBlur}
              aria-invalid={phoneInvalid}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="office_address" className="flex items-center gap-1.5 text-xs">
              <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
              Office Address
            </Label>
            <Input
              id="office_address"
              placeholder="e.g. 123 EDSA, Makati City"
              value={form.office_address}
              onChange={e => set('office_address', e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="city" className="flex items-center gap-1.5 text-xs">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
            Municipality/City
          </Label>
          <Input
            id="city"
            list="city-suggestions"
            placeholder="e.g. Makati City"
            value={form.city}
            onChange={e => set('city', e.target.value)}
            autoComplete="off"
          />
          <datalist id="city-suggestions">
            {CITY_SUGGESTIONS.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Classification &amp; Assignment</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Customer Type</Label>
            <Select value={form.customer_type} onValueChange={v => set('customer_type', (v as CustomerType | null) ?? 'new')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="existing">Existing</SelectItem>
                <SelectItem value="new">New</SelectItem>
                {/* 'In Progress' is offered only to a client already in it, so the
                    trigger renders its real stage instead of an empty box. It is
                    never a choice: entering that stage also stamps
                    clients.in_progress_at (migration 038), which the close-deal
                    trigger reads — setting it by hand here would write half a
                    transition. The database owns this stage; see CustomerType. */}
                {form.customer_type === 'in_progress' && (
                  <SelectItem value="in_progress">In Progress</SelectItem>
                )}
                <SelectItem value="prospect">Prospect</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Sales Channel</Label>
            <Select value={form.sales_channel} onValueChange={v => set('sales_channel', (v as SalesChannel | null) ?? 'distributor')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="distributor">Distributor</SelectItem>
                <SelectItem value="dealer">Dealer</SelectItem>
                <SelectItem value="end_user">End-User</SelectItem>
                <SelectItem value="private_label">Private Label</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <Select value={form.status} onValueChange={v => set('status', (v as ClientStatus | null) ?? 'active')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="lost">Lost</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Assigned Agent</Label>
            <Select value={form.assigned_agent_id} onValueChange={v => set('assigned_agent_id', v ?? '')}>
              <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
              <SelectContent>
                {agents.map(a => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  )
}
