'use client'

import { Badge } from '@/components/ui/badge'
import { additionalAckState } from '@/lib/collection'
import { ADDITIONAL_ACK_LABEL, ADDITIONAL_ACK_TONE, TONE_CLASS } from '@/lib/status-styles'
import type { CollectionVisit } from '@/types'
import { Zap } from 'lucide-react'

/**
 * The mark an "additional" store carries wherever it appears on the Collection
 * page — a purple "Additional" tag plus, optionally, its Delivered/Viewed/Pending
 * acknowledgment state (migrations 068/069). Renders nothing for a normal store,
 * so callers can drop it into any row unconditionally.
 *
 * One component for all three surfaces (day board, activity table, detail dialog)
 * so the vocabulary can never drift between them.
 */
export function AdditionalBadge({
  visit,
  showAck = true,
  className,
}: {
  visit: CollectionVisit
  /** Whether to append the Delivered/Viewed/Pending pill. */
  showAck?: boolean
  className?: string
}) {
  const ack = additionalAckState(visit)
  if (ack === null) return null

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      <Badge variant="tone" className={`gap-1 text-[10px] ${TONE_CLASS.purple}`}>
        <Zap className="h-3 w-3" /> Additional
      </Badge>
      {showAck && (
        <Badge variant="tone" className={`text-[10px] ${TONE_CLASS[ADDITIONAL_ACK_TONE[ack]]}`}>
          {ADDITIONAL_ACK_LABEL[ack]}
        </Badge>
      )}
    </span>
  )
}
