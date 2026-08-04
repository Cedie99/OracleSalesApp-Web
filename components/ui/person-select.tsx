'use client'

import * as React from 'react'
import { SearchableSelect, type PickerOption } from '@/components/ui/searchable-select'

/**
 * The staff picker used by every "filter by person" control in the app.
 *
 * It started as the Reports agent filter and is now shared, because the
 * complaint that prompted it there — scrolling a forty-name dropdown to find a
 * name you already knew — is the same complaint on Dashboard, Maps, Clock
 * Records, Collection and Delivery. One component also means the team headings,
 * the "all" row and the clear affordance behave identically wherever an admin
 * meets them, instead of each page inventing its own.
 *
 * Teams are optional: pass them where staff are organised into teams and the
 * list gains section headings; omit them (Collection, Delivery) and it stays a
 * flat searchable list rather than showing an empty grouping.
 */

export interface PersonOption {
  id: string
  name: string
  /** Groups the person under their team. Null/absent renders under "No team". */
  teamId?: string | null
}

export interface PersonTeamOption {
  id: string
  name: string
}

interface PersonSelectProps {
  options: PersonOption[]
  /** The selected person's id, or 'all'. */
  value: string
  onChange: (value: string) => void
  /** e.g. "All Agents" — the leading row that clears the filter. */
  allLabel: string
  teams?: PersonTeamOption[]
  /** A team filter to narrow the list to, when the page has one. 'all' = no narrowing. */
  teamValue?: string
  /**
   * Non-person rows pinned below the people, e.g. Maps' "Unassigned". They are
   * values the filter accepts but that no profile corresponds to.
   */
  extras?: PickerOption[]
  emptyLabel?: string
  className?: string
  'aria-label'?: string
}

export function PersonSelect({
  options,
  value,
  onChange,
  allLabel,
  teams,
  teamValue = 'all',
  extras,
  emptyLabel = 'No one matches that name',
  className = 'w-56',
  'aria-label': ariaLabel,
}: PersonSelectProps) {
  const showTeams = teams != null && teams.length > 0

  const selected = options.find(o => o.id === value)
  const selectedExtra = extras?.find(e => e.value === value)

  /**
   * The picker's sections.
   *
   * Memoised on the raw inputs rather than on a derived list, and deliberately
   * so: this array is handed to Combobox.Root as `items`, and a fresh identity
   * every render makes it re-derive its collection every render. An
   * intermediate `const` in the render body would defeat the memo entirely,
   * because its identity changes each time even when nothing else has.
   */
  const groups = React.useMemo(() => {
    // Narrowed to the chosen team, so the picker never offers a name that the
    // team filter would immediately exclude from every row.
    const inScope =
      showTeams && teamValue !== 'all'
        ? options.filter(o => (o.teamId ?? '') === teamValue)
        : options

    const all = { id: 'all', value: '', items: [{ value: 'all', label: allLabel }] }
    const tail = extras?.length ? [{ id: 'extras', value: '', items: extras }] : []

    if (!showTeams) {
      return [
        all,
        { id: 'everyone', value: '', items: inScope.map(o => ({ value: o.id, label: o.name })) },
        ...tail,
      ]
    }

    // One section per team, in the order the teams were given, plus a trailing
    // section for staff with no team — dropped silently they would be
    // unreachable through the picker entirely.
    const sections = (teams ?? [])
      .map(t => ({
        id: t.id,
        value: t.name,
        items: inScope.filter(o => o.teamId === t.id).map(o => ({ value: o.id, label: o.name })),
      }))
      .filter(s => s.items.length > 0)

    const orphans = inScope.filter(o => !o.teamId)
    if (orphans.length > 0) {
      sections.push({
        id: 'no-team',
        value: 'No team',
        items: orphans.map(o => ({ value: o.id, label: o.name })),
      })
    }
    return [all, ...sections, ...tail]
  }, [allLabel, extras, options, showTeams, teamValue, teams])

  return (
    <SearchableSelect
      groups={groups}
      value={value}
      // Clearing the input is the same request as picking the "all" row, so it
      // resolves to the filter's own neutral value rather than to ''.
      onChange={v => onChange(v === '' ? 'all' : v)}
      placeholder={selected?.name ?? selectedExtra?.label ?? allLabel}
      // "All …" is the filter's neutral state, so there is nothing to clear
      // back to while it is chosen — the × only appears once a real name is.
      showClear={value !== 'all'}
      emptyLabel={emptyLabel}
      aria-label={ariaLabel}
      className={className}
    />
  )
}
