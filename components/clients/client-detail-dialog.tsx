'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CircularProgress } from '@/components/ui/circular-progress'
import { getClientProgress } from '@/lib/client-progress'
import { mockMeetings } from '@/lib/mock/data'
import type { Client, Meeting, MeetingOutcome } from '@/types'
import { Building2, Phone, MapPin, User, CalendarCheck, Navigation, Camera, Pencil, X as XIcon } from 'lucide-react'
import { format } from 'date-fns'
import {
  CHANNEL_TONE,
  CLIENT_STATUS_TONE,
  CUSTOMER_TYPE_TONE,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  TONE_CLASS,
  VALUE_LABEL as LABEL,
} from '@/lib/status-styles'

const ClientMap = dynamic(() => import('@/components/maps/client-map'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 h-full flex items-center justify-center text-xs text-muted-foreground">
      Loading map…
    </div>
  ),
})

function MeetingRow({ meeting }: { meeting: Meeting }) {
  const submittedBy = meeting.recorder?.full_name ?? meeting.agent?.full_name ?? 'Unknown'
  return (
    <div className="flex items-center justify-between gap-2 text-xs bg-muted/40 rounded-md px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <CalendarCheck className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="truncate">{format(new Date(meeting.meeting_date), 'MMM d, yyyy')}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1 pl-[18px] text-muted-foreground">
          <User className="w-3 h-3 shrink-0" />
          <span className="truncate">{submittedBy}</span>
        </div>
      </div>
      <Badge variant="tone" className={`shrink-0 ${TONE_CLASS[OUTCOME_TONE[meeting.outcome]]}`}>
        {OUTCOME_LABEL[meeting.outcome]}
      </Badge>
    </div>
  )
}

interface ClientDetailDialogProps {
  client: Client | null
  onOpenChange: (open: boolean) => void
  canEdit?: boolean
  onEdit?: (client: Client) => void
}

const MEETING_HISTORY_LIMIT = 5

