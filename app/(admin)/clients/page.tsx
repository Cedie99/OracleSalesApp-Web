'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { mockClients, mockMeetings, mockProfiles } from '@/lib/mock/data'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import type { Client, CustomerType, SalesChannel, ClientStatus, MeetingOutcome, Profile } from '@/types'
import { Search, Building2, Phone, MapPin, User, CalendarCheck, Navigation, Camera, Plus, Pencil, Star, X as XIcon } from 'lucide-react'
import { format, addDays } from 'date-fns'
import { toast } from 'sonner'

const ClientMap = dynamic(() => import('@/components/maps/client-map'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 h-full flex items-center justify-center text-xs text-muted-foreground">
      Loading map…
    </div>
  ),
})

const OUTCOME_STYLE: Record<MeetingOutcome, string> = {
  successful: 'bg-primary/15 text-primary border-primary/30',
  follow_up: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  no_decision: 'bg-muted text-muted-foreground border-border',
  lost_opportunity: 'bg-destructive/15 text-destructive border-destructive/30',
}

const OUTCOME_LABEL: Record<MeetingOutcome, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up Required',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost Opportunity',
}

const CUSTOMER_TYPE_STYLE: Record<CustomerType, string> = {
  existing: 'bg-primary/15 text-primary border-primary/30',
  new: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  prospect: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
}

const CHANNEL_STYLE: Record<SalesChannel, string> = {
  distributor: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  dealer: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  end_user: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  private_label: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
}

const STATUS_STYLE: Record<ClientStatus, string> = {
  active: 'bg-primary/15 text-primary border-primary/30',
  lost: 'bg-destructive/15 text-destructive border-destructive/30',
  deleted: 'bg-muted text-muted-foreground border-border',
}

const LABEL: Record<string, string> = {
  existing: 'Existing', new: 'New', prospect: 'Prospect',
  distributor: 'Distributor', dealer: 'Dealer', end_user: 'End-User', private_label: 'Private Label',
  active: 'Active', lost: 'Lost', deleted: 'Deleted',
}

const ASSIGNABLE_ROLES = ['sales_specialist', 'sales_manager', 'rsr']

interface ClientFormData {
  company_name: string
  contact_person: string
  contact_position: string
  contact_number: string
  office_address: string
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
  customer_type: 'new',
  sales_channel: 'distributor',
  status: 'active',
  assigned_agent_id: '',
}

function StarRating({ value, onChange, size = 'w-4 h-4' }: { value: number; onChange?: (v: number) => void; size?: string }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(n)}
          className={onChange ? 'cursor-pointer' : 'cursor-default'}
        >
          <Star className={`${size} ${n <= value ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/30'}`} />
        </button>
      ))}
    </div>
  )
}

