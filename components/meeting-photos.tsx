'use client'

import { format } from 'date-fns'
import { Camera } from 'lucide-react'
import { ProofTile, captionFor, type LightboxPhoto } from '@/components/photo-lightbox'
import { meetingPhotos } from '@/lib/hooks/use-meetings'
import type { Meeting } from '@/types'

interface MeetingPhotoGridProps {
  meeting: Meeting
  /** Who took the photos — resolved by the caller, which has the joins. */
  by: string
  onOpen: (photo: LightboxPhoto) => void
}

/**
 * The meeting detail dialogs' photo section: the new-prospect selfie, or the
 * existing-client Start/End pair, each under its own capture time.
 *
 * Start and End side by side is the point for an existing-client visit — the
 * same place in both shots is someone who sat through the meeting, a different
 * storefront is someone who opened it at one client and closed it at another.
 * Renders nothing when the meeting has no photos, rather than an empty frame.
 */
export function MeetingPhotoGrid({ meeting, by, onOpen }: MeetingPhotoGridProps) {
  const photos = meetingPhotos(meeting)
  if (photos.length === 0) return null

  return (
    <div className="flex items-start gap-2 text-xs">
      <Camera className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground mb-1.5">{photos.length === 1 ? 'Photo' : 'Photos'}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-w-md">
          {photos.map(p => (
            <ProofTile
              key={p.kind}
              label={p.kind === 'visit' ? 'Visit photo' : `${p.label} photo`}
              note={p.capturedAt ? ` · ${format(new Date(p.capturedAt), 'h:mm a')}` : undefined}
              url={p.url}
              caption={captionFor(by, p.capturedAt ?? meeting.meeting_date)}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
