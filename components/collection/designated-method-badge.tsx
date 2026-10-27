'use client'

import { Badge } from '@/components/ui/badge'
import { TONE_CLASS, paymentMethodLabel } from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { Lock } from 'lucide-react'

/**
 * The mark a store carries when the office has set its payment method in
 * advance (migration 143) — today only "Counter". Renders nothing when the
 * collector is free to choose, so callers can drop it into any row
 * unconditionally, the same way AdditionalBadge works.
 *
 * Shown even after collection: it explains why a store was recorded the way it
 * was, which is the question someone asks when reading the history.
 */
export function DesignatedMethodBadge({
  visit,
  className,
}: {
  visit: CollectionVisit
  className?: string
}) {
  if (!visit.designated_payment_method) return null

  return (
    <Badge
      variant="tone"
      title="Set by the office — the collector can only record this method"
      className={`gap-1 text-[10px] ${TONE_CLASS.neutral} ${className ?? ''}`}
    >
      <Lock className="h-3 w-3" /> {paymentMethodLabel(visit.designated_payment_method)}
    </Badge>
  )
}
