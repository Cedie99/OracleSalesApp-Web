'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { TONE_CLASS } from '@/lib/status-styles'
import { capForRole, capsDiffer, periodDateLabel, periodTargetFor, workingDaysIn } from '@/lib/cutoff'
import type { CutoffPeriod, Holiday } from '@/types'

/**
 * What is true right now, in one strip.
 *
 * Every fact here was already on this page, but spread across three cards that
 * each answered a different question — so "what is the running cutoff and what
 * is it asking for" took reading all three and doing the RSR multiplication in
 * your head. It is the first thing an admin opens Settings to check and the one
 * thing the page never said outright.
 *
 * Deliberately read-only. Nothing here is an input; the tabs below own every
 * edit. A summary that can also be edited becomes a fourth place to change the
 * same number, which is the problem this page just finished shedding.
 */

interface CurrentCutoffSummaryProps {
  period: CutoffPeriod
  holidays: Holiday[]
}

/** Whole days from today to the last day of the period, inclusive of today. */
function daysRemaining(endsOn: string): number {
  const today = new Date()
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const end = new Date(`${endsOn}T00:00:00Z`).getTime()
  return Math.max(0, Math.round((end - start) / 86_400_000) + 1)
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold text-foreground tabular-nums leading-tight">{value}</p>
      {hint && <p className="text-xs text-muted-foreground truncate">{hint}</p>}
    </div>
  )
}

export function CurrentCutoffSummary({ period, holidays }: CurrentCutoffSummaryProps) {
  const workingDays = workingDaysIn(
    period,
    holidays.map(h => h.holiday_date)
  )
  const rsrPeriodTarget = periodTargetFor('rsr', period, workingDays)
  const left = daysRemaining(period.ends_on)

  // The label is generated from the dates, so printing both repeats itself.
  const dates = periodDateLabel(period)
  const showDates = period.label !== dates

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge variant="tone" className={TONE_CLASS.brand}>
            Running now
          </Badge>
          <span className="text-sm font-medium text-foreground">{period.label}</span>
          {showDates && <span className="text-xs text-muted-foreground">{dates}</span>}
          <span className="ml-auto text-xs text-muted-foreground">
            {left === 0 ? 'Ends today' : `${left} ${left === 1 ? 'day' : 'days'} left`}
          </span>
        </div>

        <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 border-t border-border pt-3">
          <Stat
            label="Sales target"
            value={period.sales_target != null ? String(period.sales_target) : '—'}
            hint={period.sales_target != null ? 'meetings this cutoff' : 'not configured'}
          />
          {/* Both numbers, because neither alone is the answer: 16 is what an RSR
              is told daily, 176 is what this cutoff actually expects of them. */}
          <Stat
            label="RSR target"
            value={period.rsr_daily_target != null ? String(period.rsr_daily_target) : '—'}
            hint={
              rsrPeriodTarget != null
                ? `per working day · ${rsrPeriodTarget} this cutoff`
                : 'not configured'
            }
          />
          {/* One figure while the roles agree, both when they do not — and the
              hint carries the pooling rule in the only place a reader is
              looking at the two numbers side by side. */}
          <Stat
            label="Visit limit"
            value={
              capsDiffer(period)
                ? `${capForRole('sales_specialist', period)} / ${capForRole('rsr', period)}`
                : String(capForRole('sales_specialist', period))
            }
            hint={
              capsDiffer(period)
                ? 'Sales / RSR per client, separate pools'
                : 'per client, new + existing'
            }
          />
          <Stat
            label="Working days"
            value={String(workingDays)}
            hint={
              period.working_days_override != null
                ? 'set by hand for this cutoff'
                : 'weekdays minus holidays'
            }
          />
        </div>
      </CardContent>
    </Card>
  )
}
