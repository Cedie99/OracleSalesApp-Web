import { TONE_TEXT, type BadgeTone } from '@/lib/status-styles'

/**
 * The leading status mark on a day-list row.
 *
 * This gutter used to hold the stop's per-person number, and that was wrong
 * here. A number only carries meaning inside one person's run: on a shared day
 * list, three drivers holding one stop each render ① ① ①, which reads as broken
 * numbering rather than as three separate first-stops. The sequence belongs on
 * Activity → By collector/driver, where every row provably belongs to the same
 * person; this tab answers "what is the state of this day?", so the gutter shows
 * state.
 *
 * Colour comes from the same `BadgeTone` the row's status badge uses, so the dot
 * and the word can never disagree. It repeats the badge on purpose — a single
 * colour column down the left edge is scannable in a way a row of words is not.
 */
export function StatusDot({ tone, label }: { tone: BadgeTone; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      // `bg-current` inherits the tone's own text colour, so this stays tied to
      // the badge tokens rather than introducing a second colour scale.
      //
      // 2.5 with a soft halo rather than a bare 2: at 8px a flat dot carried so
      // little colour that two different tones read as the same mark from
      // scanning distance, which is the one job it has. The ring uses the same
      // `current` colour at low opacity, so it strengthens the dot without
      // introducing a second value to keep in step.
      className={`inline-block size-2.5 shrink-0 rounded-full bg-current ring-4 ring-current/15 ${TONE_TEXT[tone]}`}
    />
  )
}
