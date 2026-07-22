'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { mockEditRequests } from '@/lib/mock/data'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { ClipboardCheck, Check, X, Clock, ArrowRight } from 'lucide-react'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { APPROVAL_TONE, TONE_CLASS, VALUE_LABEL } from '@/lib/status-styles'

const FIELD_LABEL: Record<string, string> = {
  sales_channel: 'Sales Channel',
  customer_type: 'Customer Type',
  contact_person: 'Contact Person',
  contact_number: 'Contact Number',
  office_address: 'Office Address',
  contact_position: 'Contact Position',
}

export default function ApprovalsPage() {
  const [requests, setRequests] = useState(mockEditRequests)

  const { profile } = useCurrentProfile()

  const pending = requests
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  const resolved = requests
    .filter(r => r.status !== 'pending')
    .sort((a, b) => new Date(b.reviewed_at ?? b.created_at).getTime() - new Date(a.reviewed_at ?? a.created_at).getTime())

  function handleReview(id: string, action: 'approved' | 'rejected') {
    setRequests(prev => prev.map(r =>
      r.id === id
        ? { ...r, status: action, reviewed_at: new Date().toISOString(), reviewed_by: profile?.id ?? null, reviewer: profile ?? undefined }
        : r
    ))
    toast.success(`Request ${action === 'approved' ? 'approved' : 'rejected'} successfully`)
  }

  function RequestCard({ req }: { req: typeof mockEditRequests[0] }) {
    return (
      <Card key={req.id} className="bg-card border-border">
        <CardContent className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="font-semibold text-foreground text-sm">{req.client?.company_name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Requested by <span className="text-foreground">{req.requester?.full_name}</span> · {format(new Date(req.created_at), 'MMM d, h:mm a')}
              </p>
            </div>
            <Badge variant="tone" className={TONE_CLASS[APPROVAL_TONE[req.status]]}>
              {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
            </Badge>
          </div>

          {/* Changes */}
          <div className="space-y-2 mb-3">
            {Object.entries(req.changes).map(([field, change]) => (
              <div key={field} className="bg-muted/30 rounded-lg px-3 py-2 text-xs">
                <p className="text-muted-foreground mb-1.5 font-medium">{FIELD_LABEL[field] ?? field}</p>
                <div className="flex items-center gap-2">
                  <span className="bg-destructive/10 text-destructive px-2 py-0.5 rounded line-through">
                    {VALUE_LABEL[change.old as string] ?? String(change.old)}
                  </span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="bg-primary/10 text-primary px-2 py-0.5 rounded font-medium">
                    {VALUE_LABEL[change.new as string] ?? String(change.new)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {req.status === 'pending' && (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => handleReview(req.id, 'approved')}
                className="flex-1 h-8 bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs"
                variant="outline"
              >
                <Check className="w-3.5 h-3.5 mr-1" /> Approve
              </Button>
              <Button
                size="sm"
                onClick={() => handleReview(req.id, 'rejected')}
                className="flex-1 h-8 bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/30 text-xs"
                variant="outline"
              >
                <X className="w-3.5 h-3.5 mr-1" /> Reject
              </Button>
            </div>
          )}

          {req.status !== 'pending' && req.reviewer && (
            <p className="text-xs text-muted-foreground">
              Reviewed by {req.reviewer.full_name} · {req.reviewed_at ? format(new Date(req.reviewed_at), 'MMM d, h:mm a') : '—'}
            </p>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col flex-1">
      <Header title="Edit Approvals" subtitle="Client detail change requests" pendingApprovals={pending.length} />

      <div className="flex-1 p-6">
        <Tabs defaultValue="pending">
          <TabsList className="bg-card border border-border mb-5">
            <TabsTrigger value="pending" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Clock className="w-3.5 h-3.5 mr-1.5" /> Pending ({pending.length})
            </TabsTrigger>
            <TabsTrigger value="resolved" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <ClipboardCheck className="w-3.5 h-3.5 mr-1.5" /> Resolved ({resolved.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            {pending.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <ClipboardCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No pending approvals</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {pending.map(req => <RequestCard key={req.id} req={req} />)}
              </div>
            )}
          </TabsContent>

          <TabsContent value="resolved">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {resolved.map(req => <RequestCard key={req.id} req={req} />)}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
