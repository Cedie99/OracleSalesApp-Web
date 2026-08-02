'use client'

import type { ReactNode } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Camera, Maximize2, PenLine } from 'lucide-react'
import { format } from 'date-fns'

/**
 * Full-size viewing for the proof captures Collection and Delivery carry.
 *
 * The detail dialogs have always drawn these as 4:3 thumbnails, which answers
 * "did the capture arrive?" — the only question worth asking while every URL in
 * the table was still null. Since mobile started uploading real images (Phase
 * 2b/2c, 2026-07-29) the office's actual question is "what does it say?", and a
 * GCash confirmation screenshot or a signed remittance slip is unreadable at
 * tile size. Hence a lightbox rather than a bigger tile.
 */

export interface LightboxPhoto {
  /** Public URL in `collection-proofs` / `delivery-proofs`. */
  url: string
  /** Which capture this is — "Payment photo", "Receiver signature". */
  label: string
  /** Who brought it back and when. Resolved by the caller, which has the joins. */
  caption?: string
  /**
   * A signature is a thin wide strip of dark ink on white. Letterboxing it
   * against the black used for photos hides the strokes at the edges, and
   * cropping it to fill a tile cuts the loops off.
   */
  signature?: boolean
}

interface PhotoLightboxProps {
  photo: LightboxPhoto | null
  onOpenChange: (open: boolean) => void
}

/**
 * Render this as a **sibling** of the dialog that opens it, never nested inside
 * it — a Dialog inside a Dialog dismisses both when the inner one closes, which
 * would drop the admin out of the record they were reading.
 */
export function PhotoLightbox({ photo, onOpenChange }: PhotoLightboxProps) {
  return (
    <Dialog open={!!photo} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
        {photo && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt={photo.label}
              className={`w-full max-h-[75vh] object-contain ${
                photo.signature ? 'bg-white' : 'bg-black'
              }`}
            />
            <div className="flex items-center justify-between gap-3 p-3 text-xs">
              <span className="font-medium text-foreground">{photo.label}</span>
              {photo.caption && (
                <span className="truncate text-muted-foreground">{photo.caption}</span>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface ProofTileProps {
  label: string
  url: string | null
  /**
   * The capture is one the phone should have blocked submission without, so an
   * empty tile is a hole in the record rather than a legitimate absence.
   */
  missing?: boolean
  signature?: boolean
  /** Appended after the label, e.g. " — not signed". */
  note?: string
  caption?: string
  onOpen: (photo: LightboxPhoto) => void
}

/** One capture in the detail dialogs' proof grid, clickable when it has an image. */
export function ProofTile({
  label, url, missing = false, signature = false, note, caption, onOpen,
}: ProofTileProps) {
  return (
    <div className="space-y-1">
      {url ? (
        <button
          type="button"
          onClick={() => onOpen({ url, label, caption, signature })}
          aria-label={`View ${label} full size`}
          className="group relative block w-full cursor-pointer overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={label}
            className={`w-full aspect-4/3 ${
              signature ? 'object-contain bg-muted/30 p-1' : 'object-cover'
            }`}
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
            <Maximize2 className="w-4 h-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
        </button>
      ) : (
        <div
          className={`flex w-full aspect-4/3 items-center justify-center rounded-lg border border-dashed ${
            missing ? 'border-destructive/40' : 'border-border'
          }`}
        >
          {signature ? (
            <PenLine className="w-4 h-4 text-muted-foreground opacity-50" />
          ) : (
            <Camera className="w-4 h-4 text-muted-foreground opacity-50" />
          )}
        </div>
      )}
      <p className="text-[10px] leading-tight text-muted-foreground">
        {label}
        {note}
      </p>
    </div>
  )
}

/** "Marisa Cruz · Jul 29, 4:12 PM" — who a capture came from, for the lightbox footer. */
export function captionFor(by: string | null | undefined, at: string): string {
  const when = format(new Date(at), 'MMM d, h:mm a')
  return by ? `${by} · ${when}` : when
}

interface RemittanceProofThumbProps {
  url: string
  label: string
  caption: string
  signature?: boolean
  icon: ReactNode
  onOpen: (photo: LightboxPhoto) => void
}

/**
 * The compact thumbnail the remittance cards use, wider and shorter than
 * `ProofTile` because a card packs two of them beside the money figures rather
 * than filling a dialog.
 */
export function RemittanceProofThumb({
  url, label, caption, signature = false, icon, onOpen,
}: RemittanceProofThumbProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen({ url, label, caption, signature })}
      aria-label={`View ${label} full size`}
      className="group min-w-0 flex-1 cursor-pointer space-y-1 text-left outline-none"
    >
      <span className="relative block overflow-hidden rounded-lg border border-border group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={label}
          className={`h-16 w-full ${signature ? 'object-contain bg-muted/30 p-1' : 'object-cover'}`}
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
          <Maximize2 className="w-3.5 h-3.5 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
      </span>
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon} {label}
      </span>
    </button>
  )
}
