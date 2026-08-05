'use client'

import { Badge } from '@/components/ui/badge'
import {
  INVITEE_KIND_LABEL,
  MANAGER_GATE_LABEL,
  MANAGER_GATE_TONE,
  TAG_ALONG_STATUS_LABEL,
  TAG_ALONG_STATUS_TONE,
  daysWaiting,
  managerGate,
} from '@/lib/tag-along'
import { TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import type { TagAlongRequest } from '@/types'
import { Hourglass, UserCheck, UserX, Users } from 'lucide-react'

/**
 * How a tag-along reads across the admin app (migrations 019-020, ADR-030).
 *
 * Shared rather than written per page so the manager/teammate distinction is
 * made once. A manager companion is a validation gate — pending, the meeting
 * reserves no cutoff slot; declined, it is excluded permanently. A teammate
 * companion is someone learning the round and gates nothing. Anywhere these two
 * appear as one number, the number is wrong.
 */

/**
 * The manager gate as a single glyph, for a dense flags column.
 *
 * Renders nothing when no manager was invited. That is the ordinary case, not a
 * missing approval, and a "no gate" mark on most rows would train the eye to
 * skip the column that carries the real ones. An hourglass rather than a person
 * icon for pending: what is notable is that it is waiting, not who on.
 */
export function ManagerGateIcon({ requests }: { requests: TagAlongRequest[] }) {
  const gate = managerGate(requests)
  if (gate === 'none') return null

  const Icon = gate === 'accepted' ? UserCheck : gate === 'declined' ? UserX : Hourglass
  const label = MANAGER_GATE_LABEL[gate]

  return (
    <Icon
      className={`w-3.5 h-3.5 shrink-0 ${TONE_TEXT[MANAGER_GATE_TONE[gate]]}`}
      aria-label={label}
    >
      <title>{label}</title>
    </Icon>
  )
}

/**
 * The companion names on a record, one line, for a table cell.
 *
 * Cancelled requests are dropped: the requester withdrew before anyone
 * answered, so nobody came and there is nothing to report.
 */
export function CompanionLine({ requests }: { requests: TagAlongRequest[] }) {
  const live = requests.filter(r => r.status !== 'cancelled')
  if (live.length === 0) return null

  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Users className="w-3 h-3 shrink-0" />
      <span className="truncate">
        {live.map(r => r.invitee_name ?? 'Unknown').join(', ')}
      </span>
    </p>
  )
}

/**
 * The full companion list for a detail panel: who, in what capacity, and where
 * their answer stands.
 *
 * A pending manager request also carries how long it has been waiting, because
 * that is the number that decides whether it needs chasing — and because these
 * never expire, so an unanswered one sits there indefinitely with nothing else
 * to mark its age.
 */
export function CompanionList({ requests }: { requests: TagAlongRequest[] }) {
  const live = requests.filter(r => r.status !== 'cancelled')
  if (live.length === 0) {
    return <p className="text-xs text-muted-foreground">No one tagged along.</p>
  }

  // Managers first — they are the ones with consequences attached.
  const ordered = [...live].sort((a, b) =>
    a.invitee_kind === b.invitee_kind ? 0 : a.invitee_kind === 'manager' ? -1 : 1
  )

  return (
    <div className="space-y-1.5">
      {ordered.map(r => {
        const waiting = r.status === 'pending' ? daysWaiting(r) : null
        return (
          <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-foreground font-medium truncate">
                {r.invitee_name ?? 'Unknown'}
              </span>
              <span className="text-muted-foreground"> · {INVITEE_KIND_LABEL[r.invitee_kind]}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {waiting != null && waiting > 0 && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {waiting}d
                </span>
              )}
              <Badge variant="tone" className={TONE_CLASS[TAG_ALONG_STATUS_TONE[r.status]]}>
                {TAG_ALONG_STATUS_LABEL[r.status]}
              </Badge>
            </div>
          </div>
        )
      })}
    </div>
  )
}
