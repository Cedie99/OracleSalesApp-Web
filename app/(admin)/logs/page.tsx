'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SearchableSelect, type PickerGroup, type PickerOption,
} from '@/components/ui/searchable-select'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { useDateRangeFilter, toDateInput } from '@/lib/hooks/use-date-range-filter'
import { usePagination } from '@/lib/hooks/use-pagination'
import {
  useAuditLogs, useAuditActors, AUDIT_LOG_LIMIT, EMPTY_AUDIT_FILTERS,
  type AuditLogFilters,
} from '@/lib/hooks/use-audit-logs'
import { auditActionLabel, auditActionsByModule } from '@/lib/audit/entries'
import { roleScopeLabel } from '@/lib/permissions'
import { TONE_CLASS, type BadgeTone } from '@/lib/status-styles'
import { cn } from '@/lib/utils'
import type { AdminAuditLog, NotificationModule } from '@/types'
import {
  ScrollText, Search, Loader2, RefreshCw, ChevronRight, ArrowRight, RotateCcw,
} from 'lucide-react'
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns'

const MODULE_LABEL: Record<NotificationModule, string> = {
  sales: 'Sales',
  collection: 'Collection',
  delivery: 'Delivery',
  system: 'System',
}

/**
 * One tone per module, so a page of entries is scannable without reading it.
 * Deliberately the same assignments the rest of the app already uses for these
 * three functions, rather than a palette invented for this page.
 */
const MODULE_TONE: Record<NotificationModule, BadgeTone> = {
  sales: 'brand',
  collection: 'purple',
  delivery: 'navy',
  system: 'neutral',
}

/** Initials for the actor avatar, matching the sidebar's treatment. */
function initials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U'
}

/** "Today" / "Yesterday" / "Mon, Aug 11" — the heading above each day's entries. */
function dayHeading(iso: string): string {
  const d = new Date(iso)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'EEEE, MMM d, yyyy')
}

/**
 * The admin activity log.
 *
 * Reachable only by a superadmin or an unrestricted admin — enforced by the
 * proxy (the route is absent from every SCOPE_ROUTES entry) and again by the
 * table's own RLS policy, so a scoped admin who reached this page anyway would
 * see an empty list rather than someone else's history.
 *
 * Entries are grouped by day and read newest first. Everything but the free-text
 * search is applied in the query rather than here, because the fetch is capped —
 * see the note on useAuditLogs.
 */
