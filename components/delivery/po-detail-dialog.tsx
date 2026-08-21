'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  PhotoLightbox, ProofTile, RemittanceProofThumb, captionFor, type LightboxPhoto,
} from '@/components/photo-lightbox'
import { dwellMinutes, poProofs, remainingCod } from '@/lib/delivery'
import { peso } from '@/lib/money'
import {
  DELIVERY_STATUS_LABEL, DELIVERY_STATUS_TONE, PAYMENT_METHOD_TONE, paymentMethodLabel,
  TONE_CLASS, TONE_TEXT,
} from '@/lib/status-styles'
import type { PurchaseOrder } from '@/types'
import { StoreLocationPanel } from '@/components/maps/store-location-panel'
import { AlertTriangle, Banknote, Camera, Clock, MapPin, PackageX, Truck, UserCog } from 'lucide-react'

import { format } from 'date-fns'

interface PoDetailDialogProps {
  po: PurchaseOrder | null
  onOpenChange: (open: boolean) => void
  /** Name of the admin who put the PO on the list, resolved by the caller. */
  listedByName: string | null
}

/**
 * One PO, from the moment it was listed through to what the driver who took it
 * brought back — including whether the required captures arrived.
 */
export function PoDetailDialog({ po, onOpenChange, listedByName }: PoDetailDialogProps) {
  const [photo, setPhoto] = useState<LightboxPhoto | null>(null)

  return (
    <>
      <Dialog open={!!po} onOpenChange={open => !open && onOpenChange(false)}>
        <DialogContent className="max-w-md">
          {po && <PoDetail po={po} listedByName={listedByName} onOpenPhoto={setPhoto} />}
        </DialogContent>
      </Dialog>

      {/* A sibling, not a child — see PhotoLightbox. */}
      <PhotoLightbox photo={photo} onOpenChange={open => !open && setPhoto(null)} />
    </>
  )
}

