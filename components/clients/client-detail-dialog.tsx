'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CircularProgress } from '@/components/ui/circular-progress'
import { getQualifiedAgendaMilestones } from '@/lib/client-progress'
import { meetingGpsDriftMeters, meetingDurationMinutes } from '@/lib/hooks/use-meetings'
import { useTagAlongs, tagAlongsFor } from '@/lib/hooks/use-tag-alongs'
import { CompanionLine, ManagerGateIcon } from '@/components/tag-along-indicator'
import { formatDistanceMeters, formatDurationMinutes } from '@/lib/utils'
import { clientAddress, hasOfficePin, officePinSourceLabel } from '@/lib/client-info'
import type { Client, Meeting, MeetingOutcome, TagAlongRequest } from '@/types'
import { Building2, Phone, MapPin, User, CalendarCheck, Navigation, Camera, Pencil, Tag, X as XIcon, Clock, ChevronRight, FileText, ListChecks } from 'lucide-react'
import { format } from 'date-fns'
import {
  CHANNEL_TONE,
  CLIENT_STATUS_TONE,
  customerTypeBadge,
  meetingStageBadge,
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

const MeetingRouteMap = dynamic(() => import('@/components/maps/meeting-route-map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground bg-muted/40">
      Loading map…
    </div>
  ),
})

const LOCATION_TYPE_LABEL: Record<Meeting['location_type'], string> = {
  client_office: "Client's office",
  other: 'Other location',
}

const ONLINE_PLATFORM_LABEL: Record<NonNullable<Meeting['online_platform']>, string> = {
  zoom: 'Zoom',
  googlemeet: 'Google Meet',
}

function MeetingRow({ meeting, companions, onClick }: { meeting: Meeting; companions: TagAlongRequest[]; onClick: () => void }) {
  const submittedBy = meeting.recorder?.full_name ?? meeting.agent?.full_name ?? 'Unknown'
  // How far the agent was from where they opened the meeting when they closed
  // it. Only the ~20% of meetings carrying both fixes have one; the rest say
  // nothing rather than claim a match they can't support.
  const drift = formatDistanceMeters(meetingGpsDriftMeters(meeting))
  const stage = meetingStageBadge(meeting.client_status_at_meeting)
  const duration = formatDurationMinutes(meetingDurationMinutes(meeting))
  const startTime = meeting.start_captured_at ? format(new Date(meeting.start_captured_at), 'h:mm a') : null
  const endTime = meeting.end_captured_at ? format(new Date(meeting.end_captured_at), 'h:mm a') : null
  const hasStart = meeting.gps_lat != null && meeting.gps_lng != null
  const hasEnd = meeting.end_gps_lat != null && meeting.end_gps_lng != null
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 text-xs bg-muted/40 hover:bg-muted/70 rounded-md px-3 py-2 text-left transition-colors"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <CalendarCheck className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="truncate">{format(new Date(meeting.meeting_date), 'MMM d, yyyy')}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1 pl-[18px] text-muted-foreground">
          <User className="w-3 h-3 shrink-0" />
          <span className="truncate">{submittedBy}</span>
        </div>
        {/* What the client WAS at this visit — the one row on this dialog that
            is allowed to disagree with the stage pill in the header above it.
            Reading the history down, this is where a promotion becomes visible:
            three rows saying Prospect under a header saying New is the only
            record that the first three visits were never capped. Nothing else in
            the schema dates the change. */}
        <div className="flex items-center gap-1.5 mt-1 pl-[18px]" title={stage.title}>
          <Tag className="w-3 h-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground shrink-0">Was</span>
          <Badge variant="tone" className={`text-[10px] px-1.5 h-4 shrink-0 ${TONE_CLASS[stage.tone]}`}>
            {stage.label}
          </Badge>
          {!stage.capped && meeting.client_status_at_meeting && (
            <span className="text-muted-foreground/70 truncate">· not capped</span>
          )}
        </div>
        {(startTime || endTime) && (
          <div className="flex items-center gap-1.5 mt-1 pl-[18px] text-muted-foreground">
            <Clock className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {startTime ?? '—'} → {endTime ?? '—'}
              {duration && <> · <span className="text-foreground font-medium">{duration}</span></>}
            </span>
          </div>
        )}
        {(hasStart || hasEnd) && (
          <div className="flex items-center gap-1.5 mt-1 pl-[18px] text-muted-foreground">
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {hasStart && hasEnd ? (
                <>Start → End{drift && <> · <span className="text-foreground font-medium">{drift}</span></>}</>
              ) : (
                'Location captured'
              )}
            </span>
          </div>
        )}
        {/* Who else attended. On this list "who was there" is already the
            question the row above answers, so companions belong beside it
            rather than in a section of their own. */}
        <div className="mt-1 pl-[18px]">
          <CompanionLine requests={companions} />
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <ManagerGateIcon requests={companions} />
        <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[meeting.outcome]]}>
          {OUTCOME_LABEL[meeting.outcome]}
        </Badge>
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
    </button>
  )
}

