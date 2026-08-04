'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pagination } from '@/components/ui/pagination'
import { usePeriodChanges } from '@/lib/hooks/use-cutoff'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useProfiles } from '@/lib/hooks/use-profiles'
import type { CutoffPeriod } from '@/types'
import { History } from 'lucide-react'
import { format } from 'date-fns'

/**
 * Who changed a quota number, on which cutoff, and when.
 *
 * Satisfies the ADR-053 Batch 7B requirement for an audit history of policy
 * changes, which Settings has never had. Rows come from
 * `cutoff_period_changes`, which only `apply_standing_targets()` can write —
 * an audit trail any client could insert into would prove nothing.
 *
 * A table, and no longer collapsible. It was a collapsed card back when it sat
 * last in a stack of six and had to earn its space; it now owns a tab, where
 * hiding the only thing on screen behind a chevron just adds a click to reach
 * what the tab already promised. Columns rather than prose because the reason
 * to open this is to compare — the same field across dates, or one person's
 * changes — and a sentence per row cannot be scanned down.
 */

/** Schema field names are not admin words. */
const FIELD_LABEL: Record<string, string> = {
  sales_target: 'Sales target',
  rsr_daily_target: 'RSR target (per working day)',
  client_meeting_cap: 'Visit limit per client',
}

export function PeriodHistoryCard({ periods }: { periods: CutoffPeriod[] }) {
  const { changes, loading } = usePeriodChanges()
  const { profiles } = useProfiles()

  // 15 a page: one save writes a row per field per unfinished period, so a
  // single click on Save targets can add fifty. Paging keeps that from reading
  // as an endless wall, and the count line says how much there really is.
  const { page, pageCount, pageItems, total, from, to, setPage } = usePagination(changes, 15)

  const periodLabel = (id: string) => periods.find(p => p.id === id)?.label ?? 'a deleted cutoff'
  const who = (id: string | null) =>
    id ? profiles.find(p => p.id === id)?.full_name ?? 'Unknown' : 'System'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-primary" />
          <CardTitle>Change history</CardTitle>
          {!loading && changes.length > 0 && (
            <span className="text-xs text-muted-foreground">{changes.length}</span>
          )}
        </div>
        <CardDescription>
          Every quota change, most recent first. Finished cutoffs never appear here — they
          are never edited.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {loading && <p className="text-sm text-muted-foreground py-2">Loading…</p>}

        {!loading && changes.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">Nothing has been changed yet.</p>
        )}

        {changes.length > 0 && (
          <div className="space-y-3">
            {/* A page's worth fits, so this scrolls sideways on a narrow screen
                only — no inner vertical scrollbar racing the page's own. */}
            <div className="rounded-lg border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>What changed</TableHead>
                    <TableHead>Cutoff</TableHead>
                    <TableHead className="text-right">From</TableHead>
                    <TableHead className="text-right">To</TableHead>
                    <TableHead>Changed by</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageItems.map(c => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium text-foreground whitespace-nowrap">
                        {FIELD_LABEL[c.field] ?? c.field}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {periodLabel(c.period_id)}
                      </TableCell>
                      {/* "not set" rather than a blank, so an unconfigured
                          starting point reads as deliberate. */}
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {c.old_value ?? 'not set'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium text-foreground">
                        {c.new_value ?? 'not set'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{who(c.changed_by)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                        {format(new Date(c.changed_at), 'MMM d, yyyy h:mm a')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={setPage}
              from={from}
              to={to}
              total={total}
              itemLabel="changes"
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
