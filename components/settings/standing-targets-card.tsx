'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { activePeriod, workingDaysIn } from '@/lib/cutoff'
import type { CutoffPeriod, Holiday, QuotaSettings } from '@/types'
import { Target, Loader2, TriangleAlert, Check } from 'lucide-react'

/**
 * The standing quota numbers — the one place an admin sets them.
 *
 * These are the REAL quota: 35 meetings per cutoff for Sales, 16 visits per
 * working day for RSR. The per-client visit limit sitting alongside them is a
 * different kind of number entirely, a ceiling rather than a goal, and is
 * labelled as such so the two never get read as the same thing again.
 *
 * Saving goes through `apply_standing_targets()`, which pushes the change onto
 * every period that has not ended and writes an audit row per field it touched.
 * Periods that have finished keep the numbers they were measured against — see
 * the note on that function.
 */

interface StandingTargetsCardProps {
  settings: QuotaSettings | null
  holidays: Holiday[]
  periods: CutoffPeriod[]
  canEdit: boolean
  onSaved: () => Promise<void>
}

interface Draft {
  sales_target: string
  rsr_daily_target: string
  client_meeting_cap: string
}

/** What `apply_standing_targets` reports back. */
interface ApplyResult {
  periods_updated: number
  cap_updated: number
  periods_ended: number
}

function toDraft(settings: QuotaSettings | null): Draft {
  return {
    // Blank rather than a number when unconfigured: the placeholder says
    // "not set", and a pre-filled 35 would be the app asserting a quota nobody
    // chose (Batch-0 items 1-2).
    sales_target: settings?.sales_target != null ? String(settings.sales_target) : '',
    rsr_daily_target: settings?.rsr_daily_target != null ? String(settings.rsr_daily_target) : '',
    client_meeting_cap: String(settings?.client_meeting_cap ?? 2),
  }
}

export function StandingTargetsCard({
  settings,
  holidays,
  periods,
  canEdit,
  onSaved,
}: StandingTargetsCardProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ApplyResult | null>(null)

  // Settings arrive after the first render, so the draft has to catch up once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(toDraft(settings))
  }, [settings])

  const current = activePeriod(periods)
  const holidayDates = holidays.map(h => h.holiday_date)
  const workingDays = current ? workingDaysIn(current, holidayDates) : null

  const rsrDaily = Number(draft.rsr_daily_target)
  const derived =
    workingDays != null && draft.rsr_daily_target !== '' && rsrDaily > 0
      ? rsrDaily * workingDays
      : null

  function set<K extends keyof Draft>(key: K, value: string) {
    setDraft(d => ({ ...d, [key]: value }))
    setResult(null)
  }

  async function save() {
    setSaving(true)
    setError('')
    setResult(null)
    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('apply_standing_targets', {
      p_sales_target: draft.sales_target === '' ? null : Number(draft.sales_target),
      p_rsr_daily_target: draft.rsr_daily_target === '' ? null : Number(draft.rsr_daily_target),
      p_client_meeting_cap: Number(draft.client_meeting_cap),
    })

    if (rpcError) setError(rpcError.message)
    else {
      // The RPC returns a single row; supabase-js hands back an array.
      const row = (Array.isArray(data) ? data[0] : data) as ApplyResult | undefined
      setResult(row ?? null)
      await onSaved()
    }
    setSaving(false)
  }

  const valid = Number(draft.client_meeting_cap) > 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          <CardTitle>Quota targets</CardTitle>
        </div>
        <CardDescription>
          Set these once. They apply to the running cutoff and every upcoming one, and are
          what new periods start from. Finished cutoffs keep the numbers they were measured
          against.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 items-start">
          <div className="grid gap-1.5">
            <Label htmlFor="q-sales">Sales target</Label>
            <Input
              id="q-sales"
              type="number"
              min={1}
              placeholder="Not set"
              disabled={!canEdit}
              value={draft.sales_target}
              onChange={e => set('sales_target', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Meetings per cutoff, for each sales specialist.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="q-rsr">RSR target</Label>
            <Input
              id="q-rsr"
              type="number"
              min={1}
              placeholder="Not set"
              disabled={!canEdit}
              value={draft.rsr_daily_target}
              onChange={e => set('rsr_daily_target', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Visits per <strong>working day</strong>, for each RSR.
              {/* The multiplied-out figure, because a daily number against a
                  fortnight is the exact confusion this feature was built to
                  fix — the admin should see what they are actually setting. */}
              {derived != null && current && (
                <>
                  {' '}
                  {rsrDaily} × {workingDays} working days ={' '}
                  <span className="text-foreground font-medium">{derived}</span> this cutoff.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="q-cap">Visit limit per client</Label>
          <Input
            id="q-cap"
            type="number"
            min={1}
            disabled={!canEdit}
            value={draft.client_meeting_cap}
            onChange={e => set('client_meeting_cap', e.target.value)}
          />
          {/* No hint: the label says limit, and the save confirmation already
              reports which cutoffs a change reached. */}
        </div>

        {error && (
          <Alert variant="destructive">
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <Alert>
            <Check className="w-4 h-4" />
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>
              {result.periods_updated === 0 && result.cap_updated === 0
                ? 'No cutoff needed changing — these were already the numbers in use.'
                : `Updated ${result.periods_updated} ${
                    result.periods_updated === 1 ? 'cutoff' : 'cutoffs'
                  }${
                    result.cap_updated > 0
                      ? `, and the visit limit on ${result.cap_updated} not yet started`
                      : ''
                  }.`}
              {result.periods_ended > 0 && (
                <>
                  {' '}
                  {result.periods_ended} finished{' '}
                  {result.periods_ended === 1 ? 'cutoff was' : 'cutoffs were'} left unchanged.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        {canEdit && (
          <Button disabled={!valid || saving} onClick={save}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save targets
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