function PoDetail({
  po, listedByName, onOpenPhoto,
}: {
  po: PurchaseOrder
  listedByName: string | null
  onOpenPhoto: (photo: LightboxPhoto) => void
}) {
  const proofs = poProofs(po)
  const missing = proofs.filter(p => p.required && !p.url)
  const run = po.driver_id !== null
  const dwell = dwellMinutes(po)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{po.po_number}</DialogTitle>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="tone" className={TONE_CLASS[DELIVERY_STATUS_TONE[po.status]]}>
            {DELIVERY_STATUS_LABEL[po.status]}
          </Badge>
          {po.cod_method && (
            <Badge variant="tone" className={TONE_CLASS[PAYMENT_METHOD_TONE[po.cod_method]]}>
              COD · {paymentMethodLabel(po.cod_method)}
            </Badge>
          )}
        </div>

        <div>
          <p className="font-medium text-foreground">{po.client?.company_name}</p>
          <p className="text-xs text-muted-foreground">{po.area}</p>
        </div>

        {/* Published by the office */}
        <div className="rounded-xl bg-muted/50 p-3 space-y-1.5 text-xs">
          <p className="font-medium text-foreground flex items-center gap-1.5">
            <UserCog className="w-3.5 h-3.5" /> Listed
          </p>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivery day</span>
            <span className="font-medium">{format(new Date(po.scheduled_for), 'MMM d, yyyy')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Listed by</span>
            <span className="font-medium">{listedByName ?? '—'}</span>
          </div>
          {po.cod && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">COD due</span>
              <span className="tabular-nums font-medium">{peso(po.cod_due ?? 0)}</span>
            </div>
          )}
        </div>

        {/* Brought back by whichever driver took it */}
        <div className="rounded-xl bg-muted/50 p-3 space-y-1.5 text-xs">
          <p className="font-medium text-foreground flex items-center gap-1.5">
            <Truck className="w-3.5 h-3.5" /> Run
          </p>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivered by</span>
            <span className="font-medium">{po.driver?.full_name ?? 'Not yet taken'}</span>
          </div>
          {run && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Truck plate</span>
                <span className="font-medium">{po.truck_plate ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stop in the run</span>
                <span className="tabular-nums font-medium">
                  {po.sequence_no ? `#${po.sequence_no}` : '—'}
                </span>
              </div>
              {/* The trip report's TIME-IN / TIME-OUT pair, and what it adds up to. */}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time in — out</span>
                <span className="tabular-nums font-medium">
                  {po.time_in ? format(new Date(po.time_in), 'h:mm a') : '—'}
                  {' — '}
                  {po.time_out ? format(new Date(po.time_out), 'h:mm a') : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time at the stop</span>
                <span className="tabular-nums font-medium">
                  {dwell === null ? '—' : `${dwell} min`}
                </span>
              </div>
            </>
          )}
          {po.cod && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {po.status === 'partial' ? 'COD collected so far' : 'COD collected'}
              </span>
              <span className="tabular-nums font-medium">
                {po.cod_amount === null ? '—' : peso(po.cod_amount)}
              </span>
            </div>
          )}
          {/* The reason a partial PO stays on the trip list: it still owes this. */}
          {po.status === 'partial' && (
            <div className="flex justify-between font-semibold">
              <span className={TONE_TEXT.amber}>COD balance still owed</span>
              <span className={`tabular-nums ${TONE_TEXT.amber}`}>{peso(remainingCod(po))}</span>
            </div>
          )}
          {po.cod && po.cod_amount !== null && po.status !== 'partial' && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">COD remitted</span>
              <span className={`font-medium ${po.cod_remitted ? '' : TONE_TEXT.amber}`}>
                {po.cod_remitted ? 'Handed over' : 'Still with the driver'}
              </span>
            </div>
          )}
          {/* Optional since 2026-07-25 — customers often refuse to give a name,
              so an empty one is the expected case, not a hole. */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Received by</span>
            <span className="font-medium">
              {po.receiver_name ?? <span className="text-muted-foreground">Not given (optional)</span>}
            </span>
          </div>
        </div>

        {/* COD installment history — one row per handover, each with its own proof
            (migration 073). Only present on a PO whose COD was paid in parts; a
            PO paid in one go carries no payment rows and this is skipped. This is
            where the admin verifies each installment's capture, since the proof
            grid below only shows the latest one. */}
        {po.cod_payments && po.cod_payments.length > 0 && (
          <div className="rounded-xl bg-muted/50 p-3 space-y-2 text-xs">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <Banknote className="w-3.5 h-3.5" /> COD payments ({po.cod_payments.length})
            </p>
            <div className="space-y-2.5">
              {po.cod_payments.map(p => (
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
                    {paymentMethodLabel(p.payment_method)} · {p.driver?.full_name ?? '—'}
                  </p>
                  {p.payment_photo_url && (
                    <div className="flex gap-2">
                      <RemittanceProofThumb
                        url={p.payment_photo_url}
                        label="COD payment"
                        caption={captionFor(p.driver?.full_name, p.paid_at)}
                        icon={<Camera className="w-3 h-3" />}
                        onOpen={onOpenPhoto}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {po.status === 'failed' && (
          <div className="rounded-xl bg-[var(--badge-red-bg)] p-3">
            <p className={`text-xs font-semibold ${TONE_TEXT.red} flex items-center gap-1.5`}>
              <PackageX className="w-3.5 h-3.5 shrink-0" />
              Backloaded — waiting on a decision
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              Nothing was handed over, so the goods rode back on the truck. The PO
              belongs to its delivery day and ends there — no countdown, and the
              driver cannot re-open it. To try again, someone here lists it on a
              later day.
            </p>
          </div>
        )}

        {proofs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Proof captures</p>
            {missing.length > 0 && (
              <p className={`flex items-center gap-1.5 text-[11px] font-medium ${TONE_TEXT.red}`}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {missing.length === 1 ? '1 required capture is' : `${missing.length} required captures are`} missing
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              {proofs.map(proof => {
                const isSignature = proof.label === 'Receiver signature'
                return (
                  <ProofTile
                    key={proof.label}
                    label={proof.label}
                    url={proof.url}
                    missing={proof.required}
                    signature={isSignature}
                    note={!proof.required && !proof.url ? ' — not signed' : undefined}
                    caption={captionFor(
                      isSignature ? po.receiver_name : po.driver?.full_name,
                      po.time_out ?? po.scheduled_for
                    )}
                    onOpen={onOpenPhoto}
                  />
                )
              })}
            </div>
          </div>
        )}

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Auto-captured</p>
          <p className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            {po.time_out
              ? format(new Date(po.time_out), 'MMM d, yyyy · h:mm a')
              : 'Not yet closed out'}
          </p>
          {/* Delivery gained GPS on 2026-07-27; the fix rides along with the
              stop's photo, so a stop with no photo has no location either. */}
          <p className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            {po.gps_lat !== null
              ? `${po.gps_lat.toFixed(4)}° N, ${po.gps_lng?.toFixed(4)}° E`
              : 'No GPS captured'}
          </p>
        </div>

        <StoreLocationPanel clientId={po.client_id} />

        {po.remarks && (
          <p className="text-xs">
            <span className="text-muted-foreground">Remarks: </span>
            {po.remarks}
          </p>
        )}
      </div>
    </>
  )
}
