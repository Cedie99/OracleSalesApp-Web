'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { recordAuditLog } from '@/lib/audit/actions'
import { buildChanges } from '@/lib/audit/entries'
import { currentMonth, monthLabel, workingDaysInMonth } from '@/lib/cutoff'
import type { Holiday, QuotaSettings } from '@/types'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Target, Loader2, TriangleAlert, Check, Info } from 'lucide-react'

/**
 * The standing quota numbers — the one place an admin sets them.
 *
 * These are the REAL quota: 35 meetings a MONTH for Sales, 20 a month for a
 * manager, 16 visits per working day for RSR. The per-client visit limits
 * sitting alongside them are a different kind of number entirely, a ceiling
 * rather than a goal, and are labelled as such so the two never get read as the
 * same thing again.
 *
 * Two windows on one card, which is the thing to keep straight while editing it:
 * since migration 105 the TARGETS are monthly and the LIMITS are per cutoff.
 * Every hint below says which of the two it means, because the page can no
 * longer imply one window for everything on it.
 *
 * The manager number is new in 105 and replaces an inheritance rather than
 * filling a gap: a manager used to be measured against whatever their team was
 * (076), so their quota moved when Sales' did and no admin could see it. It is
 * now a flat figure that does not vary by team kind.
 *
 * Both axes are now per role (migration 074, supervisor 2026-08-09). The limits
 * are counted as SEPARATE POOLS, which is the fact the hint under them has to
 * carry: Sales using its allowance against a client consumes none of RSR's.
 *
 * Saving goes through `apply_standing_targets()`, which pushes the change onto
 * every period that has not ended and writes an audit row per field it touched.
 * Periods that have finished keep the numbers they were measured against — see
 * the note on that function. The two limits reach only periods that have not
 * STARTED, because unlike a target they drive slot allocation.
 */

/**
 * No `periods` any more: the card used to read the running cutoff purely to
 * multiply the RSR daily number out over it, and that window is now the month,
 * which needs only the holiday list.
 */
interface StandingTargetsCardProps {
  settings: QuotaSettings | null
  holidays: Holiday[]
  canEdit: boolean
  onSaved: () => Promise<void>
}

interface Draft {
  sales_target: string
  rsr_daily_target: string
  manager_target: string
  sales_client_meeting_cap: string
  rsr_client_meeting_cap: string
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
    // Blank for the same reason, and it matters more here: a manager's target
    // used to be inherited from their team, so an unset field is genuinely "no
    // quota configured for managers yet", not "the old number is still running".
    manager_target: settings?.manager_target != null ? String(settings.manager_target) : '',
    // Unlike the targets, a visit limit has no "not configured" state — it is a
    // ceiling the trigger applies to every meeting, so it always has a value.
    // Falls back through the pre-074 shared number before the literal default,
    // so an admin who has never opened this card since the split sees the limit
    // that is actually in force rather than a 2 nobody chose.
    sales_client_meeting_cap: String(
      settings?.sales_client_meeting_cap ?? settings?.client_meeting_cap ?? 2
    ),
    rsr_client_meeting_cap: String(
      settings?.rsr_client_meeting_cap ?? settings?.client_meeting_cap ?? 2
    ),
  }
}