export default function LogsPage() {
  const [search, setSearch] = useState('')
  const [module, setModule] = useState<AuditLogFilters['module']>('all')
  const [action, setAction] = useState<AuditLogFilters['action']>('all')
  const [actor, setActor] = useState<AuditLogFilters['actor']>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })

  const filters: AuditLogFilters = {
    module, action, actor,
    from: dateFilter.range ? toDateInput(dateFilter.range.start) : '',
    to: dateFilter.range ? toDateInput(dateFilter.range.end) : '',
  }

  const { logs, loading, error, truncated, refresh } = useAuditLogs(filters)
  const { actors } = useAuditActors()

  /**
   * The action list, sectioned under its module — the same treatment
   * PersonSelect gives agents under their team, and for the same reason: thirty
   * actions in one flat scroll is a list you hunt through, four labelled groups
   * of seven is one you read. Typing filters across all of them.
   *
   * Narrowing the module narrows this with it — offering 'Added holiday' while
   * the Collection lens is on would be a filter pair that can only ever return
   * nothing. When one module is chosen its heading is dropped: a single section
   * named after the filter directly above it is noise.
   */
  const actionGroups = useMemo<PickerGroup[]>(() => {
    const grouped = auditActionsByModule()
    const all: PickerGroup = {
      id: 'all',
      value: '',
      items: [{ value: 'all', label: 'All Actions' }],
    }

    const modules: NotificationModule[] =
      module === 'all' ? (Object.keys(grouped) as NotificationModule[]) : [module]

    const sections = modules
      .map(m => ({
        id: m,
        value: module === 'all' ? MODULE_LABEL[m] : '',
        items: grouped[m].map(({ action: value, label }) => ({ value, label })),
      }))
      .filter(s => s.items.length > 0)

    return [all, ...sections]
  }, [module])

  /**
   * The people, sectioned under what they are — "Super Admin", "Admin",
   * "Collection Admin". Same shape as the action groups above and as the team
   * headings on the agent picker.
   *
   * Grouped by `roleScopeLabel` rather than by the bare role, because a plain
   * "Admin" heading over four people who administer different halves of the
   * business is the distinction the page most needs to draw: when an entry is
   * being questioned, "which admin" usually means "which function's admin".
   *
   * Scoped admins appear here even though they cannot open this page — they can
   * still be the person who listed a store or released a claim, and a filter
   * that omitted them would quietly hide their entries behind "All Users".
   */
  const actorGroups = useMemo<PickerGroup[]>(() => {
    const all: PickerGroup = {
      id: 'all',
      value: '',
      items: [{ value: 'all', label: 'All Users' }],
    }

    // Insertion order, and `actors` arrives sorted by name — so headings appear
    // in a stable order and names stay alphabetical inside each one.
    const byLabel = new Map<string, PickerOption[]>()
    for (const a of actors) {
      const label = roleScopeLabel(a.role, a.scope)
      const bucket = byLabel.get(label)
      if (bucket) bucket.push({ value: a.id, label: a.name })
      else byLabel.set(label, [{ value: a.id, label: a.name }])
    }

    return [
      all,
      ...[...byLabel.entries()].map(([label, items]) => ({ id: label, value: label, items })),
    ]
  }, [actors])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return logs
    return logs.filter(log =>
      log.summary.toLowerCase().includes(q) ||
      log.actor_name.toLowerCase().includes(q) ||
      (log.entity_label ?? '').toLowerCase().includes(q) ||
      auditActionLabel(log.action).toLowerCase().includes(q)
    )
  }, [logs, search])

  const { pageItems, page, pageCount, from, to, total, setPage } = usePagination(
    filtered, 25, `${search}|${module}|${action}|${actor}|${dateFilter.key}`,
  )

  // Grouped after paging, not before, so a day is never split across two pages
  // in a way that hides how many of its entries are left.
  const byDay = useMemo(() => {
    const groups: { day: string; entries: AdminAuditLog[] }[] = []
    for (const log of pageItems) {
      const day = dayHeading(log.occurred_at)
      const last = groups[groups.length - 1]
      if (last?.day === day) last.entries.push(log)
      else groups.push({ day, entries: [log] })
    }
    return groups
  }, [pageItems])

  const filtersActive =
    module !== EMPTY_AUDIT_FILTERS.module ||
    action !== EMPTY_AUDIT_FILTERS.action ||
    actor !== EMPTY_AUDIT_FILTERS.actor ||
    dateFilter.isActive ||
    search !== ''

  function resetFilters() {
    setSearch('')
    setModule('all')
    setAction('all')
    setActor('all')
    dateFilter.reset()
  }

  return (
    <div className="flex flex-col flex-1">
      <Header
        title="Activity Log"
        subtitle={`${filtered.length} admin action${filtered.length === 1 ? '' : 's'}${truncated ? ` (most recent ${AUDIT_LOG_LIMIT})` : ''}`}
      />

      <div className="flex-1 p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search action, person, or target..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-card border-border h-9"
            />
          </div>

          <Select
            value={module}
            onValueChange={v => {
              setModule((v ?? 'all') as AuditLogFilters['module'])
              // The chosen action may not exist in the new module's list.
              setAction('all')
            }}
          >
            <SelectTrigger className="w-40 h-9 bg-card border-border">
              <SelectValue placeholder="Module" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Modules</SelectItem>
              {(Object.keys(MODULE_LABEL) as NotificationModule[]).map(m => (
                <SelectItem key={m} value={m}>{MODULE_LABEL[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <SearchableSelect
            groups={actionGroups}
            value={action}
            // Clearing the input is the same request as picking the "All" row —
            // matching PersonSelect, so the two controls behave identically.
            onChange={v => setAction(v === '' ? 'all' : v)}
            placeholder={action === 'all' ? 'All Actions' : auditActionLabel(action)}
            showClear={action !== 'all'}
            emptyLabel="No action matches that"
            aria-label="Filter by action"
            className="w-56"
          />

          <SearchableSelect
            groups={actorGroups}
            value={actor}
            onChange={v => setActor(v === '' ? 'all' : v)}
            placeholder={
              actor === 'all' ? 'All Users' : actors.find(a => a.id === actor)?.name ?? 'All Users'
            }
            showClear={actor !== 'all'}
            emptyLabel="No admin matches that name"
            aria-label="Filter by who performed the action"
            className="w-52"
          />

          <DateRangeFilter filter={dateFilter} />

          {filtersActive && (
            <Button variant="ghost" size="sm" className="h-9" onClick={resetFilters}>
              <RotateCcw className="w-3.5 h-3.5" />
              Clear
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {truncated && (
          <Alert>
            <AlertDescription className="text-xs">
              Showing the most recent {AUDIT_LOG_LIMIT} entries. Narrow the date range
              or pick a person to reach older ones.
            </AlertDescription>
          </Alert>
        )}

        {/* Entries, grouped by day */}
        {!loading && !error && byDay.map(({ day, entries }) => (
          <div key={day} className="space-y-2">
            <p className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">
              {day}
            </p>
            <div className="space-y-2">
              {entries.map(log => (
                <LogRow
                  key={log.id}
                  log={log}
                  expanded={expandedId === log.id}
                  onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
                />
              ))}
            </div>
          </div>
        ))}

        {!loading && !error && (
          <Pagination
            page={page} pageCount={pageCount} onPageChange={setPage}
            from={from} to={to} total={total} itemLabel="entries"
          />
        )}

        {loading && (
          <div className="text-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
            <p className="text-sm">Loading activity…</p>
          </div>
        )}

        {!loading && error && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              Couldn&apos;t load the activity log: {error}
            </AlertDescription>
          </Alert>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <ScrollText className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {filtersActive
                ? 'No admin actions match these filters'
                : 'No admin actions recorded yet'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One entry. Collapsed it answers who/what/when; expanded it shows the field
 * diff underneath, which is the part that is usually only wanted for one row at
 * a time — hence a disclosure rather than a permanently open detail block.
 */
function LogRow({
  log, expanded, onToggle,
}: {
  log: AdminAuditLog
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetail = log.changes.length > 0 || log.metadata != null
  const occurred = new Date(log.occurred_at)

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-3.5">
        <div className="flex items-start gap-3">
          <Avatar className="w-8 h-8 shrink-0 mt-0.5">
            {log.actor?.avatar_url && (
              <AvatarImage src={log.actor.avatar_url} alt={log.actor_name} />
            )}
            <AvatarFallback className="bg-primary/20 text-primary text-[10px] font-bold">
              {initials(log.actor_name)}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* The name AS RECORDED, not the joined profile's current one —
                  the entry is a statement about a moment. */}
              <span className="text-sm font-semibold text-foreground">{log.actor_name}</span>
              <Badge variant="tone" className={TONE_CLASS[MODULE_TONE[log.module]]}>
                {auditActionLabel(log.action)}
              </Badge>
            </div>

            <p className="text-xs text-muted-foreground mt-1">{log.summary}</p>

            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
              <span title={format(occurred, 'PPpp')}>
                {format(occurred, 'h:mm a')} · {formatDistanceToNow(occurred, { addSuffix: true })}
              </span>
              {hasDetail && (
                <button
                  onClick={onToggle}
                  aria-expanded={expanded}
                  className="flex items-center gap-0.5 text-primary hover:underline"
                >
                  <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
                  {expanded ? 'Hide details' : 'Details'}
                </button>
              )}
            </div>

            {expanded && (
              <div className="mt-3 pt-3 border-t border-border space-y-2">
                {log.changes.map(change => (
                  <div
                    key={change.field}
                    className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2 items-baseline text-xs"
                  >
                    <span className="text-muted-foreground truncate">{change.label}</span>
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                        {change.from ?? '—'}
                      </span>
                      <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="text-foreground font-medium">{change.to ?? '—'}</span>
                    </div>
                  </div>
                ))}

                {log.metadata != null && (
                  // Raw, because metadata is action-specific by definition —
                  // an SMS fan-out result and a deleted PO's snapshot share no
                  // shape worth building one renderer for.
                  <pre className="text-[11px] text-muted-foreground bg-muted/40 rounded-lg p-2.5 overflow-x-auto">
                    {JSON.stringify(log.metadata, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