function DetailLine({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-muted-foreground">{label}</p>
        <p className="text-foreground font-medium break-words">{value}</p>
      </div>
    </div>
  )
}

/** The map-and-details popup opened by clicking a Meeting History row. */
function MeetingDetailDialog({ meeting, companions, onOpenChange }: { meeting: Meeting | null; companions: TagAlongRequest[]; onOpenChange: (open: boolean) => void }) {
  const hasStart = meeting?.gps_lat != null && meeting?.gps_lng != null
  const hasEnd = meeting?.end_gps_lat != null && meeting?.end_gps_lng != null
  const start = meeting && hasStart ? { lat: meeting.gps_lat as number, lng: meeting.gps_lng as number, label: 'Start' } : null
  const end = meeting && hasEnd ? { lat: meeting.end_gps_lat as number, lng: meeting.end_gps_lng as number, label: 'End' } : null
  const drift = meeting ? formatDistanceMeters(meetingGpsDriftMeters(meeting)) : null
  const duration = meeting ? formatDurationMinutes(meetingDurationMinutes(meeting)) : null
  const startTime = meeting?.start_captured_at ? format(new Date(meeting.start_captured_at), 'h:mm a') : null
  const endTime = meeting?.end_captured_at ? format(new Date(meeting.end_captured_at), 'h:mm a') : null
  const submittedBy = meeting?.recorder?.full_name ?? meeting?.agent?.full_name ?? 'Unknown'

  return (
    <Dialog open={!!meeting} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden" showCloseButton={false}>
        {meeting && (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-3 flex-row items-center justify-between space-y-0">
              <div>
                <DialogTitle className="text-base">{format(new Date(meeting.meeting_date), 'MMMM d, yyyy')}</DialogTitle>
                <p className="text-xs text-muted-foreground">Meeting details</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="tone" className={TONE_CLASS[OUTCOME_TONE[meeting.outcome]]}>
                  {OUTCOME_LABEL[meeting.outcome]}
                </Badge>
                <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
                  <XIcon className="w-4 h-4" />
                  <span className="sr-only">Close</span>
                </DialogClose>
              </div>
            </DialogHeader>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-5 pt-5">
                <div className="h-64 bg-muted/40 rounded-lg border border-border overflow-hidden">
                  {start || end ? (
                    <MeetingRouteMap start={start} end={end} distanceLabel={drift} />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                      No location captured for this meeting
                    </div>
                  )}
                </div>
              </div>

              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-0 sm:[&>*:nth-child(odd)]:pr-6 sm:[&>*:nth-child(even)]:pl-6 sm:[&>*:nth-child(even)]:border-l sm:[&>*:nth-child(even)]:border-border">
                <DetailLine icon={User} label="Submitted by" value={submittedBy} />
                <DetailLine
                  icon={Clock}
                  label="Time"
                  value={startTime || endTime ? `${startTime ?? '—'} → ${endTime ?? '—'}` : 'Not captured'}
                />
                <DetailLine icon={Navigation} label="Duration" value={duration ?? 'Not captured'} />
                <DetailLine icon={MapPin} label="Distance start → end" value={drift ?? 'Not captured'} />
                <DetailLine
                  icon={Building2}
                  label="Meeting type"
                  value={
                    meeting.meeting_type === 'online'
                      ? `Online${meeting.online_platform ? ` · ${ONLINE_PLATFORM_LABEL[meeting.online_platform]}` : ''}`
                      : 'Face to face'
                  }
                />
                <DetailLine
                  icon={MapPin}
                  label="Location"
                  value={meeting.location_name || LOCATION_TYPE_LABEL[meeting.location_type]}
                />
                <DetailLine icon={User} label="Contact person" value={meeting.contact_person || 'Not recorded'} />
                <DetailLine icon={Phone} label="Contact position" value={meeting.contact_position || 'Not recorded'} />
              </div>

              <div className="px-5 pb-5 space-y-3">
                <div className="flex items-start gap-2 text-xs">
                  <ListChecks className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-muted-foreground mb-1.5">Agenda</p>
                    {meeting.agenda.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {meeting.agenda.map(a => (
                          <Badge key={a} variant="tone" className={TONE_CLASS.neutral}>{a}</Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-foreground">Not recorded</p>
                    )}
                  </div>
                </div>

                {meeting.remarks && (
                  <div className="flex items-start gap-2 text-xs">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground mb-1">Remarks</p>
                      <p className="text-foreground break-words">{meeting.remarks}</p>
                    </div>
                  </div>
                )}

                {companions.length > 0 && (
                  <div className="flex items-start gap-2 text-xs">
                    <Camera className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground mb-1">Companions</p>
                      <CompanionLine requests={companions} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface ClientDetailDialogProps {
  client: Client | null
  /**
   * All meetings, unfiltered — the dialog narrows to this client itself. Passed
   * in rather than fetched here so the parent owns one query and the dialog
   * stays usable from both the Supabase-backed and mock-backed pages.
   */
  meetings: Meeting[]
  onOpenChange: (open: boolean) => void
  canEdit?: boolean
  onEdit?: (client: Client) => void
}

const MEETING_HISTORY_LIMIT = 3
const PHOTO_LIMIT = 3

export function ClientDetailDialog({ client, meetings, onOpenChange, canEdit = false, onEdit }: ClientDetailDialogProps) {
  const [lightboxPhoto, setLightboxPhoto] = useState<{ url: string; date: string; by: string } | null>(null)
  const [showAllMeetings, setShowAllMeetings] = useState(false)
  const [showAllPhotos, setShowAllPhotos] = useState(false)
  const [outcomeFilter, setOutcomeFilter] = useState<MeetingOutcome | 'all'>('all')
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null)
  const { byMeeting: tagAlongsByMeetingId } = useTagAlongs()

  function handleOpenChange(open: boolean) {
    if (!open) { setShowAllMeetings(false); setShowAllPhotos(false); setSelectedMeeting(null) }
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
            const clientMeetings = meetings
              .filter(m => m.client_id === client.id)
              .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
            const meetingPhotos = clientMeetings.filter(m => m.photo_url)
            const progress = getQualifiedAgendaMilestones(client.id, meetings).percent

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
                          <Badge variant="tone" className={TONE_CLASS[customerTypeBadge(client.customer_type).tone]}>
                            {customerTypeBadge(client.customer_type).label}
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="rounded-lg border border-border p-4">
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Contact Person</p>
                          <div className="flex items-center gap-2 text-sm text-foreground">
                            <User className="w-4 h-4 text-muted-foreground shrink-0" />
                            <span className="truncate">{client.contact_person}</span>
                          </div>
                          {client.contact_position && (
                            <p className="text-xs text-muted-foreground mt-1 pl-6 truncate">{client.contact_position}</p>
                          )}
                        </div>
                        <div className="rounded-lg border border-border p-4">
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Phone Number</p>
                          <div className="flex items-center gap-2 text-sm text-foreground">
                            <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                            <span>{client.contact_number}</span>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-border p-4 space-y-3">
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground mb-1.5">Office Address</p>
                          <div className="flex items-start gap-2 text-sm text-foreground">
                            <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                            <span>{clientAddress(client).full ?? 'No address on file'}</span>
                          </div>
                          {clientAddress(client).landmark && (
                            <p className="text-xs text-muted-foreground mt-1 pl-6">
                              Landmark: {clientAddress(client).landmark}
                            </p>
                          )}
                        </div>

                        {/* The client's own office pin (migration 052), for the
                            rows that have one — never meeting GPS, which is
                            where the agent stood, not where the client is. */}
                        {hasOfficePin(client) && (
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
                                {client.office_lat!.toFixed(4)}, {client.office_lng!.toFixed(4)}
                              </span>
                              <span>· {officePinSourceLabel(client.office_pin_source)}</span>
                            </div>
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                            <Camera className="w-3.5 h-3.5 text-muted-foreground" />
                            Visit Photos
                          </p>
                          {meetingPhotos.length > PHOTO_LIMIT && (
                            <button
                              type="button"
                              onClick={() => setShowAllPhotos(true)}
                              className="text-[11px] font-medium text-primary hover:underline"
                            >
                              See all
                            </button>
                          )}
                        </div>
                        {meetingPhotos.length > 0 ? (
                          <div className="grid grid-cols-3 gap-2">
                            {meetingPhotos.slice(0, PHOTO_LIMIT).map(m => {
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
                                  <span className="absolute bottom-1 left-1 text-[9px] bg-black/60 text-white rounded px-1 py-0.5">
                                    {format(new Date(m.meeting_date), 'MMM d')}
                                  </span>
                                </button>
                              )
                            })}
                            {Array.from({ length: Math.max(0, PHOTO_LIMIT - meetingPhotos.length) }).map((_, i) => (
                              <div key={`photo-placeholder-${i}`} className="aspect-square rounded-md border border-border" />
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border p-3.5">
                            No visit photos yet
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Right column: progress + meeting history */}
                    <div className="md:col-span-2 space-y-4">
                      <div className="rounded-lg border border-border p-5 flex flex-col items-center">
                        <p className="text-[11px] font-medium text-muted-foreground mb-3 self-start">Progress</p>
                        <CircularProgress value={progress} size={140} strokeWidth={10} />
                      </div>

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
                              See all
                            </button>
                          )}
                        </div>
                        <div className="space-y-2">
                          {clientMeetings.slice(0, MEETING_HISTORY_LIMIT).map(m => (
                            <MeetingRow
                              key={m.id}
                              meeting={m}
                              companions={tagAlongsFor(tagAlongsByMeetingId, m.id)}
                              onClick={() => setSelectedMeeting(m)}
                            />
                          ))}
                          {clientMeetings.length === 0 && (
                            <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border p-3.5">
                              No meetings recorded yet
                            </p>
                          )}
                        </div>
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
            const allMeetings = meetings
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
                  {filteredMeetings.map(m => (
                    <MeetingRow
                      key={m.id}
                      meeting={m}
                      companions={tagAlongsFor(tagAlongsByMeetingId, m.id)}
                      onClick={() => setSelectedMeeting(m)}
                    />
                  ))}
                  {filteredMeetings.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-6">No meetings match this filter</p>
                  )}
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={showAllPhotos} onOpenChange={setShowAllPhotos}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
            <DialogTitle className="text-base">Visit Photos</DialogTitle>
            {client && <p className="text-xs text-muted-foreground">{client.company_name}</p>}
          </DialogHeader>
          {client && (() => {
            const allPhotos = meetings
              .filter(m => m.client_id === client.id && m.photo_url)
              .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())

            return (
              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                <div className="grid grid-cols-3 gap-2">
                  {allPhotos.map(m => {
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
                        <span className="absolute bottom-1 left-1 text-[9px] bg-black/60 text-white rounded px-1 py-0.5">
                          {format(new Date(m.meeting_date), 'MMM d')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
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

      <MeetingDetailDialog
        meeting={selectedMeeting}
        companions={selectedMeeting ? tagAlongsFor(tagAlongsByMeetingId, selectedMeeting.id) : []}
        onOpenChange={open => { if (!open) setSelectedMeeting(null) }}
      />
    </>
  )
}
