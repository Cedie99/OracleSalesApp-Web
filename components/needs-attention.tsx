'use client'

import { Button } from '@/components/ui/button'
import { TONE_TEXT } from '@/lib/status-styles'
import { AlertTriangle, CalendarX, ImageOff, LockOpen, PackageX, Wallet } from 'lucide-react'

/**
 * The rows an admin has to do something about, counted across EVERY row rather
 * than the current date window.
 *
 * ### Why this ignores the date filter
 *
 * Both boards default to a single day anchored on today, because that is the
 * live operating surface. The cost is that anything left behind on an earlier
 * day falls off screen — and a stuck claim is precisely the thing that never
 * resolves itself. Claims never expire, each person may hold exactly one, and
 * nothing in the migrations closes out a day, so a stop claimed at 4pm and
 * abandoned locks that collector out of tomorrow's list until an admin clears
 * it. Scoping this strip to the window would silence it exactly when it is
 * needed, so the strip is deliberately outside the filter.
 *
 * Pressing a chip widens the date filter to all time and applies that signal, so
 * the admin lands on the offending rows rather than being told a number and left
 * to hunt for it.
 *
 * Renders nothing when every count is zero — a clean day should look clean, not
 * like a dashboard of noughts.
 */

export type AttentionKey = 'stuck' | 'proof' | 'unremitted' | 'failed' | 'notworked'

export interface AttentionSignal {
  key: AttentionKey
  /** Drives visibility — a signal at zero renders nothing. */
  count: number
  /** Singular/plural label, e.g. ['stuck claim', 'stuck claims']. */
  label: [string, string]
  /**
   * Ready-made chip text, for signals whose `count` is a MAGNITUDE rather than a
   * tally. Unremitted money is a peso figure: rendering it through count+label
   * gives "28189 pesos unremitted" instead of "₱28,189 unremitted" — a number
   * the office reads as an amount, formatted like every other amount on the page.
   */
  display?: string
  /** Why it matters — the consequence, not a restatement of the label. */
  hint: string
}

const ICON: Record<AttentionKey, typeof AlertTriangle> = {
  stuck: LockOpen,
  proof: ImageOff,
  unremitted: Wallet,
  failed: PackageX,
  notworked: CalendarX,
}

/**
 * Red is reserved for the two signals that BLOCK somebody: a stuck claim locks a
 * worker out of their next stop, and a failed delivery has goods sitting on a
 * truck. Missing proof and unremitted money are gaps to chase, not blockages,
 * so they stay amber — otherwise everything is urgent and nothing is.
 */
const TONE: Record<AttentionKey, 'red' | 'amber'> = {
  stuck: 'red',
  proof: 'amber',
  unremitted: 'amber',
  failed: 'red',
  // Amber, not red: nothing is blocked and nothing went wrong — the day simply
  // ran out. It needs re-listing, which is routine, not rescue.
  notworked: 'amber',
}

interface NeedsAttentionProps {
  signals: AttentionSignal[]
  /** Which signal is currently being isolated, if any. */
  active: AttentionKey | null
  /**
   * Whether isolating actually widened a narrowed date window. False when the
   * board was already showing all dates, in which case saying so would be
   * narrating a change that never happened.
   */
  widened?: boolean
  /** Toggle isolation. Implementations also widen the date window to all time. */
  onToggle: (key: AttentionKey | null) => void
}

export function NeedsAttention({ signals, active, widened, onToggle }: NeedsAttentionProps) {
  const live = signals.filter(s => s.count > 0)
  if (live.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <AlertTriangle className="w-3.5 h-3.5" />
        Needs attention
      </span>

      {live.map(signal => {
        const Icon = ICON[signal.key]
        const tone = TONE[signal.key]
        const on = active === signal.key

        return (
          <Button
            key={signal.key}
            variant={on ? 'default' : 'outline'}
            size="sm"
            className="h-7 rounded-full text-[11px]"
            aria-pressed={on}
            title={signal.hint}
            onClick={() => onToggle(on ? null : signal.key)}
          >
            <Icon className={on ? undefined : TONE_TEXT[tone]} />
            {signal.display
              ?? `${signal.count} ${signal.count === 1 ? signal.label[0] : signal.label[1]}`}
          </Button>
        )
      })}

      {/* Says what pressing a chip DID, because widening the date window is a
          side effect the admin did not directly ask for. */}
      {active && widened && (
        <span className="text-[11px] text-muted-foreground">
          Showing all dates · press again to go back to the date filter
        </span>
      )}
    </div>
  )
}
