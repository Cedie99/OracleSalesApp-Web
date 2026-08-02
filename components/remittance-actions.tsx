'use client'

import { Button } from '@/components/ui/button'
import type { RemittanceStatus } from '@/types'
import { Check, Loader2, RotateCcw, TriangleAlert } from 'lucide-react'

interface RemittanceActionsProps {
  status: RemittanceStatus
  /**
   * `amount_remitted - amount_collected`. Only decides which button leads —
   * see below for why it does not decide the status itself.
   */
  delta: number
  busy: boolean
  onSetStatus: (status: RemittanceStatus) => void
}

/**
 * Closing out one remittance — the admin half of the money trail, shared by
 * Collection and Delivery because the decision is identical on both.
 *
 * A submitted row is offered **both** outcomes, with the amounts choosing only
 * which one is styled as the default. Deriving the status from `delta` instead
 * would be wrong in both directions: an admin legitimately reconciles a row
 * whose totals disagree (the collector explained the gap and the office accepted
 * it), and legitimately flags one whose totals agree (the signature is missing,
 * or the signed proof doesn't match what was handed over). The arithmetic is
 * evidence; the status is a judgement, and only a person makes it.
 *
 * Settled rows keep a way back to `submitted` so a misclick isn't permanent.
 */
export function RemittanceActions({ status, delta, busy, onSetStatus }: RemittanceActionsProps) {
  if (busy) {
    return (
      <div className="flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Saving…
      </div>
    )
  }

  if (status === 'submitted') {
    const balanced = delta === 0
    return (
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          variant={balanced ? 'default' : 'outline'}
          onClick={() => onSetStatus('reconciled')}
        >
          <Check data-icon="inline-start" />
          Reconcile
        </Button>
        <Button
          size="sm"
          variant={balanced ? 'outline' : 'default'}
          onClick={() => onSetStatus('variance')}
        >
          <TriangleAlert data-icon="inline-start" />
          Flag variance
        </Button>
      </div>
    )
  }

  return (
    <div className="pt-1">
      <Button size="sm" variant="ghost" onClick={() => onSetStatus('submitted')}>
        <RotateCcw data-icon="inline-start" />
        Reopen
      </Button>
    </div>
  )
}
