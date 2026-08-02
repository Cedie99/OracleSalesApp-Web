'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { WorkerAvatar } from '@/components/stop-number'
import { claimAge, isStaleClaim, type Claimable } from '@/lib/claims'
import { TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import { AlertTriangle, LockOpen, Navigation } from 'lucide-react'

/**
 * How a claim looks on the day boards, shared by Collection and Delivery
 * because the state means exactly the same thing on both (migration 046).
 *
 * A claim is a **hard lock**: while it is held nobody else may work the stop,
 * and the holder may hold only one at a time. Both halves matter to the admin,
 * and neither is obvious from a line of small text — so a claimed row is tinted
 * and rule-marked down its leading edge rather than merely annotated.
 */

/** What the holder is called in the copy — the only thing that differs by module. */
type Holder = 'collector' | 'driver'

/**
 * Row classes for a claimed stop: a coloured leading rule plus a wash, so the
 * lock is legible while scanning a list rather than only on the row being read.
 * Returns empty for an unclaimed row, which should look like nothing at all.
 *
 * The rule stays brand/red rather than taking the holder's personal colour: this
 * mark answers "is this locked, and is the lock stale", which is a property of
 * the row. WHO holds it is carried by the avatar and the numbered badge, which
 * are the per-person marks. Tinting the rule per person would make a stale claim
 * — the one thing on this board that needs an admin — stop looking urgent.
 */
export function claimRowClass(row: Claimable, claimed: boolean): string {
  if (!claimed) return ''
  // Rounded, not square. The tint and its leading rule sit inside a rounded
  // list container, so square corners collided with the container's radius and
  // left visible points at the top and bottom of the claimed block. Rounding
  // makes a claimed row read as a highlighted pill within the list instead.
  return isStaleClaim(row)
    ? 'rounded-lg border-l-2 border-l-destructive bg-destructive/5'
    : 'rounded-lg border-l-2 border-l-primary bg-primary/5'
}

/**
 * "On the way · Marisa Cruz · 12m", or the red past-day variant.
 *
 * Distinct from the "worked by" contributors above it on the card, which are
 * recorded after the fact — this one is live, and it is blocking someone.
 */
export function ClaimLine({
  row, holder, color,
}: {
  row: Claimable
  holder: Holder
  /**
   * The holder's personal colour, when the board knows it. Adds their ringed
   * avatar so two claims by the same person are matchable at a glance without
   * reading both names — which is the whole point on a card where one person may
   * hold a stop while several others are working the same list.
   */
  color?: string
}) {
  const stale = isStaleClaim(row)
  const age = claimAge(row)

  return (
    <div
      className={`flex items-center gap-1 mt-1 text-[10px] font-medium ${
        stale ? TONE_TEXT.red : TONE_TEXT.brand
      }`}
    >
      {stale ? (
        <AlertTriangle className="w-3 h-3 shrink-0" />
      ) : (
        <Navigation className="w-3 h-3 shrink-0" />
      )}
      {color && <WorkerAvatar name={row.claimed_by_name} color={color} />}
      <span className="truncate">
        {stale ? 'Held since an earlier day by ' : 'On the way · '}
        {row.claimed_by_name ?? `a ${holder}`}
      </span>
      {age && <span className="shrink-0 tabular-nums text-muted-foreground">{age}</span>}
    </div>
  )
}

/**
 * The admin's release control.
 *
 * Deliberately **not** the `Navigation` arrow the line above uses: that glyph
 * means "a claim exists", and reusing it for the button made the only action on
 * the row read as a second copy of the indicator. An opening padlock says what
 * pressing it does — the lock comes off and the stop goes back in the pool.
 */
export function ReleaseClaimButton({
  row, holder, target, onRelease,
}: {
  row: Claimable
  holder: Holder
  /** What is being unlocked, for the screen-reader label — a store or a PO number. */
  target: string
  onRelease: () => void
}) {
  const stale = isStaleClaim(row)

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Release ${row.claimed_by_name ?? `the ${holder}`}'s claim on ${target}`}
      title={
        stale
          ? 'Held since an earlier day — release it so they can claim again'
          : 'Release this claim'
      }
      onClick={onRelease}
    >
      <LockOpen className={stale ? TONE_TEXT.red : undefined} />
    </Button>
  )
}

/**
 * Day-header count of claims stuck from a previous day.
 *
 * Claims never expire and each person may hold exactly one, so a stop claimed at
 * 4pm and never worked locks that person out of the next morning's list until an
 * admin clears it. Nothing in the migrations closes out a day, so nothing else
 * will surface it.
 */
export function StaleClaimBadge({ count }: { count: number }) {
  if (count === 0) return null

  return (
    <Badge variant="tone" className={`shrink-0 ${TONE_CLASS.red}`}>
      <AlertTriangle className="w-3 h-3" />
      {count} stuck
    </Badge>
  )
}
