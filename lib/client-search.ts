import { clientAddress } from '@/lib/client-info'
import type { Client } from '@/types'

/**
 * Ranked name search over the client list, for the customer pickers in
 * Collection and Delivery.
 *
 * Exists because those two forms pick one customer out of ~1,500. A plain
 * alphabetical dropdown is unusable at that size, but so is a naive
 * `includes()` filter: typing "moto" against a list full of motorcycle shops
 * returns two hundred rows in arbitrary order, and the one whose name actually
 * STARTS with what was typed is buried among them. So matches are scored and
 * the list is capped — the admin sees the handful their query most plausibly
 * meant, plus a count of what was left out to tell them to keep typing.
 *
 * The address is searchable but never outranks a name hit. An admin holding a
 * PO types the customer's name; the address is there for the second question,
 * "which of the three shops with this name", and for the occasional "who do we
 * deliver to in Orani".
 */

/** How many matches a picker renders before it asks for more typing. */
export const CLIENT_SEARCH_LIMIT = 50

/**
 * Casefold and flatten punctuation so `L&J`, `L & J` and `L J` are one string.
 * `&`, `.` and `-` are load-bearing in these company names and typed
 * inconsistently, so they become separators rather than characters to match.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** True when any word of `text` begins with `prefix` — both already normalized. */
function wordStartsWith(text: string, prefix: string): boolean {
  return text === prefix || text.startsWith(`${prefix} `) || text.includes(` ${prefix}`)
}

/**
 * How well one client answers the query. Lower is better; `null` is no match.
 *
 * The tiers are ordered by how confident we are that this is the row the admin
 * is reaching for, not by how much of the string matched:
 *
 *   0  the name starts with what was typed        "win"  → WINFLEX CORPORATION
 *   1  a later word of the name starts with it    "moto" → IDOL MOTO SPHERE
 *   2  the name contains it mid-word              "flex" → COMOFLEX AUTO SHOP
 *   3  the address contains it                    "orani"
 *   4  every word typed appears somewhere         "moto orani", "3s parts"
 *
 * Tier 4 is what makes a two-word query useful: it lets an admin narrow by
 * name AND place in one field without either term having to match on its own.
 */
function scoreClient(client: Client, query: string, terms: string[]): number | null {
  const name = normalize(client.company_name)
  const where = normalize(clientAddress(client).full ?? '')

  if (name.startsWith(query)) return 0
  if (wordStartsWith(name, query)) return 1
  if (name.includes(query)) return 2
  if (where.includes(query)) return 3

  if (terms.length > 1) {
    const haystack = `${name} ${where}`
    if (terms.every(term => haystack.includes(term))) return 4
  }

  return null
}

export interface ClientSearchResult {
  /** The best `limit` matches, most plausible first. */
  matches: Client[]
  /** How many matched in total, so the caller can say what it is not showing. */
  total: number
}

/**
 * Rank `clients` against `query`, capped at `limit`.
 *
 * An empty query is not a special case with no answer — it returns the whole
 * list alphabetically, capped the same way, so the picker still opens onto
 * something browsable rather than a blank panel.
 */
export function searchClients(
  clients: Client[],
  query: string,
  limit: number = CLIENT_SEARCH_LIMIT,
): ClientSearchResult {
  const normalized = normalize(query)

  if (!normalized) {
    const sorted = [...clients].sort((a, b) => a.company_name.localeCompare(b.company_name))
    return { matches: sorted.slice(0, limit), total: sorted.length }
  }

  const terms = normalized.split(' ')
  const scored: { client: Client; score: number }[] = []

  for (const client of clients) {
    const score = scoreClient(client, normalized, terms)
    if (score !== null) scored.push({ client, score })
  }

  // Alphabetical within a tier, never by list order — the admin is scanning
  // names, and a stable A-Z run reads far faster than the clients table's
  // newest-first order leaking through.
  scored.sort((a, b) =>
    a.score - b.score || a.client.company_name.localeCompare(b.client.company_name)
  )

  return { matches: scored.slice(0, limit).map(s => s.client), total: scored.length }
}

/**
 * The one-line place shown under a customer's name in the pickers.
 *
 * Deliberately the full composed address rather than just the city: the whole
 * job of this line is telling two similarly-named shops apart, and around here
 * they are frequently in the same town.
 */
export function clientWhere(client: Client): string {
  return clientAddress(client).full ?? 'No address on file'
}

/**
 * The customers most recently put on a list, newest first and deduped.
 *
 * Feeds the pickers' "Recently listed" section. `rows` must already be in
 * newest-first order, which is how both `useCollectionVisits` and
 * `usePurchaseOrders` return them — this only dedupes and truncates, because
 * re-sorting here would mean teaching this helper which of `scheduled_for` and
 * `created_at` each table means by "recent".
 */
export function recentClientIds(rows: { client_id: string }[], limit = 12): string[] {
  const seen: string[] = []
  const ids = new Set<string>()

  for (const row of rows) {
    if (ids.has(row.client_id)) continue
    ids.add(row.client_id)
    seen.push(row.client_id)
    if (seen.length >= limit) break
  }

  return seen
}
