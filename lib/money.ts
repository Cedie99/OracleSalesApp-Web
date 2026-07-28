/**
 * Peso formatting, shared by every money-handling module (Collection's due /
 * collected / remitted figures, Delivery's COD).
 *
 * Lives on its own rather than in lib/collection.ts because Delivery reads the
 * same figures and should not have to import from Collection to print a peso
 * sign — the two modules are siblings, not one built on the other.
 */

/** Philippine peso, no decimals — amounts in this domain are always whole pesos. */
export function peso(n: number): string {
  return `₱${n.toLocaleString('en-PH')}`
}

/** Signed peso, for figures where the direction is the point. */
export function pesoDelta(n: number): string {
  if (n === 0) return peso(0)
  return `${n > 0 ? '+' : '−'}${peso(Math.abs(n))}`
}