export function ClientDetailDialog({ client, onOpenChange, canEdit = false, onEdit }: ClientDetailDialogProps) {
  const [lightboxPhoto, setLightboxPhoto] = useState<{ url: string; date: string; by: string } | null>(null)
  const [showAllMeetings, setShowAllMeetings] = useState(false)
  const [outcomeFilter, setOutcomeFilter] = useState<MeetingOutcome | 'all'>('all')

  function handleOpenChange(open: boolean) {
    if (!open) setShowAllMeetings(false)
    onOpenChange(open)
  }

  function handleShowAllMeetingsChange(open: boolean) {
    setShowAllMeetings(open)
    if (!open) setOutcomeFilter('all')
  }

  return (
    <>
      <Dialog open={!!client} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-5xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden" showCloseButton={false}>
          {client && (() => {
            const clientMeetings = mockMeetings
              .filter(m => m.client_id === client.id)
              .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
            const meetingPhotos = clientMeetings.filter(m => m.photo_url)
            const progress = getClientProgress(client.id)

            return (
              <>
                <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Building2 className="w-5.5 h-5.5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <DialogTitle className="text-xl">{client.company_name}</DialogTitle>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          <Badge variant="tone" className={TONE_CLASS[CLIENT_STATUS_TONE[client.status]]}>
                            {LABEL[client.status]}
                          </Badge>
                          <Badge variant="tone" className={TONE_CLASS[CUSTOMER_TYPE_TONE[client.customer_type]]}>
                            {LABEL[client.customer_type]}
                          </Badge>
                          <Badge variant="tone" className={TONE_CLASS[CHANNEL_TONE[client.sales_channel]]}>
                            {LABEL[client.sales_channel]}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {canEdit && onEdit && (
                        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => onEdit(client)}>
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

                <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                  {client.status === 'lost' && client.lost_at && (
                    <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 mb-4">
                      Marked lost on {format(new Date(client.lost_at), 'MMM d, yyyy')}
                      {client.reassignable_at && (
                        <> · reassignable after {format(new Date(client.reassignable_at), 'MMM d, yyyy')}</>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                    {/* Left column: client details */}
                    <div className="md:col-span-3 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="rounded-lg border border-border p-3.5">
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Contact Person</p>
                          <div className="flex items-center gap-2 text-sm text-foreground">
                            <User className="w-4 h-4 text-muted-foreground shrink-0" />
                            <span className="truncate">{client.contact_person}</span>
                          </div>
                          {client.contact_position && (
                            <p className="text-xs text-muted-foreground mt-1 pl-6 truncate">{client.contact_position}</p>
                          )}
                        </div>
                        <div className="rounded-lg border border-border p-3.5">
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Phone Number</p>
                          <div className="flex items-center gap-2 text-sm text-foreground">
                            <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                            <span>{client.contact_number}</span>
                          </div>
                        </div>
                        <div className="rounded-lg border border-border p-3.5 flex flex-col items-center justify-center text-center">
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5 self-start">Progress</p>
                          <CircularProgress value={progress} size={56} strokeWidth={5} />
                        </div>
                      </div>

                      <div className="rounded-lg border border-border p-3.5 space-y-3">
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Office Address</p>
                          <div className="flex items-start gap-2 text-sm text-foreground">
                            <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                            <span>{client.office_address}</span>
                          </div>
                        </div>

                        {client.office_lat != null && client.office_lng != null && (
                          <div className="space-y-1.5">
                            <div className="h-64 rounded-md overflow-hidden border border-border">
                              <ClientMap
                                clients={[client]}
                                selectedId={client.id}
                                onSelect={() => {}}
                                mapType="standard"
                              />
                            </div>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <Navigation className="w-3 h-3 shrink-0" />
                              <span className="font-mono">
                                {client.office_lat.toFixed(4)}, {client.office_lng.toFixed(4)}
                              </span>
                              <span className="text-muted-foreground/70">(mock GPS)</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right column: meeting history + visit photos */}
                    <div className="md:col-span-2 space-y-4">
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                            <CalendarCheck className="w-3.5 h-3.5 text-muted-foreground" />
                            Meeting History
                          </p>
                          {clientMeetings.length > MEETING_HISTORY_LIMIT && (
                            <button
                              type="button"
                              onClick={() => setShowAllMeetings(true)}
                              className="text-[11px] font-medium text-primary hover:underline"
                            >
                              View all
                            </button>
                          )}
                        </div>
                        <div className="space-y-2">
                          {clientMeetings.slice(0, MEETING_HISTORY_LIMIT).map(m => (
                            <MeetingRow key={m.id} meeting={m} />
                          ))}
                          {clientMeetings.length === 0 && (
                            <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border p-3.5">
                              No meetings recorded yet
                            </p>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                          <Camera className="w-3.5 h-3.5 text-muted-foreground" />
                          Visit Photos
                        </p>
                        {meetingPhotos.length > 0 ? (
                          <div className="grid grid-cols-3 gap-2">
                            {meetingPhotos.slice(0, 6).map((m, i) => {
                              const submittedBy = m.recorder?.full_name ?? m.agent?.full_name ?? 'Unknown'
                              const dateLabel = format(new Date(m.meeting_date), 'MMM d, yyyy')
                              const remaining = meetingPhotos.length - 6
                              const isLastVisible = i === 5 && remaining > 0
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
                                  {isLastVisible ? (
                                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                      <span className="text-xs font-semibold text-white">+{remaining}</span>
                                    </div>
                                  ) : (
                                    <span className="absolute bottom-1 right-1 text-[9px] bg-black/60 text-white rounded px-1 py-0.5">
                                      {format(new Date(m.meeting_date), 'MMM d')}
                                    </span>
                                  )}
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
                    </div>
                  </div>
                </div>

                <div className="shrink-0 border-t border-border bg-muted/30 px-6 py-3 flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                      <span className="text-[9px] font-bold text-primary">
                        {client.agent?.full_name?.charAt(0)}
                      </span>
                    </div>
                    <span>{client.agent?.full_name}</span>
                  </div>
                  <span>Added {format(new Date(client.created_at), 'MMM d, yyyy')}</span>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={showAllMeetings} onOpenChange={handleShowAllMeetingsChange}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
            <DialogTitle className="text-base">Meeting History</DialogTitle>
            {client && <p className="text-xs text-muted-foreground">{client.company_name}</p>}
          </DialogHeader>
          {client && (() => {
            const allMeetings = mockMeetings
              .filter(m => m.client_id === client.id)
              .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
            const filteredMeetings = allMeetings.filter(m => outcomeFilter === 'all' || m.outcome === outcomeFilter)

            return (
              <>
                <div className="shrink-0 px-5 py-3 border-b border-border">
                  <Select value={outcomeFilter} onValueChange={v => setOutcomeFilter((v as MeetingOutcome | 'all') ?? 'all')}>
                    <SelectTrigger className="w-full h-9 bg-card border-border">
                      <SelectValue placeholder="Filter by outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Outcomes</SelectItem>
                      <SelectItem value="successful">{OUTCOME_LABEL.successful}</SelectItem>
                      <SelectItem value="follow_up">{OUTCOME_LABEL.follow_up}</SelectItem>
                      <SelectItem value="no_decision">{OUTCOME_LABEL.no_decision}</SelectItem>
                      <SelectItem value="lost_opportunity">{OUTCOME_LABEL.lost_opportunity}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-2">
                  {filteredMeetings.map(m => <MeetingRow key={m.id} meeting={m} />)}
                  {filteredMeetings.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-6">No meetings match this filter</p>
                  )}
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
    </>
  )
}
