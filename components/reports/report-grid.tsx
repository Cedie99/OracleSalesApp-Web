'use client'

import * as React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import type { DateRangeFilterState } from '@/lib/hooks/use-date-range-filter'
import { FileBarChart2, Download, FileSpreadsheet } from 'lucide-react'
import * as XLSX from 'xlsx'
import { format } from 'date-fns'

/** One downloadable export, as the grid renders it. */
export interface ReportDefinition {
  title: string
  description: string
  icon: React.ElementType
  count: number
  countLabel: string
  /** Three at-a-glance figures under the description. */
  stats: { label: string; value: number | string }[]
  onDownload: () => void
}

/**
 * Write rows to an .xlsx and trigger the download.
 *
 * Every report in every module goes through here so the filename convention and
 * sheet handling stay identical — the office files these by name, and three
 * modules inventing three conventions would be a support problem, not a style
 * one.
 */
export function downloadSheet(
  rows: Record<string, string | number>[],
  sheetName: string,
  fileSlug: string
) {
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, `${fileSlug}-${format(new Date(), 'yyyy-MM-dd')}.xlsx`)
}

interface WorkerOption {
  id: string
  name: string
  /** Groups the person under their team in the picker. Null renders as "No team". */
  teamId?: string | null
}

interface TeamOption {
  id: string
  name: string
}

interface ReportFiltersProps {
  /** e.g. "Filter by agent" / "Filter by collector". */
  label: string
  /** e.g. "All Agents". */
  allLabel: string
  options: WorkerOption[]
  value: string
  onChange: (value: string) => void
  dateFilter: DateRangeFilterState
  /**
   * Teams to offer as their own filter. Omit in a module where staff are not
   * organised into teams — the control disappears rather than showing an empty
   * dropdown.
   */
  teams?: TeamOption[]
  teamValue?: string
  onTeamChange?: (value: string) => void
}

/**
 * The filter bar above the report cards.
 *
 * The person-filter is module-specific by nature — a Collection Admin filtering
 * by "agent" would be offered sales staff who never touch a collection run —
 * so the options and both labels are passed in rather than assumed.
 *
 * The person picker is a searchable combobox rather than a plain select: these
 * lists grow with headcount, and hunting one known name down a forty-row
 * dropdown is the complaint that prompted it. Choosing a team narrows the
 * picker to that team's staff, so the two filters compose instead of competing.
 */
export function ReportFilters({
  label,
  allLabel,
  options,
  value,
  onChange,
  dateFilter,
  teams,
  teamValue = 'all',
  onTeamChange,
}: ReportFiltersProps) {
  const showTeams = teams != null && teams.length > 0 && onTeamChange != null

  const selected = options.find(o => o.id === value)
  const selectedTeam = teams?.find(t => t.id === teamValue)

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
    // team filter would immediately exclude from every report.
    const inScope =
      showTeams && teamValue !== 'all'
        ? options.filter(o => (o.teamId ?? '') === teamValue)
        : options

    const all = { id: 'all', value: '', items: [{ value: 'all', label: allLabel }] }
    if (!showTeams) {
      return [
        all,
        {
          id: 'everyone',
          value: '',
          items: inScope.map(o => ({ value: o.id, label: o.name })),
        },
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
    return [all, ...sections]
  }, [allLabel, options, showTeams, teamValue, teams])

  return (
    <div className="flex flex-wrap items-center gap-3">
      <FileBarChart2 className="w-4 h-4 text-muted-foreground" />

      {showTeams && (
        <>
          <p className="text-sm text-muted-foreground">Team:</p>
          <Select
            value={teamValue}
            onValueChange={v => {
              const next = (v as string) ?? 'all'
              onTeamChange(next)
              // A person selected from the old team would silently contradict
              // the new one, so the narrower filter yields to the wider.
              if (next !== 'all' && selected && (selected.teamId ?? '') !== next) onChange('all')
            }}
          >
            <SelectTrigger className="w-40 h-9 bg-card border-border">
              <SelectValue placeholder="All Teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Teams</SelectItem>
              {teams!.map(t => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}

      <p className="text-sm text-muted-foreground">{label}:</p>
      <SearchableSelect
        groups={groups}
        value={value === 'all' ? 'all' : value}
        onChange={v => onChange(v === '' ? 'all' : v)}
        placeholder={selected ? selected.name : allLabel}
        emptyLabel="No one matches that name"
        aria-label={label}
        className="w-56"
      />

      <p className="text-sm text-muted-foreground">Date range:</p>
      <DateRangeFilter filter={dateFilter} />

      {(value !== 'all' || teamValue !== 'all' || dateFilter.isActive) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 text-xs text-muted-foreground"
          onClick={() => {
            onChange('all')
            onTeamChange?.('all')
            dateFilter.reset()
          }}
        >
          Clear filters
        </Button>
      )}

      {selectedTeam && (
        <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
          {selectedTeam.name}
        </Badge>
      )}
      {selected && (
        <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
          {selected.name}
        </Badge>
      )}
    </div>
  )
}

/** The report cards themselves — identical in every module. */
export function ReportGrid({ reports }: { reports: ReportDefinition[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {reports.map(({ title, description, icon: Icon, count, countLabel, onDownload, stats }) => (
        <Card key={title} className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Icon className="w-5 h-5 text-primary" />
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-foreground">{count}</p>
                <p className="text-xs text-muted-foreground">{countLabel}</p>
              </div>
            </div>
            <CardTitle className="text-sm font-semibold text-foreground mt-2">{title}</CardTitle>
            <p className="text-xs text-muted-foreground">{description}</p>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex gap-2 mb-4">
              {stats.map(s => (
                <div key={s.label} className="flex-1 bg-muted/30 rounded-lg p-2 text-center">
                  <p className="text-sm font-semibold text-foreground truncate">{s.value}</p>
                  <p className="text-[10px] text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
            <Button
              onClick={onDownload}
              className="w-full h-9 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 text-xs font-medium"
              variant="outline"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Download Excel
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
