'use client'

import { Badge } from '@/components/ui/badge'
import { TONE_CLASS } from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { HandCoins } from 'lucide-react'

/**
 * The mark a store carries when it was listed as a down payment (migration
 * 145) — the customer decides how much, so its amount due reads ₱0. Renders
 * nothing otherwise, so callers can drop it into any row unconditionally, the
 * same way DesignatedMethodBadge works.
 */
export function DownPaymentBadge({
  visit,
  className,
}: {
  visit: CollectionVisit
  className?: string
}) {
  if (!visit.is_down_payment) return null

  return (
    <Badge
      variant="tone"
      title="Down payment — the customer decides how much to pay"
      className={`gap-1 text-[10px] ${TONE_CLASS.amber} ${className ?? ''}`}
    >
      <HandCoins className="h-3 w-3" /> Down payment
    </Badge>
  )
}
