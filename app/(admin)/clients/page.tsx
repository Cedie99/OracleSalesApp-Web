'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { mockClients } from '@/lib/mock/data'
import type { CustomerType, SalesChannel, ClientStatus } from '@/types'
import { Search, Building2, Phone, MapPin, User } from 'lucide-react'
import { format } from 'date-fns'

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

export default function ClientsPage() {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const filtered = mockClients.filter(c => {
    const matchSearch = c.company_name.toLowerCase().includes(search.toLowerCase()) ||
      c.contact_person.toLowerCase().includes(search.toLowerCase()) ||
      (c.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase())
    const matchType = typeFilter === 'all' || c.customer_type === typeFilter
    const matchChannel = channelFilter === 'all' || c.sales_channel === channelFilter
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    return matchSearch && matchType && matchChannel && matchStatus
  })

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
        </div>

        {/* Client cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(client => (
            <Card key={client.id} className="bg-card border-border hover:border-primary/30 transition-colors">
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

                <div className="flex flex-wrap gap-1.5 mb-3">
                  <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${CUSTOMER_TYPE_STYLE[client.customer_type]}`}>
                    {LABEL[client.customer_type]}
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] px-1.5 h-5 ${CHANNEL_STYLE[client.sales_channel]}`}>
                    {LABEL[client.sales_channel]}
                  </Badge>
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
    </div>
  )
}