export function StandingTargetsCard({
  settings,
  holidays,
  canEdit,
  onSaved,
}: StandingTargetsCardProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings))
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ApplyResult | null>(null)

  // Settings arrive after the first render, so the draft has to catch up once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(toDraft(settings))
  }, [settings])

  const holidayDates = holidays.map(h => h.holiday_date)

  // The MONTH's working days, not the cutoff's: an RSR target is multiplied out
  // over the window it is measured in, and since 105 that is the month.
  const month = currentMonth()
  const workingDays = workingDaysInMonth(month, holidayDates)

  const rsrDaily = Number(draft.rsr_daily_target)
  const derived =
    draft.rsr_daily_target !== '' && rsrDaily > 0 ? rsrDaily * workingDays : null

  function set<K extends keyof Draft>(key: K, value: string) {
    setDraft(d => ({ ...d, [key]: value }))
    setResult(null)
  }

  /**
   * The fields actually being changed, old value to new.
   *
   * The confirmation is built from this rather than from a fixed sentence: an
   * admin is allowed to change these whenever they like, so the dialog's job is
   * not to discourage them but to show exactly what they are about to do. A
   * generic "are you sure?" would be dismissed unread by the third time.
   */
  const stored = toDraft(settings)
  const pending = (
    [
      ['sales_target', 'Sales target', 'a month'],
      ['manager_target', 'Manager target', 'a month'],
      ['rsr_daily_target', 'RSR target', 'per working day'],
      ['sales_client_meeting_cap', 'Sales visit limit', 'per client'],
      ['rsr_client_meeting_cap', 'RSR visit limit', 'per client'],
    ] as const
  )
    .filter(([key]) => draft[key] !== stored[key])
    .map(([key, label, unit]) => ({
      label,
      unit,
      from: stored[key] === '' ? 'not set' : stored[key],
      to: draft[key] === '' ? 'not set' : draft[key],
      isTarget: key.endsWith('_target'),
    }))

  const targetChanged = pending.some(p => p.isTarget)

  async function save() {
    setConfirming(false)
    setSaving(true)
    setError('')
    setResult(null)
    const supabase = createClient()
    const { data, error: rpcError } = await supabase.rpc('apply_standing_targets', {
      p_sales_target: draft.sales_target === '' ? null : Number(draft.sales_target),
      p_rsr_daily_target: draft.rsr_daily_target === '' ? null : Number(draft.rsr_daily_target),
      p_manager_target: draft.manager_target === '' ? null : Number(draft.manager_target),
      p_sales_client_cap: Number(draft.sales_client_meeting_cap),
      p_rsr_client_cap: Number(draft.rsr_client_meeting_cap),
    })

    if (rpcError) setError(rpcError.message)
    else {
      // The RPC returns a single row; supabase-js hands back an array.
      const row = (Array.isArray(data) ? data[0] : data) as ApplyResult | undefined

      // Not a duplicate of the per-field rows apply_standing_targets() writes
      // into cutoff_period_changes: those record what happened to each PERIOD,
      // this records that a person changed the standing numbers. The first
      // answers "why is this period's target 40", the second "who decided that".
      //
      // `settings` is still the pre-save state here — `onSaved()` has not run
      // yet, so this is the last moment the old targets are in hand.
      const was = toDraft(settings)
      void recordAuditLog({
        action: 'standing_targets.applied',
        entityTable: 'quota_settings',
        entityLabel: 'Standing targets',
        // The RPC's own count is the point: this does not change one setting,
        // it rewrites the targets on every open period at once.
        summary:
          `Applied standing targets` +
          (row?.periods_updated != null
            ? ` to ${row.periods_updated} open period${row.periods_updated === 1 ? '' : 's'}`
            : ''),
        changes: buildChanges(
          was as unknown as Record<string, unknown>,
          draft as unknown as Record<string, unknown>,
          [
            { field: 'sales_target', label: 'Sales monthly target' },
            { field: 'rsr_daily_target', label: 'RSR daily target' },
            { field: 'manager_target', label: 'Manager monthly target' },
            { field: 'sales_client_meeting_cap', label: 'Sales visit cap' },
            { field: 'rsr_client_meeting_cap', label: 'RSR visit cap' },
          ],
        ),
      })

      setResult(row ?? null)
      await onSaved()
    }
    setSaving(false)
  }

  const valid =
    Number(draft.sales_client_meeting_cap) > 0 && Number(draft.rsr_client_meeting_cap) > 0

  // Compared against what is stored, so the notice appears while a change is
  // unsaved and again on any reload where the two still disagree — never on a
  // card the admin only opened to read. `stored` is computed above, alongside
  // the pending-change list the confirmation is built from.
  const capChanged =
    draft.sales_client_meeting_cap !== stored.sales_client_meeting_cap ||
    draft.rsr_client_meeting_cap !== stored.rsr_client_meeting_cap

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          <CardTitle>Quota targets</CardTitle>
        </div>
        <CardDescription>
          Change these whenever you need to. Targets apply to the running cutoff and every
          upcoming one, and are what new periods start from. Finished cutoffs keep the numbers
          they were measured against.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Said once, above all three, rather than repeated per field: the
            window is the thing that changed in 105, and it is the same window
            for every target on this row. */}
        <p className="text-xs text-muted-foreground">
          Measured over a <strong>calendar month</strong> — {monthLabel(month)} has{' '}
          {workingDays} working days.
        </p>

        <div className="grid gap-3 sm:grid-cols-3 items-start">
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
              Meetings per <strong>month</strong>, for each sales specialist.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="q-manager">Manager target</Label>
            <Input
              id="q-manager"
              type="number"
              min={1}
              placeholder="Not set"
              disabled={!canEdit}
              value={draft.manager_target}
              onChange={e => set('manager_target', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Meetings per <strong>month</strong>, for each sales manager — the same number
              whether they run a Sales or an RSR team.
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
                  month is the exact confusion this feature was built to fix —
                  the admin should see what they are actually setting. */}
              {derived != null && (
                <>
                  {' '}
                  {rsrDaily} × {workingDays} working days ={' '}
                  <span className="text-foreground font-medium">{derived}</span> this month.
                </>
              )}
            </p>
          </div>
        </div>

        {/* Its own block under a rule, because these are a different kind of
            number from the two above — a ceiling, not a goal — and the split
            makes that easy to lose. The heading says so once rather than
            repeating "limit, not target" on each field. */}
        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Visit limit per client</p>
            <p className="text-xs text-muted-foreground">
              The most times one client may be visited in a cutoff. A ceiling, not something
              to fill. Each role has its own allowance against a client — Sales using up its
              visits leaves RSR&apos;s untouched. A manager follows the limit of the team they
              run, counted separately again, so joining a visit never spends their agent&apos;s
              allowance.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 items-start">
            <div className="grid gap-1.5">
              <Label htmlFor="q-cap-sales">Sales limit</Label>
              <Input
                id="q-cap-sales"
                type="number"
                min={1}
                disabled={!canEdit}
                value={draft.sales_client_meeting_cap}
                onChange={e => set('sales_client_meeting_cap', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Visits per client per cutoff, for each sales specialist.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="q-cap-rsr">RSR limit</Label>
              <Input
                id="q-cap-rsr"
                type="number"
                min={1}
                disabled={!canEdit}
                value={draft.rsr_client_meeting_cap}
                onChange={e => set('rsr_client_meeting_cap', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Visits per client per cutoff, for each RSR.
              </p>
            </div>
          </div>

          {/* The one consequence an admin cannot see from the fields, and the
              one that generates the support question: they typed a number, saved
              it, and the running cutoff did not move. Stated only when a change
              is actually pending, so it is news rather than boilerplate. */}
          {capChanged && (
            <Alert>
              <Info className="w-4 h-4" />
              <AlertTitle>This takes effect next cutoff</AlertTitle>
              <AlertDescription>
                A visit limit reaches only cutoffs that have not started. Meetings in the
                running cutoff already hold slots allocated against its current limit, and
                changing the ceiling now cannot un-slot them.
              </AlertDescription>
            </Alert>
          )}
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
          <Button
            disabled={!valid || saving || pending.length === 0}
            onClick={() => setConfirming(true)}
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save targets
          </Button>
        )}

        {/*
          Confirmation, not obstruction. These numbers are meant to be edited
          freely, so the dialog earns its place by saying what the edit DOES
          rather than by asking whether the admin meant it: which numbers move,
          that the current month's figures restate the moment they do, and that
          a visit limit lands later than a target does. The last is the one
          consequence nobody predicts, and the one that generates the support
          question when a saved limit does not appear to take.
        */}
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          busy={saving}
          title="Apply these quota numbers?"
          confirmLabel="Apply"
          description={
            <div className="space-y-2">
              <ul className="space-y-0.5">
                {pending.map(p => (
                  <li key={p.label}>
                    <span className="text-foreground font-medium">{p.label}</span> {p.from} →{' '}
                    <span className="text-foreground font-medium">{p.to}</span> {p.unit}
                  </li>
                ))}
              </ul>
              {targetChanged && (
                <p>
                  Takes effect on the running cutoff and every upcoming one. Progress for{' '}
                  {monthLabel(month)} is measured against the new target straight away, so
                  everyone&apos;s percentage moves — including on the agents&apos; phones. No
                  meeting already recorded is reclassified, and finished cutoffs keep the
                  numbers they were measured against.
                </p>
              )}
              {capChanged && (
                <p>
                  The visit limit reaches only cutoffs that have not started. The running one
                  keeps its current limit, because meetings in it already hold slots allocated
                  against that ceiling.
                </p>
              )}
            </div>
          }
          onConfirm={save}
        />
      </CardContent>
    </Card>
  )
}