export default function ClientsPage() {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const { profile } = useCurrentProfile()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'superadmin'
  const [clients, setClients] = useState<Client[]>(mockClients)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [lightboxPhoto, setLightboxPhoto] = useState<{ url: string; date: string; by: string } | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Client | null>(null)
  const [form, setForm] = useState<ClientFormData>(EMPTY_CLIENT_FORM)
  const [formError, setFormError] = useState('')

  const selectedClient = clients.find(c => c.id === selectedClientId) ?? null

  const assignableAgents = mockProfiles.filter(p => ASSIGNABLE_ROLES.includes(p.role))
  const canEditClient = (client: Client) => isAdmin || profile?.id === client.assigned_agent_id

  const filtered = clients.filter(c => {
    const matchSearch = c.company_name.toLowerCase().includes(search.toLowerCase()) ||
      c.contact_person.toLowerCase().includes(search.toLowerCase()) ||
      (c.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase())
    const matchType = typeFilter === 'all' || c.customer_type === typeFilter
    const matchChannel = channelFilter === 'all' || c.sales_channel === channelFilter
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    return matchSearch && matchType && matchChannel && matchStatus
  })

  function openCreate() {
    setForm({ ...EMPTY_CLIENT_FORM, assigned_agent_id: assignableAgents[0]?.id ?? '' })
    setFormError('')
    setCreateOpen(true)
  }

  function openEdit(client: Client) {
    setForm({
      company_name: client.company_name,
      contact_person: client.contact_person,
      contact_position: client.contact_position ?? '',
      contact_number: client.contact_number,
      office_address: client.office_address,
      customer_type: client.customer_type,
      sales_channel: client.sales_channel,
      status: client.status === 'deleted' ? 'active' : client.status,
      assigned_agent_id: client.assigned_agent_id,
    })
    setFormError('')
    setEditTarget(client)
  }

  function validateForm(): string {
    if (!form.company_name.trim()) return 'Company name is required.'
    if (!form.contact_person.trim()) return 'Contact person is required.'
    if (!/^\d{7,15}$/.test(form.contact_number.replace(/[\s-]/g, ''))) return 'Enter a valid phone number.'
    if (!form.office_address.trim()) return 'Office address is required.'
    if (!form.assigned_agent_id) return 'Assign an agent to this client.'
    return ''
  }

  function handleCreate() {
    const err = validateForm()
    if (err) { setFormError(err); return }
    const now = new Date().toISOString()
    const agent = mockProfiles.find(p => p.id === form.assigned_agent_id)
    const isLost = form.status === 'lost'
    const newClient: Client = {
      id: `client-${Date.now()}`,
      company_name: form.company_name.trim(),
      contact_person: form.contact_person.trim(),
      contact_position: form.contact_position.trim() || null,
      contact_number: form.contact_number.trim(),
      office_address: form.office_address.trim(),
      customer_type: form.customer_type,
      sales_channel: form.sales_channel,
      assigned_agent_id: form.assigned_agent_id,
      status: form.status,
      lost_at: isLost ? now : null,
      reassignable_at: isLost ? addDays(new Date(), 14).toISOString() : null,
      created_at: now,
      updated_at: now,
      agent,
    }
    setClients(prev => [newClient, ...prev])
    setCreateOpen(false)
    toast.success('Client created successfully')
  }

  function handleEdit() {
    if (!editTarget) return
    const err = validateForm()
    if (err) { setFormError(err); return }
    const agent = mockProfiles.find(p => p.id === form.assigned_agent_id)
    const wasLost = editTarget.status === 'lost'
    const isLost = form.status === 'lost'
    setClients(prev => prev.map(c => {
      if (c.id !== editTarget.id) return c
      return {
        ...c,
        company_name: form.company_name.trim(),
        contact_person: form.contact_person.trim(),
        contact_position: form.contact_position.trim() || null,
        contact_number: form.contact_number.trim(),
        office_address: form.office_address.trim(),
        customer_type: form.customer_type,
        sales_channel: form.sales_channel,
        assigned_agent_id: form.assigned_agent_id,
        status: form.status,
        lost_at: isLost ? (c.lost_at ?? new Date().toISOString()) : (wasLost && !isLost ? null : c.lost_at),
        reassignable_at: isLost ? (c.reassignable_at ?? addDays(new Date(), 14).toISOString()) : (wasLost && !isLost ? null : c.reassignable_at),
        updated_at: new Date().toISOString(),
        agent,
      }
    }))
    setEditTarget(null)
    toast.success('Client updated successfully')
  }

  function handleRate(clientId: string, rating: number) {
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, rating, updated_at: new Date().toISOString() } : c))
    toast.success('Rating saved')
  }

  return (
    <div className="flex flex-col flex-1">
      <Header title="Clients" subtitle={`${filtered.length} of ${mockClients.length} clients`} />

      <div className="flex-1 p-6 space-y-4">
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
          <Select value={typeFilter} onValueChange={v => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="w-36 h-9 bg-card border-border">
              <SelectValue placeholder="Customer Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="existing">Existing</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="prospect">Prospect</SelectItem>
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
          <Button onClick={openCreate} size="sm" className="h-9 gap-2">
            <Plus className="w-4 h-4" />
            New Client
          </Button>
        </div>

        {/* Client cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(client => (
            <Card
              key={client.id}
              onClick={() => setSelectedClientId(client.id)}
              className="bg-card border-border hover:border-primary/30 transition-colors cursor-pointer"
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Building2 className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate leading-tight">{client.company_name}</p>
                      <Badge variant="outline" className={`text-[10px] px-1.5 h-4 mt-0.5 ${STATUS_STYLE[client.status]}`}>
                        {LABEL[client.status]}
                      </Badge>
                    </div>
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

                <div className="flex items-center justify-between mb-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${CUSTOMER_TYPE_STYLE[client.customer_type]}`}>
                      {LABEL[client.customer_type]}
                    </Badge>
                    <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${CHANNEL_STYLE[client.sales_channel]}`}>
                      {LABEL[client.sales_channel]}
                    </Badge>
                  </div>
                  {client.rating != null && <StarRating value={client.rating} size="w-3 h-3" />}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center">
                      <span className="text-[9px] font-bold text-primary">
                        {client.agent?.full_name?.charAt(0)}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">{client.agent?.full_name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(client.created_at), 'MMM d, yyyy')}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No clients found</p>
          </div>
        )}
      </div>

      <Dialog open={!!selectedClient} onOpenChange={open => { if (!open) setSelectedClientId(null) }}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto" showCloseButton={false}>
          {selectedClient && (() => {
            const clientMeetings = mockMeetings
              .filter(m => m.client_id === selectedClient.id)
              .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
            const meetingPhotos = clientMeetings.filter(m => m.photo_url)

            return (
              <>
                <DialogHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Building2 className="w-5 h-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <DialogTitle className="text-lg">{selectedClient.company_name}</DialogTitle>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${STATUS_STYLE[selectedClient.status]}`}>
                            {LABEL[selectedClient.status]}
                          </Badge>
                          <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${CUSTOMER_TYPE_STYLE[selectedClient.customer_type]}`}>
                            {LABEL[selectedClient.customer_type]}
                          </Badge>
                          <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${CHANNEL_STYLE[selectedClient.sales_channel]}`}>
                            {LABEL[selectedClient.sales_channel]}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {canEditClient(selectedClient) && (
                        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => openEdit(selectedClient)}>
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </Button>
                      )}
                      <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
                        <XIcon className="w-4 h-4" />
                        <span className="sr-only">Close</span>
                      </DialogClose>
                    </div>
                  </div>
                </DialogHeader>

                <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                  {/* Left column: client details */}
                  <div className="md:col-span-3 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="rounded-lg border border-border p-3.5">
                        <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Contact Person</p>
                        <div className="flex items-center gap-2 text-sm text-foreground">
                          <User className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span>{selectedClient.contact_person}</span>
                        </div>
                        {selectedClient.contact_position && (
                          <p className="text-xs text-muted-foreground mt-1 pl-6">{selectedClient.contact_position}</p>
                        )}
                      </div>
                      <div className="rounded-lg border border-border p-3.5">
                        <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Phone Number</p>
                        <div className="flex items-center gap-2 text-sm text-foreground">
                          <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span>{selectedClient.contact_number}</span>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-border p-3.5 space-y-3">
                      <div>
                        <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Office Address</p>
                        <div className="flex items-start gap-2 text-sm text-foreground">
                          <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                          <span>{selectedClient.office_address}</span>
                        </div>
                      </div>

                      {selectedClient.office_lat != null && selectedClient.office_lng != null && (
                        <div className="space-y-1.5">
                          <div className="h-48 rounded-md overflow-hidden border border-border">
                            <ClientMap
                              clients={[selectedClient]}
                              selectedId={selectedClient.id}
                              onSelect={() => {}}
                              mapType="standard"
                            />
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Navigation className="w-3 h-3 shrink-0" />
                            <span className="font-mono">
                              {selectedClient.office_lat.toFixed(4)}, {selectedClient.office_lng.toFixed(4)}
                            </span>
                            <span className="text-muted-foreground/70">(mock GPS)</span>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-border p-3.5 flex items-center justify-between">
                      <p className="text-[11px] font-medium text-muted-foreground">Client Rating</p>
                      <StarRating
                        value={selectedClient.rating ?? 0}
                        onChange={canEditClient(selectedClient) ? (v) => handleRate(selectedClient.id, v) : undefined}
                      />
                    </div>

                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center">
                          <span className="text-[9px] font-bold text-primary">
                            {selectedClient.agent?.full_name?.charAt(0)}
                          </span>
                        </div>
                        <span>{selectedClient.agent?.full_name}</span>
                      </div>
                      <span>Added {format(new Date(selectedClient.created_at), 'MMM d, yyyy')}</span>
                    </div>

                    {selectedClient.status === 'lost' && selectedClient.lost_at && (
                      <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                        Marked lost on {format(new Date(selectedClient.lost_at), 'MMM d, yyyy')}
                        {selectedClient.reassignable_at && (
                          <> · reassignable after {format(new Date(selectedClient.reassignable_at), 'MMM d, yyyy')}</>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right column: visit photos + meeting history */}
                  <div className="md:col-span-2 space-y-4">
                    <div>
                      <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                        <Camera className="w-3.5 h-3.5 text-muted-foreground" />
                        Visit Photos
                      </p>
                      {meetingPhotos.length > 0 ? (
                        <div className="grid grid-cols-3 gap-2">
                          {meetingPhotos.slice(0, 6).map(m => {
                            const submittedBy = m.recorder?.full_name ?? m.agent?.full_name ?? 'Unknown'
                            const dateLabel = format(new Date(m.meeting_date), 'MMM d, yyyy')
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => setLightboxPhoto({ url: m.photo_url!, date: dateLabel, by: submittedBy })}
                                className="relative aspect-square rounded-md overflow-hidden border border-border group cursor-pointer"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={m.photo_url!} alt={`Visit on ${dateLabel}`} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                                <span className="absolute bottom-1 right-1 text-[9px] bg-black/60 text-white rounded px-1 py-0.5">
                                  {format(new Date(m.meeting_date), 'MMM d')}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border p-3.5">
                          No visit photos yet
                        </p>
                      )}
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-foreground mb-2">Meeting History</p>
                      <div className="space-y-2">
                        {clientMeetings.slice(0, 5).map(m => {
                          const submittedBy = m.recorder?.full_name ?? m.agent?.full_name ?? 'Unknown'
                          return (
                            <div key={m.id} className="flex items-center justify-between gap-2 text-xs bg-muted/40 rounded-md px-3 py-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <CalendarCheck className="w-3 h-3 text-muted-foreground shrink-0" />
                                  <span className="truncate">{format(new Date(m.meeting_date), 'MMM d, yyyy')}</span>
                                </div>
                                <div className="flex items-center gap-1.5 mt-1 pl-[18px] text-muted-foreground">
                                  <User className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{submittedBy}</span>
                                </div>
                              </div>
                              <Badge variant="outline" className={`text-[10px] px-1.5 h-5 shrink-0 ${OUTCOME_STYLE[m.outcome]}`}>
                                {OUTCOME_LABEL[m.outcome]}
                              </Badge>
                            </div>
                          )
                        })}
                        {clientMeetings.length === 0 && (
                          <p className="text-xs text-muted-foreground">No meetings recorded yet</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!lightboxPhoto} onOpenChange={open => { if (!open) setLightboxPhoto(null) }}>
        <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
          {lightboxPhoto && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightboxPhoto.url} alt="Visit photo" className="w-full max-h-[75vh] object-contain bg-black" />
              <div className="flex items-center justify-between text-xs text-muted-foreground p-3">
                <span>Submitted by {lightboxPhoto.by}</span>
                <span>{lightboxPhoto.date}</span>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Client Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Client</DialogTitle>
          </DialogHeader>
          <ClientForm form={form} setForm={setForm} agents={assignableAgents} />
          {formError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create Client</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Client Dialog */}
      <Dialog open={!!editTarget} onOpenChange={open => { if (!open) setEditTarget(null) }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Client</DialogTitle>
          </DialogHeader>
          <ClientForm form={form} setForm={setForm} agents={assignableAgents} />
          {formError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleEdit}>Save Changes</Button>
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
}

function ClientForm({ form, setForm, agents }: ClientFormProps) {
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
              onChange={e => set('contact_number', e.target.value)}
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
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Classification &amp; Assignment</p>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Customer Type</Label>
            <Select value={form.customer_type} onValueChange={v => set('customer_type', (v as CustomerType | null) ?? 'new')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="existing">Existing</SelectItem>
                <SelectItem value="new">New</SelectItem>
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

        <div className="grid grid-cols-2 gap-4">
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
