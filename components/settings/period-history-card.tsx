'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { usePeriodChanges } from '@/lib/hooks/use-cutoff'
import { useProfiles } from '@/lib/hooks/use-profiles'
import type { CutoffPeriod } from '@/types'
import { History, ChevronDown, ChevronRight } from 'lucide-react'
import { format } from 'date-fns'

/**
 * Who changed a quota number, on which cutoff, and when.
 *
 * Satisfies the ADR-053 Batch 7B requirement for an audit history of policy
 * changes, which Settings has never had. Rows come from
 * `cutoff_period_changes`, which only `apply_standing_targets()` can write —
 * an audit trail any client could insert into would prove nothing.
 *
 * Collapsed by default: it is a record to consult when a number is disputed,
 * not something to read on the way past.
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
  const [open, setOpen] = useState(false)

  const periodLabel = (id: string) => periods.find(p => p.id === id)?.label ?? 'a deleted cutoff'
  const who = (id: string | null) =>
    id ? profiles.find(p => p.id === id)?.full_name ?? 'Unknown' : 'System'

  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setOpen(v => !v)}
        >
          {open ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <History className="w-4 h-4 text-primary" />
          <CardTitle>Change history</CardTitle>
          {!loading && changes.length > 0 && (
            <span className="text-xs text-muted-foreground">{changes.length}</span>
          )}
        </button>
        {open && (
          <CardDescription>
            Every quota change, most recent first. Finished cutoffs never appear here —
            they are never edited.
          </CardDescription>
        )}
      </CardHeader>

      {open && (
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

          {!loading && changes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing has been changed yet.
            </p>
          )}

          {changes.length > 0 && (
            <div className="rounded-lg border border-border divide-y divide-border max-h-80 overflow-y-auto">
              {changes.map(c => (
                <div key={c.id} className="px-3 py-2 text-xs">
                  <p className="text-foreground">
                    <span className="font-medium">{FIELD_LABEL[c.field] ?? c.field}</span> on{' '}
                    {periodLabel(c.period_id)}:{' '}
                    {/* "not set" rather than a blank, so an unconfigured
                        starting point reads as deliberate. */}
                    <span className="text-muted-foreground">{c.old_value ?? 'not set'}</span>
                    {' → '}
                    <span className="font-medium">{c.new_value ?? 'not set'}</span>
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    {who(c.changed_by)} · {format(new Date(c.changed_at), 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
