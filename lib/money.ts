/**
 * Peso formatting, shared by every money-handling module (Collection's due /
 * collected / remitted figures, Delivery's COD).
 *
 * Lives on its own rather than in lib/collection.ts because Delivery reads the
 * same figures and should not have to import from Collection to print a peso
 * sign — the two modules are siblings, not one built on the other.
 */

/**
 * Philippine peso. Whole amounts print bare (₱1,500); anything with centavos
 * prints both digits (₱1,500.50), never the ragged ₱1,500.5. Most figures are
 * still whole pesos, but a Collection admin can now type centavos into a
 * balance or a down payment, so they have to survive display.
 */
export function peso(n: number): string {
  const cents = Math.round(n * 100) % 100 !== 0
  return `₱${n.toLocaleString('en-PH', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}

/** Rounds to the centavo — strips float noise like 0.1 + 0.2 before a write. */
export function toCentavo(n: number): number {
  return Math.round(n * 100) / 100
}

/** Signed peso, for figures where the direction is the point. */
export function pesoDelta(n: number): string {
  if (n === 0) return peso(0)
  return `${n > 0 ? '+' : '−'}${peso(Math.abs(n))}`
}
