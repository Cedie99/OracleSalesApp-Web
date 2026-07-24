'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ClientDetailDialog } from '@/components/clients/client-detail-dialog'
import { useClients } from '@/lib/hooks/use-clients'
import { useMeetings } from '@/lib/hooks/use-meetings'
import { AlertTriangle, Building2, User, Calendar, Clock, Unlock, Search, Loader2 } from 'lucide-react'
import { format, formatDistanceToNow, isPast } from 'date-fns'

export default function LostOpportunitiesPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)

  const { clients, loading, error } = useClients()
  const { meetings } = useMeetings()

  const lostClients = clients.filter(c => c.status === 'lost')
  const selectedClient = lostClients.find(c => c.id === selectedClientId) ?? null

  const filtered = lostClients.filter(c => {
    const isReassignable = c.reassignable_at ? isPast(new Date(c.reassignable_at)) : false
    const matchSearch = c.company_name.toLowerCase().includes(search.toLowerCase()) ||
      c.contact_person.toLowerCase().includes(search.toLowerCase()) ||
      (c.agent?.full_name ?? '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' ||
      (statusFilter === 'ready' && isReassignable) ||
      (statusFilter === 'locked' && !isReassignable)
    return matchSearch && matchStatus
  })

  return (
    <div className="flex flex-col flex-1">
      <Header title="Lost Opportunities" subtitle={`${filtered.length} of ${lostClients.length} clients removed from agents`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Info banner */}
        <div className="flex items-start gap-3 bg-[var(--badge-amber-bg)] rounded-2xl p-4">
          <AlertTriangle className="w-4 h-4 text-[var(--badge-amber-fg)] shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <p className="font-medium text-foreground mb-0.5">Lost Opportunity Rules</p>
            When a meeting is marked &ldquo;Lost Opportunity,&rdquo; the client is automatically removed from the agent&apos;s list and archived here.
            After <span className="text-foreground font-medium">14 days</span>, the client becomes available for reassignment to a different agent.
            The original agent cannot re-approach.
          </div>
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
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
            <SelectTrigger className="w-52 h-9 bg-card border-border">
              <SelectValue placeholder="Reassignment Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="ready">Ready for Reassignment</SelectItem>
              <SelectItem value="locked">Locked</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(client => {
            const lostMeeting = meetings.find(m => m.client_id === client.id && m.outcome === 'lost_opportunity')
            const isReassignable = client.reassignable_at ? isPast(new Date(client.reassignable_at)) : false

            return (
              <Card
                key={client.id}
                onClick={() => setSelectedClientId(client.id)}
                className={`bg-card hover:border-primary/30 transition-colors cursor-pointer ${isReassignable ? 'border-primary/30' : 'border-destructive/20'}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isReassignable ? 'bg-primary/10' : 'bg-destructive/10'}`}>
                        {isReassignable
                          ? <Unlock className="w-4 h-4 text-primary" />
                          : <AlertTriangle className="w-4 h-4 text-destructive" />
                        }
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{client.company_name}</p>
                        <Badge variant="outline" className={`text-[10px] px-1.5 h-4 mt-0.5 ${isReassignable ? 'bg-primary/15 text-primary border-primary/30' : 'bg-destructive/15 text-destructive border-destructive/30'}`}>
                          {isReassignable ? 'Ready for Reassignment' : 'Locked'}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-xs text-muted-foreground mb-3">
                    <div className="flex items-center gap-1.5">
                      <User className="w-3 h-3 shrink-0" />
                      <span>Lost by: <span className="text-foreground">{client.agent?.full_name}</span></span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Building2 className="w-3 h-3 shrink-0" />
                      <span>{client.contact_person}</span>
                    </div>
                    {lostMeeting?.remarks && (
                      <div className="mt-2 bg-muted/30 rounded-lg p-2.5">
                        <p className="text-muted-foreground italic">&ldquo;{lostMeeting.remarks}&rdquo;</p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5 pt-3 border-t border-border text-xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Calendar className="w-3 h-3" />
                        <span>Lost on</span>
                      </div>
                      <span className="text-foreground">{client.lost_at ? format(new Date(client.lost_at), 'MMM d, yyyy') : '—'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>Reassignable</span>
                      </div>
                      <span className={isReassignable ? 'text-primary font-medium' : 'text-foreground'}>
                        {client.reassignable_at
                          ? isReassignable
                            ? 'Now available'
                            : `In ${formatDistanceToNow(new Date(client.reassignable_at))}`
                          : '—'}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

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
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {lostClients.length === 0
                ? 'No lost opportunities — no client is currently marked lost'
                : 'No lost opportunities match these filters'}
            </p>
          </div>
        )}
      </div>

      <ClientDetailDialog
        client={selectedClient}
        meetings={meetings}
        onOpenChange={open => { if (!open) setSelectedClientId(null) }}
      />
    </div>
  )
}
