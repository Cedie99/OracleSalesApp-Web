'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { activePeriod, workingDaysIn } from '@/lib/cutoff'
import type { CutoffPeriod, Holiday } from '@/types'
import { CalendarOff, Plus, Trash2, TriangleAlert, Loader2 } from 'lucide-react'
import { format } from 'date-fns'

/**
 * Company non-working days.
 *
 * Only the RSR target depends on these: its daily number is multiplied by the
 * working days in a period, so a holiday nobody records lowers the expectation
 * for everyone. Weekends are derived, never stored — they are the one part of
 * the calendar that IS computable.
 *
 * Per-agent leave is deliberately not modelled here. It needs a record per
 * person, belongs to whoever owns attendance, and folding it into a shared
 * holiday list would quietly reduce the whole company's target for one person's
 * day off.
 */

interface HolidaysCardProps {
  holidays: Holiday[]
  periods: CutoffPeriod[]
  profileId: string | undefined
  canEdit: boolean
  onChanged: () => Promise<void>
}

export function HolidaysCard({
  holidays,
  periods,
  profileId,
  canEdit,
  onChanged,
}: HolidaysCardProps) {
  const [date, setDate] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const current = activePeriod(periods)
  const workingDays = current ? workingDaysIn(current, holidays.map(h => h.holiday_date)) : null

  async function add() {
    setBusy(true)
    setError('')
    const supabase = createClient()
    const { error: insertError } = await supabase.from('holidays').insert({
      holiday_date: date,
      label: label.trim(),
      created_by: profileId ?? null,
    })

    if (insertError) {
      setError(
        insertError.code === '23505'
          ? 'That date is already on the list.'
          : insertError.message
      )
    } else {
      setDate('')
      setLabel('')
      await onChanged()
    }
    setBusy(false)
  }

  async function remove(holidayDate: string) {
    setBusy(true)
    setError('')
    const supabase = createClient()
    const { error: deleteError } = await supabase
      .from('holidays')
      .delete()
      .eq('holiday_date', holidayDate)

    if (deleteError) setError(deleteError.message)
    else await onChanged()
    setBusy(false)
  }

  // Past holidays stay in the table for historical working-day counts, but the
  // list an admin manages is about what is still ahead.
  const today = format(new Date(), 'yyyy-MM-dd')
  const upcoming = holidays.filter(h => h.holiday_date >= today)
  const past = holidays.length - upcoming.length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarOff className="w-4 h-4 text-primary" />
          <CardTitle>Non-working days</CardTitle>
        </div>
        <CardDescription>
          Holidays and company shutdowns. These lower the RSR target for the cutoffs they
          fall in, because the daily figure is multiplied by working days. Weekends are
          excluded automatically — you do not need to add them.
          {workingDays != null && current && (
            <>
              {' '}
              The running cutoff has{' '}
              <span className="text-foreground font-medium">{workingDays} working days</span>.
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {upcoming.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No upcoming non-working days.
            {past > 0 && ` ${past} in the past, kept for historical counts.`}
          </p>
        )}

        {upcoming.map(h => (
          <div
            key={h.holiday_date}
            className="flex items-center gap-3 rounded-lg border border-border p-2.5"
          >
            <span className="text-sm text-foreground tabular-nums w-28 shrink-0">
              {format(new Date(`${h.holiday_date}T00:00:00Z`), 'MMM d, yyyy')}
            </span>
            <span className="text-sm text-muted-foreground truncate flex-1">{h.label}</span>
            {canEdit && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => remove(h.holiday_date)}
                aria-label={`Remove ${h.label}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        ))}

        {canEdit && (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <div className="grid gap-1.5">
              <Label htmlFor="h-date">Date</Label>
              <Input
                id="h-date"
                type="date"
                className="w-44"
                value={date}
                onChange={e => setDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5 flex-1 min-w-[12rem]">
              <Label htmlFor="h-label">Name</Label>
              <Input
                id="h-label"
                placeholder="e.g. Independence Day"
                value={label}
                onChange={e => setLabel(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={busy || date === '' || label.trim() === ''}
              onClick={add}
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
