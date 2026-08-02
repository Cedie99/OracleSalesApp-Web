'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

/**
 * The per-person stop marker on the Collection and Delivery day boards.
 *
 * A day card mixes everyone's work into one list, so the number alone is
 * ambiguous — two people both have a ①. The colour is what disambiguates them,
 * and it is the SAME colour the trip map gives that person (both come from
 * `workerColors`), so an admin moving between the board and the map keeps
 * tracking the same person by sight rather than re-reading names.
 *
 * Colour is applied inline rather than through a Tailwind class because the
 * palette is assigned at runtime from the number of people on screen — there is
 * no fixed set of classes to name.
 */

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
}

/**
 * "③" in the person's colour. Hollow while they are still on their way, because
 * an en-route stop has no worked position yet and shouldn't read as done.
 */
export function StopNumber({
  sequence, color, label, pending = false,
}: {
  /** Position in the run. Only meaningful where every row is one person's. */
  sequence: number
  color: string
  /** Screen-reader/tooltip text, e.g. "Marisa Cruz's stop 3 of 5". */
  label: string
  /** They are still on their way, so this position hasn't happened yet. */
  pending?: boolean
}) {
  const number = { sequence, fromClaim: pending }

  return (
    <span
      role="img"
      aria-label={number.fromClaim ? `${label} — on the way` : label}
      title={label}
      // Matches the numbered marker in the trip map's stop list exactly —
      // size-5, rounded-full, 10px bold, dark text on the fill. The two surfaces
      // show the same runs, so a number that looked different on each would read
      // as a different kind of thing. Dark text rather than white because every
      // TRIP_COLORS entry is a light, saturated hue.
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold tabular-nums"
      style={
        number.fromClaim
          // Hollow: they are on their way, so the position hasn't happened yet.
          // Border kept on both variants so the two are the same size.
          ? { borderColor: color, color, borderStyle: 'dashed' }
          : { backgroundColor: color, borderColor: color, color: '#0f172a' }
      }
    >
      {number.sequence}
    </span>
  )
}

/**
 * The person's avatar, ringed in their colour.
 *
 * Sits next to the claim line so "who is on the way" is answerable at a glance
 * across a card, rather than only by reading each row's name. The ring is what
 * ties it to the numbers on that person's other stops.
 */
export function WorkerAvatar({
  name, avatarUrl, color,
}: {
  name: string | null
  avatarUrl?: string | null
  color: string
}) {
  return (
    <Avatar
      className="size-4 shrink-0 after:border-0 ring-2"
      style={{ '--tw-ring-color': color } as React.CSSProperties}
    >
      {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback
        className="text-[7px] font-semibold"
        style={{ backgroundColor: `${color}33`, color }}
      >
        {name ? initials(name) : '?'}
      </AvatarFallback>
    </Avatar>
  )
}
