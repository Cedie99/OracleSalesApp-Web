'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PendingNote } from '@/components/pending-note'
import {
  PhotoLightbox, ProofTile, RemittanceProofThumb, captionFor, type LightboxPhoto,
} from '@/components/photo-lightbox'
import { additionalAckState, remainingBalance, visitProofs } from '@/lib/collection'
import { peso, pesoDelta } from '@/lib/money'
import {
  ADDITIONAL_ACK_LABEL, ADDITIONAL_ACK_TONE,
  PAYMENT_METHOD_TONE, TONE_CLASS, TONE_TEXT, paymentMethodLabel,
  VISIT_STATUS_LABEL, VISIT_STATUS_TONE,
} from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { AlertTriangle, Banknote, Camera, Clock, MapPin, UserCog, Zap } from 'lucide-react'
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
  const ack = additionalAckState(visit)
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

        {/* Additional-store notice: whether the urgent add reached the field.
            Only shown for a store the admin marked additional (migrations
            068/069). Delivered/Viewed only leave "Not yet" once mobile stamps
            the ack columns via its RPCs. */}
        {ack && (
          <div className="rounded-xl border border-[var(--badge-purple-fg)]/30 bg-[var(--badge-purple-bg)]/40 p-3 space-y-1.5 text-xs">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Additional store
              <Badge variant="tone" className={`ml-auto ${TONE_CLASS[ADDITIONAL_ACK_TONE[ack]]}`}>
                {ADDITIONAL_ACK_LABEL[ack]}
              </Badge>
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Added to an already-published list and pushed to the collectors. The
              two timestamps say whether the notice reached a phone and was opened —
              if it stays Pending, no phone has it yet and a call may be faster.
            </p>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Delivered to a phone</span>
              <span className="font-medium">
                {visit.additional_received_at
                  ? format(new Date(visit.additional_received_at), 'MMM d, h:mm a')
                  : 'Not yet'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Opened by a collector</span>
              <span className="font-medium">
                {visit.additional_seen_at
                  ? format(new Date(visit.additional_seen_at), 'MMM d, h:mm a')
                  : 'Not yet'}
              </span>
            </div>
          </div>
        )}

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
            <span className="text-muted-foreground">
              {visit.status === 'partial' ? 'Collected so far' : 'Amount received'}
            </span>
            <span className="tabular-nums font-medium">
              {visit.amount_collected === null ? '—' : peso(visit.amount_collected)}
            </span>
          </div>
          {/* The reason a partial store stays on the list: it still owes this. */}
          {visit.status === 'partial' && (
            <div className="flex justify-between font-semibold">
              <span className={TONE_TEXT.amber}>Balance still owed</span>
              <span className={`tabular-nums ${TONE_TEXT.amber}`}>{peso(remainingBalance(visit))}</span>
            </div>
          )}
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

        {/* Installment history — one row per handover, each with its own proof
            (migration 070). Only present on a store paid in parts; a single-visit
            store carries no payment rows and this is skipped. This is where the
            admin verifies each partial's capture, since the top-level proof grid
            only shows the latest one. */}
        {visit.payments && visit.payments.length > 0 && (
          <div className="rounded-xl bg-muted/50 p-3 space-y-2 text-xs">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <Banknote className="w-3.5 h-3.5" /> Payments ({visit.payments.length})
            </p>
            <div className="space-y-2.5">
              {visit.payments.map(p => (
                <div
                  key={p.id}
                  className="border-t border-border/60 pt-2 first:border-t-0 first:pt-0 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="tabular-nums font-medium text-foreground">{peso(p.amount)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {format(new Date(p.paid_at), 'MMM d, h:mm a')}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {paymentMethodLabel(p.payment_method)} · {p.collector?.full_name ?? '—'}
                  </p>
                  {(p.payment_photo_url || p.delivery_receipt_photo_url) && (
                    <div className="flex gap-2">
                      {p.payment_photo_url && (
                        <RemittanceProofThumb
                          url={p.payment_photo_url}
                          label="Payment"
                          caption={captionFor(p.collector?.full_name, p.paid_at)}
                          icon={<Camera className="w-3 h-3" />}
                          onOpen={onOpenPhoto}
                        />
                      )}
                      {p.delivery_receipt_photo_url && (
                        <RemittanceProofThumb
                          url={p.delivery_receipt_photo_url}
                          label="Receipt"
                          caption={captionFor(p.collector?.full_name, p.paid_at)}
                          icon={<Camera className="w-3 h-3" />}
                          onOpen={onOpenPhoto}
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

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
