'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PendingNote } from '@/components/pending-note'
import {
  PhotoLightbox, ProofTile, captionFor, type LightboxPhoto,
} from '@/components/photo-lightbox'
import { visitProofs } from '@/lib/collection'
import { peso, pesoDelta } from '@/lib/money'
import {
  PAYMENT_METHOD_TONE, TONE_CLASS, TONE_TEXT, paymentMethodLabel,
  VISIT_STATUS_LABEL, VISIT_STATUS_TONE,
} from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { AlertTriangle, Camera, Clock, MapPin, UserCog } from 'lucide-react'
import { format } from 'date-fns'

interface VisitDetailDialogProps {
  visit: CollectionVisit | null
  onOpenChange: (open: boolean) => void
  /** Name of the admin who put the store on the list, resolved by the caller. */
  listedByName: string | null
}

/**
 * One store, from the moment it was listed through to what the collector who
 * picked it up brought back — including whether both required captures arrived.
 */
export function VisitDetailDialog({ visit, onOpenChange, listedByName }: VisitDetailDialogProps) {
  const [photo, setPhoto] = useState<LightboxPhoto | null>(null)

  return (
    <>
      <Dialog open={!!visit} onOpenChange={open => !open && onOpenChange(false)}>
        <DialogContent className="max-w-md">
          {visit && (
            <VisitDetail visit={visit} listedByName={listedByName} onOpenPhoto={setPhoto} />
          )}
        </DialogContent>
      </Dialog>

      {/* A sibling, not a child — see PhotoLightbox. */}
      <PhotoLightbox photo={photo} onOpenChange={open => !open && setPhoto(null)} />
    </>
  )
}

function VisitDetail({
  visit, listedByName, onOpenPhoto,
}: {
  visit: CollectionVisit
  listedByName: string | null
  onOpenPhoto: (photo: LightboxPhoto) => void
}) {
  const proofs = visitProofs(visit)
  // Only captures this payment method actually asked for. Counter and
  // delivery-receipt payments take no separate receipt photo (mobile,
  // 2026-08-01), so counting every empty slot would send the admin chasing a
  // collector for something their app never offered to take.
  const missing = visit.status === 'collected'
    ? proofs.filter(p => p.required && !p.url)
    : []
  const shortfall =
    visit.status === 'collected' && visit.amount_collected !== null
      ? visit.amount_collected - visit.amount_due
      : 0

  return (
    <>
      <DialogHeader>
        <DialogTitle>{visit.client?.company_name}</DialogTitle>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant="tone" className={TONE_CLASS[VISIT_STATUS_TONE[visit.status]]}>
            {VISIT_STATUS_LABEL[visit.status]}
          </Badge>
          {visit.payment_method && (
            <Badge variant="tone" className={TONE_CLASS[PAYMENT_METHOD_TONE[visit.payment_method]]}>
              {paymentMethodLabel(visit.payment_method)}
            </Badge>
          )}
        </div>

        {/* Published by the office */}
        <div className="rounded-xl bg-muted/50 p-3 space-y-1.5 text-xs">
          <p className="font-medium text-foreground flex items-center gap-1.5">
            <UserCog className="w-3.5 h-3.5" /> Listed
          </p>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Collection day</span>
            <span className="font-medium">{format(new Date(visit.scheduled_for), 'MMM d, yyyy')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Listed by</span>
            <span className="font-medium">{listedByName ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount due</span>
            <span className="tabular-nums font-medium">{peso(visit.amount_due)}</span>
          </div>
        </div>

        {/* Brought back by whichever collector picked it up */}
        <div className="rounded-xl bg-muted/50 p-3 space-y-1.5 text-xs">
          <p className="font-medium text-foreground flex items-center gap-1.5">
            <Camera className="w-3.5 h-3.5" /> Collected
          </p>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Collected by</span>
            <span className="font-medium">
              {visit.collector?.full_name ?? 'Not yet picked up'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount received</span>
            <span className="tabular-nums font-medium">
              {visit.amount_collected === null ? '—' : peso(visit.amount_collected)}
            </span>
          </div>
          {shortfall !== 0 && (
            <>
              <div className={`flex justify-between font-semibold ${TONE_TEXT.red}`}>
                <span>Against due</span>
                <span className="tabular-nums">{pesoDelta(shortfall)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed pt-0.5">
                The collector was not shown the due amount, so this gap is what the
                store paid — not a miscount to hold them to.
              </p>
            </>
          )}
        </div>

        {/* Which captures are required depends on the payment method — see
            visitProofs. A capture that arrived but is no longer required (an
            older Counter visit's receipt photo) is still shown. */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">Proof captures</p>
          {missing.length > 0 && (
            <p className={`flex items-center gap-1.5 text-[11px] font-medium ${TONE_TEXT.red}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {missing.length === 1 ? '1 required capture is' : `${missing.length} required captures are`} missing
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {proofs.map(proof => (
              <ProofTile
                key={proof.label}
                label={proof.label}
                url={proof.url}
                signature={proof.signature}
                missing={visit.status === 'collected' && proof.required}
                caption={captionFor(visit.collector?.full_name, visit.visited_at ?? visit.scheduled_for)}
                onOpen={onOpenPhoto}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Auto-captured</p>
          <p className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            {visit.gps_lat !== null
              ? `${visit.gps_lat.toFixed(4)}° N, ${visit.gps_lng?.toFixed(4)}° E`
              : 'No GPS captured'}
          </p>
          <p className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            {visit.visited_at
              ? format(new Date(visit.visited_at), 'MMM d, yyyy · h:mm a')
              : 'Not yet visited'}
          </p>
        </div>

        {visit.rescheduled_to && (
          <p className="text-xs">
            <span className="text-muted-foreground">Rescheduled to </span>
            <span className="font-medium">
              {format(new Date(visit.rescheduled_to), 'MMM d, yyyy')}
            </span>
          </p>
        )}

        {visit.remarks && (
          <p className="text-xs">
            <span className="text-muted-foreground">Remarks: </span>
            {visit.remarks}
          </p>
        )}

        {visit.status === 'collected' && (
          <PendingNote label="SMS pending">
            The customer&apos;s payment-confirmation SMS is part of this flow, but no
            provider has been chosen — so nothing is sent yet and no delivery
            status is shown here.
          </PendingNote>
        )}
      </div>
    </>
  )
}
