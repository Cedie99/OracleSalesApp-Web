'use client'

import * as React from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { cn } from '@/lib/utils'
import { CLIENT_SEARCH_LIMIT, clientWhere, searchClients } from '@/lib/client-search'
import type { Client } from '@/types'
import { Check, ChevronDown, Search, X } from 'lucide-react'

/**
 * The customer picker for Collection and Delivery.
 *
 * SearchableSelect already solved "scrolling a dropdown for a name you know",
 * but it was built for ~40 staff and this list is ~1,500 customers, where three
 * further things go wrong. It renders every option, so opening it builds 1,500
 * DOM nodes. Its list is one flat run, so a common word like "moto" returns a
 * wall. And its rows are bare names, which is not enough to tell 3S MOTOR PARTS
 * from S&S MOTOR PARTS when both are on the round.
 *
 * So: matching and ranking come from `searchClients`, only the top slice is
 * rendered with a count of the rest, every row carries its address, and the
 * customers this admin listed most recently sit at the top — because the same
 * stores and customers recur week to week, and the pick is usually one of them.
 */

interface ClientPickerProps {
  clients: Client[]
  /** The selected client's id, or null for nothing chosen. */
  value: string | null
  onChange: (clientId: string | null) => void
  /**
   * Client ids to surface under "Recently listed", most recent first. Built by
   * the page from the rows it already holds — see `recentClientIds`.
   */
  recentIds?: string[]
  /**
   * Why a customer cannot be picked right now, e.g. "already listed". Returning
   * a string both disables the row and prints the reason on it: a row that
   * silently refuses to be clicked reads as a bug.
   */
  unavailable?: (client: Client) => string | null
  placeholder?: string
  id?: string
  className?: string
}

/** What Combobox holds as a value. `{ value, label }` labels the input for free. */
interface ClientOption {
  value: string
  label: string
  where: string
  reason: string | null
}

interface ClientGroup {
  id: string
  heading: string
  items: ClientOption[]
}

/** How many recently-listed customers are worth pinning above the matches. */
const RECENT_LIMIT = 6

export function ClientPicker({
  clients,
  value,
  onChange,
  recentIds,
  unavailable,
  placeholder = 'Search customers…',
  id,
  className,
}: ClientPickerProps) {
  const [query, setQuery] = React.useState('')

  const toOption = React.useCallback(
    (client: Client): ClientOption => ({
      value: client.id,
      label: client.company_name,
      where: clientWhere(client),
      reason: unavailable?.(client) ?? null,
    }),
    [unavailable]
  )

  const { groups, hidden } = React.useMemo(() => {
    const { matches, total } = searchClients(clients, query)

    // Recents are filtered by the same query rather than pinned unconditionally:
    // once the admin starts typing they are answering "which customer", and a
    // recent that does not match is just a row in the way.
    const byId = new Map(clients.map(c => [c.id, c]))
    const matched = new Set(matches.map(c => c.id))
    const recent = (recentIds ?? [])
      .map(rid => byId.get(rid))
      .filter((c): c is Client => !!c && matched.has(c.id))
      .slice(0, RECENT_LIMIT)

    const recentIdSet = new Set(recent.map(c => c.id))
    const rest = matches.filter(c => !recentIdSet.has(c.id))

    const built: ClientGroup[] = []
    if (recent.length > 0) {
      built.push({ id: 'recent', heading: 'Recently listed', items: recent.map(toOption) })
    }
    if (rest.length > 0) {
      built.push({
        id: 'matches',
        // With nothing typed this is a plain A-Z browse, not a result set, and
        // calling it "matches" would imply a query that is not there.
        heading: query.trim() ? 'Matches' : 'All customers',
        items: rest.map(toOption),
      })
    }

    return { groups: built, hidden: Math.max(0, total - CLIENT_SEARCH_LIMIT) }
  }, [clients, query, recentIds, toOption])

  const selected = React.useMemo(() => {
    const client = clients.find(c => c.id === value)
    return client ? toOption(client) : null
  }, [clients, value, toOption])

  return (
    <Combobox.Root
      items={groups}
      value={selected}
      // Ranking, capping and grouping are all ours — see the module note. Base
      // UI's own filter would run over the slice we already chose and undo it.
      filter={null}
      onValueChange={next => onChange((next as ClientOption | null)?.value ?? null)}
      onInputValueChange={next => setQuery(next)}
      // Highlight the first match so Enter commits it: the point is to type a
      // few letters and move on without reaching for the arrow keys.
      autoHighlight
      isItemEqualToValue={(a, b) => (a as ClientOption)?.value === (b as ClientOption)?.value}
    >
      <Combobox.InputGroup
        className={cn(
          'relative flex h-9 items-center rounded-xl border border-input bg-card text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
          className
        )}
      >
        <Search className="w-3.5 h-3.5 ml-2.5 text-muted-foreground shrink-0" />
        <Combobox.Input
          id={id}
          placeholder={placeholder}
          className="h-full w-full min-w-0 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center pr-1 shrink-0">
          {selected && (
            <Combobox.Clear
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              aria-label="Clear customer"
            >
              <X className="w-3.5 h-3.5" />
            </Combobox.Clear>
          )}
          <Combobox.Trigger
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Open list"
          >
            <ChevronDown className="w-4 h-4" />
          </Combobox.Trigger>
        </div>
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner className="outline-none z-50" sideOffset={4}>
          <Combobox.Popup className="w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] rounded-xl border border-border bg-popover text-popover-foreground shadow-md">
            {/* Names the exclusion as well as the miss. Prospects are filtered
                out upstream, so an admin hunting one would otherwise be told
                only that their spelling was wrong. */}
            <Combobox.Empty className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">
              No customer matches that. Try part of the name, or the town — and note that only
              customers who have placed an order are listed here, never prospects or lost clients.
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-0 data-empty:p-0">
              {(group: ClientGroup) => (
                <Combobox.Group key={group.id} items={group.items} className="block">
                  <Combobox.GroupLabel className="block px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground select-none">
                    {group.heading}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(item: ClientOption) => (
                      <Combobox.Item
                        key={item.value}
                        value={item}
                        disabled={item.reason !== null}
                        className="grid cursor-default grid-cols-[1rem_1fr] items-start gap-x-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50"
                      >
                        <Combobox.ItemIndicator className="col-start-1 row-start-1 flex items-center justify-center pt-0.5">
                          <Check className="w-3.5 h-3.5" />
                        </Combobox.ItemIndicator>
                        <span className="col-start-2 row-start-1 flex items-baseline gap-2">
                          <span className="truncate">{item.label}</span>
                          {item.reason && (
                            <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
                              {item.reason}
                            </span>
                          )}
                        </span>
                        {/* The disambiguator. Two shops on the same round can
                            share a name; they do not share a street. */}
                        <span className="col-start-2 row-start-2 truncate text-[11px] text-muted-foreground">
                          {item.where}
                        </span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
            {/* Sits outside the List so it never becomes a keyboard stop — it is
                an instruction about the list, not a row in it. */}
            {hidden > 0 && (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                {hidden.toLocaleString()} more {hidden === 1 ? 'match' : 'matches'} — keep typing to
                narrow it down.
              </p>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
