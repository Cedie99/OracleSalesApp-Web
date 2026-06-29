'use client'

import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { mockClients, mockMeetings } from '@/lib/mock/data'
import { AlertTriangle, Building2, User, Calendar, Clock, Unlock } from 'lucide-react'
import { format, formatDistanceToNow, isPast } from 'date-fns'

export default function LostOpportunitiesPage() {
  const lostClients = mockClients.filter(c => c.status === 'lost')

  return (
    <div className="flex flex-col flex-1">
      <Header title="Lost Opportunities" subtitle={`${lostClients.length} clients removed from agents`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Info banner */}
        <div className="flex items-start gap-3 bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-4">
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <p className="font-medium text-foreground mb-0.5">Lost Opportunity Rules</p>
            When a meeting is marked "Lost Opportunity," the client is automatically removed from the agent's list and archived here.
            After <span className="text-foreground font-medium">14 days</span>, the client becomes available for reassignment to a different agent.
            The original agent cannot re-approach.
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {lostClients.map(client => {
            const lostMeeting = mockMeetings.find(m => m.client_id === client.id && m.outcome === 'lost_opportunity')
            const isReassignable = client.reassignable_at ? isPast(new Date(client.reassignable_at)) : false

            return (
              <Card key={client.id} className={`bg-card border-border ${isReassignable ? 'border-primary/30' : 'border-destructive/20'}`}>
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
                        <p className="text-muted-foreground italic">"{lostMeeting.remarks}"</p>
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

        {lostClients.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No lost opportunities</p>
          </div>
        )}
      </div>
    </div>
  )
}
