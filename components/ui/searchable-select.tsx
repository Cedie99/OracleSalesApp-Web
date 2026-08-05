'use client'

import * as React from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { cn } from '@/lib/utils'
import { Check, ChevronDown, X, Search } from 'lucide-react'

/**
 * A select you can type into, with optional grouping.
 *
 * Exists because the plain <Select> is a scroll-only list, and the lists it is
 * used for grow with headcount: an admin hunting one agent among forty was
 * scrolling a dropdown to find a name they already knew. Typing three letters
 * beats scrolling at any size, and costs nothing at small ones.
 *
 * Groups are optional and used here to sort agents under their team, so the two
 * questions an admin actually asks — "this team" and "this person" — are
 * answered by one control instead of two chained ones.
 */

export interface PickerOption {
  value: string
  label: string
  /**
   * A short qualifier shown to the right of the label, e.g. "Manager". Kept out
   * of `label` on purpose: the label is what the typed query matches against
   * and what the closed input echoes back, and neither should gain a word the
   * person didn't type and wouldn't say.
   */
  hint?: string
}

export interface PickerGroup {
  /**
   * Stable React key, never displayed. Distinct from `value` because more than
   * one section legitimately has no heading — the "All" entry and an ungrouped
   * list both render headless, and keying on the empty heading collided them.
   */
  id: string
  /** Rendered as the section heading. Empty string renders no heading. */
  value: string
  /** Secondary text beside the heading, e.g. the team's manager. */
  caption?: string
  items: PickerOption[]
}

interface SearchableSelectProps {
  groups: PickerGroup[]
  value: string
  onChange: (value: string) => void
  /** Shown in the input when nothing is typed. */
  placeholder?: string
  /** Shown when the query matches nothing. */
  emptyLabel?: string
  /**
   * Whether to offer the clear button. Defaults to "whenever something is
   * selected", which is right for a picker whose empty state is genuinely
   * empty. A caller whose neutral state is itself an item — an "All Agents"
   * row — passes false while that row is chosen, because clearing back to what
   * you already have is a control that does nothing.
   */
  showClear?: boolean
  className?: string
  'aria-label'?: string
}

export function SearchableSelect({
  groups,
  value,
  onChange,
  placeholder = 'Search…',
  emptyLabel = 'No matches',
  showClear = true,
  className,
  'aria-label': ariaLabel,
}: SearchableSelectProps) {
  const selected = React.useMemo(
    () => groups.flatMap(g => g.items).find(o => o.value === value) ?? null,
    [groups, value]
  )

  return (
    <Combobox.Root
      items={groups}
      value={selected}
      onValueChange={next => onChange((next as PickerOption | null)?.value ?? '')}
      // Highlight the first match so Enter picks it — the whole point is to
      // type a few letters and commit without reaching for the arrow keys.
      autoHighlight
      isItemEqualToValue={(a, b) => (a as PickerOption)?.value === (b as PickerOption)?.value}
    >
      <Combobox.InputGroup
        className={cn(
          'relative flex h-9 items-center rounded-xl border border-input bg-card text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
          className
        )}
      >
        <Search className="w-3.5 h-3.5 ml-2.5 text-muted-foreground shrink-0" />
        <Combobox.Input
          aria-label={ariaLabel}
          placeholder={placeholder}
          className="h-full w-full min-w-0 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center pr-1 shrink-0">
          {selected && showClear && (
            <Combobox.Clear
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              aria-label="Clear selection"
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
            <Combobox.Empty className="px-3 py-3 text-xs text-muted-foreground">
              {emptyLabel}
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-0 data-empty:p-0">
              {(group: PickerGroup) => (
                <Combobox.Group key={group.id} items={group.items} className="block">
                  {/* An empty heading is a real case, not a fallback: the "All"
                      entry is its own group so it can sit above the teams
                      without pretending to belong to one. */}
                  {group.value !== '' && (
                    <Combobox.GroupLabel className="flex items-baseline gap-1.5 px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground select-none">
                      <span className="shrink-0">{group.value}</span>
                      {/* Dropped to sentence case: it is a person's name sitting
                          in a slot otherwise full of shouted labels, and reads
                          as one only if it stops shouting. */}
                      {group.caption && (
                        <span className="truncate font-normal normal-case tracking-normal text-muted-foreground/70">
                          {group.caption}
                        </span>
                      )}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(item: PickerOption) => (
                      <Combobox.Item
                        key={item.value}
                        value={item}
                        className="grid cursor-default grid-cols-[1rem_1fr_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                      >
                        <Combobox.ItemIndicator className="col-start-1 flex items-center justify-center">
                          <Check className="w-3.5 h-3.5" />
                        </Combobox.ItemIndicator>
                        <span className="col-start-2 truncate">{item.label}</span>
                        {item.hint && (
                          <span className="col-start-3 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
                            {item.hint}
                          </span>
                        )}
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
