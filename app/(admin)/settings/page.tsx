'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Header } from '@/components/header'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { canManageUsers } from '@/lib/permissions'
import { useCutoffPeriods, useQuotaSettings } from '@/lib/hooks/use-cutoff'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StandingTargetsCard } from '@/components/settings/standing-targets-card'
import { HolidaysCard } from '@/components/settings/holidays-card'
import { PeriodHistoryCard } from '@/components/settings/period-history-card'
import { CurrentCutoffSummary } from '@/components/settings/current-cutoff-summary'
import {
  activePeriod,
  capForRole,
  capsDiffer,
  generatePeriods,
  overlappingWithExisting,
  periodDateLabel,
  periodPhase,
  type PeriodPhase,
} from '@/lib/cutoff'
import { createClient } from '@/lib/supabase/client'
import { recordAuditLog } from '@/lib/audit/actions'
import { TONE_CLASS } from '@/lib/status-styles'
import type { CutoffPeriod, CutoffPeriodStatus } from '@/types'
import { CalendarRange, Info, TriangleAlert, Plus, Loader2, Repeat } from 'lucide-react'

/** Tone per period status — shown only when the status is not the plain case. */
const STATUS_TONE: Record<CutoffPeriodStatus, keyof typeof TONE_CLASS> = {
  draft: 'neutral',
  scheduled: 'navy',
  active: 'brand',
  closed: 'neutral',
  superseded: 'amber',
}

/**
 * Periods are generated ahead as `active`, so the status column no longer says
 * which one is running — the dates do. This is the badge an admin reads first.
 */
const PHASE_META: Record<PeriodPhase, { label: string; tone: keyof typeof TONE_CLASS }> = {
  current: { label: 'Current', tone: 'brand' },
  upcoming: { label: 'Upcoming', tone: 'navy' },
  ended: { label: 'Ended', tone: 'neutral' },
}

/** Reading order: what is running, then what is next, then history. */
const PHASE_ORDER: Record<PeriodPhase, number> = { current: 0, upcoming: 1, ended: 2 }

/**
 * The repeating generator's own state — SHAPE ONLY.
 *
 * It deliberately carries no targets. Generated periods inherit the standing
 * numbers from `quota_settings`, which is not a tidiness preference: the fields
 * that used to live here could not keep what they were given. Saving the Quota
 * targets card calls `apply_standing_targets()`, which rewrites the targets on
 * every period that has not ended — so a number typed here survived only until
 * the next save, and the form was promising a per-batch override the database
 * had no way to honour.
 */
interface RepeatDraft {
  endDays: string
  fromMonth: string
  months: string
}

/**
 * 'YYYY-MM' for THIS month.
 *
 * This month rather than next, because the field selects the months periods
 * *end* in and the first period reaches back before that. Defaulting to next
 * month left today in the gap ahead of the earliest period: two dozen rows, all
 * correct, none of them covering the day the admin was standing on.
 */
function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

const EMPTY_REPEAT: RepeatDraft = {
  // The company's actual cycle, per the supervisor 2026-08-03. A default, not a
  // constant — the field below edits it.
  endDays: '8, 23',
  fromMonth: '',
  months: '12',
}

/**
 * Shortcuts for shapes that come up often — not the set of allowed answers. The
 * field below takes any days at all, and a cutoff that does not repeat monthly
 * is a single period, created by hand.
 */
const QUICK_PATTERNS: { label: string; value: string }[] = [
  { label: '8th & 23rd', value: '8, 23' },
  { label: '15th & end of month', value: '15, 31' },
  { label: '10th & 25th', value: '10, 25' },
  { label: 'End of month only', value: '31' },
]

interface DraftPeriod {
  label: string
  starts_on: string
  ends_on: string
  sales_client_meeting_cap: string
  rsr_client_meeting_cap: string
  sales_target: string
  rsr_target: string
  manager_target: string
}

const EMPTY_DRAFT: DraftPeriod = {
  label: '',
  starts_on: '',
  ends_on: '',
  sales_client_meeting_cap: '2',
  rsr_client_meeting_cap: '2',
  sales_target: '',
  rsr_target: '',
  manager_target: '',
}

/**
 * Settings — cutoff periods.
 *
 * Backs migration 057's `cutoff_periods`, which is the switch the whole quota
 * feature hangs off: with no period defined, the attribution trigger (059)
 * classifies every new meeting as `unattributed` and the Maps quota lens hides
 * itself. Nothing seeds a period, deliberately — the contract's rule is that no
 * cutoff is enforced until an admin sets one.
 *
 * Two constraints from the contract shape this page rather than the other way
 * round:
 *  - O-8, immutability: an active or closed period is never edited in place.
 *    It is superseded by a new row. Only draft and scheduled rows take edits.
 *  - Non-overlap: a GiST exclusion constraint rejects two scheduled/active
 *    periods whose dates intersect. The UI surfaces that error rather than
 *    trying to pre-empt every case, because the database is the only place that
 *    can decide it without a race.
 *
 * Route access is inherited: '/settings' is absent from every SCOPE_ROUTES
 * entry, so canAccessRoute admits only unrestricted admins and superadmins.
 * Writes are narrowed once more to superadmin — a period change moves every
 * agent's quota window.
 */
export default function SettingsPage() {
  const { profile } = useCurrentProfile()
  const canEdit = canManageUsers(profile?.role)
  const { periods, loading, error, refresh } = useCutoffPeriods()
  const { settings, holidays, refresh: refreshSettings } = useQuotaSettings()

  /** Both, because a target change rewrites period rows and vice versa. */
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshSettings()])
  }, [refresh, refreshSettings])

  const [draft, setDraft] = useState<DraftPeriod>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const [repeat, setRepeat] = useState<RepeatDraft>({ ...EMPTY_REPEAT, fromMonth: currentMonth() })

  /**
   * The hand-built period starts from the standing numbers rather than a literal
   * in the code — the whole point of quota_settings is that 35, 16 and 2 live in
   * one place. Applied once, when settings first arrive; typing over them
   * afterwards is a deliberate per-period override and must not be clobbered by
   * a re-render.
   *
   * Only this form. The generator inherits the same numbers silently at insert
   * time (see `generate`), because it offers no override to seed.
   */
  const [inherited, setInherited] = useState(false)
  useEffect(() => {
    if (inherited || !settings) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInherited(true)
    setDraft(d => ({
      ...d,
      // Through the pre-074 shared number, so a settings row written before the
      // per-role split still seeds the limit that is genuinely in force.
      sales_client_meeting_cap: String(
        settings.sales_client_meeting_cap ?? settings.client_meeting_cap
      ),
      rsr_client_meeting_cap: String(
        settings.rsr_client_meeting_cap ?? settings.client_meeting_cap
      ),
      sales_target: settings.sales_target != null ? String(settings.sales_target) : '',
      rsr_target: settings.rsr_daily_target != null ? String(settings.rsr_daily_target) : '',
      manager_target: settings.manager_target != null ? String(settings.manager_target) : '',
    }))
  }, [settings, inherited])
  const [generating, setGenerating] = useState(false)
  const [showAll, setShowAll] = useState(false)

  /**
   * Which creation form is open, if any.
   *
   * Closed by default, and only one at a time. Both forms used to sit open
   * below the period list permanently — three stacked cards where two were
   * tools an admin reaches for a few times a year, pushing the list they
   * actually came to read off the top of the screen.
   */
  const [creator, setCreator] = useState<'none' | 'repeat' | 'single'>('none')
  const toggleCreator = (which: 'repeat' | 'single') =>
    setCreator(c => (c === which ? 'none' : which))

  const active = activePeriod(periods)

  function set<K extends keyof DraftPeriod>(key: K, value: DraftPeriod[K]) {
    setDraft(d => ({ ...d, [key]: value }))
  }

  function setRepeatField<K extends keyof RepeatDraft>(key: K, value: RepeatDraft[K]) {
    setRepeat(r => ({ ...r, [key]: value }))
  }

  /** Current first, then soonest upcoming, then most recent history. */
  const ordered = useMemo(
    () =>
      [...periods].sort((a, b) => {
        const phaseA = periodPhase(a)
        const phaseB = periodPhase(b)
        if (phaseA !== phaseB) return PHASE_ORDER[phaseA] - PHASE_ORDER[phaseB]
        return phaseA === 'upcoming'
          ? a.starts_on.localeCompare(b.starts_on)
          : b.starts_on.localeCompare(a.starts_on)
      }),
    [periods]
  )

  // A year of periods is a long list to scroll past to reach the form below it.
  const visible = showAll ? ordered : ordered.slice(0, 6)

  /**
   * When nothing covers today, the date the soonest period opens — the one fact
   * that turns "no period is active" from a puzzle into an instruction.
   * Null when every period is already behind us.
   */
  const nextStart = useMemo(() => {
    if (active) return null
    const upcoming = periods
      .filter(p => periodPhase(p) === 'upcoming')
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0]
    return upcoming ? periodDateLabel(upcoming).split(' – ')[0] : null
  }, [active, periods])

  const endDays = useMemo(
    () =>
      repeat.endDays
        .split(',')
        .map(part => Number(part.trim()))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 31),
    [repeat.endDays]
  )

  const preview = useMemo(
    () =>
      generatePeriods({
        endDays,
        fromMonth: repeat.fromMonth,
        months: Number(repeat.months),
      }),
    [endDays, repeat.fromMonth, repeat.months]
  )

  // Re-running the generator next year should add only what is missing rather
  // than failing on the first collision, so overlaps are skipped, not rejected.
  const skipped = useMemo(() => overlappingWithExisting(preview, periods), [preview, periods])
  const toCreate = useMemo(
    () => preview.filter(p => !skipped.includes(p)),
    [preview, skipped]
  )
  // `settings` gates the button because the generated rows take their numbers
  // from it. client_meeting_cap is NOT NULL on the table, so inserting before
  // the standing row has loaded would either fail or invent a cap.
  const repeatValid =
    endDays.length > 0 &&
    repeat.fromMonth !== '' &&
    Number(repeat.months) >= 1 &&
    settings != null &&
    toCreate.length > 0

  /**
   * Insert the whole batch as `active`.
   *
   * `active` rather than `scheduled` because migration 059 attributes a meeting
   * only when the period is active AND the date falls inside it — a scheduled
   * period covering today attributes nothing, so generating ahead as scheduled
   * would just move the twice-a-month chore from creating rows to activating
   * them. A period starting in November is inert until November regardless.
   *
   * One statement, so the non-overlap constraint either takes the batch or
   * rejects it whole. A half-generated year is worse than none.
   *
   * Targets come from `quota_settings`, never from this form — see RepeatDraft.
   * Guarded by `repeatValid`, so `settings` is loaded by the time this runs.
   */
  async function generate() {
    if (!settings) return
    setGenerating(true)
    setFormError('')
    const supabase = createClient()
    const { error: insertError } = await supabase.from('cutoff_periods').insert(
      toCreate.map(row => ({
        label: row.label,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
        // Per role since 074. client_meeting_cap is still written because the
        // column is NOT NULL and mobile's sync-down selects it — carried as the
        // looser of the two, matching what apply_standing_targets() maintains.
        sales_client_meeting_cap:
          settings.sales_client_meeting_cap ?? settings.client_meeting_cap,
        rsr_client_meeting_cap: settings.rsr_client_meeting_cap ?? settings.client_meeting_cap,
        client_meeting_cap: Math.max(
          settings.sales_client_meeting_cap ?? settings.client_meeting_cap,
          settings.rsr_client_meeting_cap ?? settings.client_meeting_cap
        ),
        sales_target: settings.sales_target,
        // rsr_daily_target, not the deprecated rsr_target: an RSR is measured
        // per working day, and 064 moved the number to a column that says so.
        rsr_daily_target: settings.rsr_daily_target,
        // Snapshotted like the other two. Without it a generated period carries
        // a null manager target, which renders as "not configured" and would
        // silently drop every manager's quota the month it starts.
        manager_target: settings.manager_target,
        status: 'active' as const,
        created_by: profile?.id ?? null,
      }))
    )

    if (insertError) {
      setFormError(
        insertError.message.includes('cutoff_periods_no_overlap')
          ? 'Some of these dates overlap a period that already exists. Nothing was created.'
          : insertError.message
      )
    } else {
      // One entry for the batch, not one per period — the admin performed a
      // single act ("generate a year"), and 24 near-identical rows would bury
      // everything around them in the log.
      void recordAuditLog({
        action: 'cutoff_period.created',
        entityTable: 'cutoff_periods',
        entityLabel: `${toCreate.length} periods`,
        summary:
          `Generated ${toCreate.length} cutoff period${toCreate.length === 1 ? '' : 's'} ` +
          `(${toCreate[0]?.label} – ${toCreate[toCreate.length - 1]?.label})`,
        metadata: { labels: toCreate.map(r => r.label) },
      })
      await refresh()
    }
    setGenerating(false)
  }

  const draftValid =
    draft.label.trim() !== '' &&
    draft.starts_on !== '' &&
    draft.ends_on !== '' &&
    draft.ends_on >= draft.starts_on &&
    Number(draft.sales_client_meeting_cap) > 0 &&
    Number(draft.rsr_client_meeting_cap) > 0

  async function createPeriod(status: CutoffPeriodStatus) {
    setCreating(true)
    setFormError('')
    const supabase = createClient()
    const { error: insertError } = await supabase.from('cutoff_periods').insert({
      label: draft.label.trim(),
      starts_on: draft.starts_on,
      ends_on: draft.ends_on,
      sales_client_meeting_cap: Number(draft.sales_client_meeting_cap),
      rsr_client_meeting_cap: Number(draft.rsr_client_meeting_cap),
      // NOT NULL and read by mobile's sync-down — see `generate`.
      client_meeting_cap: Math.max(
        Number(draft.sales_client_meeting_cap),
        Number(draft.rsr_client_meeting_cap)
      ),
      // Empty means "not configured for this role" and must stay null — a zero
      // would render as a real target of nothing (contract O-6).
      sales_target: draft.sales_target === '' ? null : Number(draft.sales_target),
      rsr_daily_target: draft.rsr_target === '' ? null : Number(draft.rsr_target),
      manager_target: draft.manager_target === '' ? null : Number(draft.manager_target),
      status,
      created_by: profile?.id ?? null,
    })

    if (insertError) {
      // The exclusion constraint is the expected failure here, and its raw
      // message says nothing an admin can act on.
      setFormError(
        insertError.message.includes('cutoff_periods_no_overlap')
          ? 'Those dates overlap a period that is already scheduled or active. Close or reschedule the other one first.'
          : insertError.message
      )
    } else {
      void recordAuditLog({
        action: 'cutoff_period.created',
        entityTable: 'cutoff_periods',
        entityLabel: draft.label.trim(),
        summary: `Created the cutoff period "${draft.label.trim()}" as ${status}`,
        changes: [
          { field: 'dates', label: 'Dates', from: null, to: `${draft.starts_on} – ${draft.ends_on}` },
          { field: 'status', label: 'Status', from: null, to: status },
          { field: 'sales_client_meeting_cap', label: 'Sales visit cap', from: null, to: String(draft.sales_client_meeting_cap) },
          { field: 'rsr_client_meeting_cap', label: 'RSR visit cap', from: null, to: String(draft.rsr_client_meeting_cap) },
          { field: 'sales_target', label: 'Sales monthly target', from: null, to: draft.sales_target === '' ? null : String(draft.sales_target) },
          { field: 'rsr_daily_target', label: 'RSR daily target', from: null, to: draft.rsr_target === '' ? null : String(draft.rsr_target) },
          { field: 'manager_target', label: 'Manager monthly target', from: null, to: draft.manager_target === '' ? null : String(draft.manager_target) },
        ],
      })
      setDraft(EMPTY_DRAFT)
      await refresh()
    }
    setCreating(false)
  }

  /** Status-only transition. Never touches dates or targets on a live row. */
  async function setStatus(period: CutoffPeriod, status: CutoffPeriodStatus) {
    setBusyId(period.id)
    setFormError('')
    const supabase = createClient()
    const { error: updateError } = await supabase
      .from('cutoff_periods')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', period.id)

    if (updateError) {
      setFormError(
        updateError.message.includes('cutoff_periods_no_overlap')
          ? 'Activating this period would overlap another scheduled or active one.'
          : updateError.message
      )
    } else {
      // Worth its own action rather than folding into a generic update: closing
      // or activating a period is what decides which meetings get attributed to
      // which quota, so it is the settings change most likely to be questioned.
      void recordAuditLog({
        action: 'cutoff_period.status_changed',
        entityTable: 'cutoff_periods',
        entityId: period.id,
        entityLabel: period.label,
        summary: `Changed cutoff period "${period.label}" from ${period.status} to ${status}`,
        changes: [{ field: 'status', label: 'Status', from: period.status, to: status }],
      })
      await refresh()
    }
    setBusyId(null)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Header
        title="Settings"
        // A generated period is named after its own dates, so printing both
        // repeats the same words twice. A hand-made period usually is not.
        subtitle={
          active
            ? `Active cutoff · ${active.label}${
                active.label === periodDateLabel(active) ? '' : ` · ${periodDateLabel(active)}`
              }`
            : 'No active cutoff period'
        }
      />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Two different problems wearing the same words. With no periods at all
            the answer is "make some"; with periods that all start later, the
            answer is "you have a gap", and saying "nothing seeds a period" there
            reads as though the twenty-four rows on screen do not exist. */}
        {!active && !loading && periods.length === 0 && (
          <Alert>
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>No period is active</AlertTitle>
            <AlertDescription>
              Until a period is active, every new meeting is recorded as{' '}
              <code>unattributed</code> — it counts toward no quota and consumes no client
              allowance — and the Maps quota lens stays hidden. Nothing seeds a period
              automatically; that is deliberate, so no cutoff rule applies before someone
              sets one.
            </AlertDescription>
          </Alert>
        )}

        {!active && !loading && periods.length > 0 && (
          <Alert variant="destructive">
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>No period covers today</AlertTitle>
            <AlertDescription>
              {nextStart ? (
                <>
                  These {periods.length} periods are all set up correctly, but the earliest
                  one does not start until <strong>{nextStart}</strong> — so today falls in
                  a gap. Meetings recorded now are <code>unattributed</code> and are never
                  moved into a period later. Run <strong>Generate periods</strong> again with
                  an earlier <em>first month to cover</em> to fill it; the periods you already
                  have are skipped automatically.
                </>
              ) : (
                <>
                  These {periods.length} periods have all ended, and no later one is
                  defined. Meetings recorded now are <code>unattributed</code> and are never
                  moved into a period later. Run <strong>Generate periods</strong> for the
                  next stretch.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        {!canEdit && (
          <Alert>
            <Info className="w-4 h-4" />
            <AlertTitle>View only</AlertTitle>
            <AlertDescription>
              A period change moves every agent&apos;s quota window, so creating and
              activating periods is limited to a super admin.
            </AlertDescription>
          </Alert>
        )}

        {(error || formError) && (
          <Alert variant="destructive">
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{formError || error}</AlertDescription>
          </Alert>
        )}

        {/* Answers "what is running and what does it want" before any control
            is offered, so the tabs below are a place to change something rather
            than the only way to find out what is currently true. */}
        {active && <CurrentCutoffSummary period={active} holidays={holidays} />}

        {/*
          One tab per job, matching the Collection and Delivery boards.

          The split is between HOW MUCH work is expected and WHEN the cutoffs
          run — two questions an admin never asks at the same moment, previously
          answered by six cards in one scroll with no seam between them. Targets
          and the working calendar share a tab because they are one calculation:
          the RSR daily figure only becomes a period expectation once the
          holidays are known.
        */}
        <Tabs defaultValue="periods">
          <TabsList>
            <TabsTrigger value="periods">Cutoff periods ({periods.length})</TabsTrigger>
            <TabsTrigger value="quota">Quota targets</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          {/* --- When the cutoffs run --- */}
          <TabsContent value="periods" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CalendarRange className="w-4 h-4 text-primary" />
                  <CardTitle>Cutoff periods</CardTitle>
                </div>
                <CardDescription>
                  When each cutoff runs. The numbers shown on a period are the ones it was
                  created with — set them under <strong>Quota targets</strong>. A role with no
                  target reads as unconfigured, never as zero.
                </CardDescription>

                {/* In the header, not floating under the card. Outline buttons on
                    the page's grey background read as disabled — they need the
                    card's own surface behind them to look pressable, and this is
                    where an action on a list belongs anyway. Generating is the
                    one an admin comes here to do, so it carries the solid fill
                    and the hand-built single period stays secondary beside it. */}
                {canEdit && (
                  <CardAction className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={creator === 'repeat' ? 'secondary' : 'default'}
                      size="sm"
                      onClick={() => toggleCreator('repeat')}
                    >
                      <Repeat className="w-4 h-4" />
                      {creator === 'repeat' ? 'Close generator' : 'Generate periods'}
                    </Button>
                    <Button
                      variant={creator === 'single' ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => toggleCreator('single')}
                    >
                      <Plus className="w-4 h-4" />
                      {creator === 'single' ? 'Close form' : 'Add single period'}
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {loading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading periods…
                  </div>
                )}

                {!loading && periods.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">
                    No periods defined yet. Use <strong>Generate periods</strong> for a
                    repeating set, or <strong>Add single period</strong> for one by hand.
                  </p>
                )}

                {visible.map(period => {
                  const phase = periodPhase(period)
                  return (
                  <div
                    key={period.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border p-3"
                  >
                    <Badge variant="tone" className={TONE_CLASS[PHASE_META[phase].tone]}>
                      {PHASE_META[phase].label}
                    </Badge>
                    {/* The status only earns its own badge when it says something the
                        dates do not — a closed or superseded row, or one not yet live. */}
                    {period.status !== 'active' && (
                      <Badge variant="tone" className={TONE_CLASS[STATUS_TONE[period.status]]}>
                        {period.status}
                      </Badge>
                    )}
                    <span className="text-sm font-medium text-foreground">{period.label}</span>
                    {period.label !== periodDateLabel(period) && (
                      <span className="text-xs text-muted-foreground">{periodDateLabel(period)}</span>
                    )}

                    {/* Units spelled out. "RSR 16" beside "Sales 35" reads as two
                        comparable numbers, and they are not — since migration 105
                        Sales and Manager are whole-MONTH figures while RSR is a
                        single day's, so the month a row belongs to matters more
                        than the fortnight it runs over. */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground ml-auto">
                      {/* Collapsed to one figure while the two roles agree,
                          which is every period until an admin makes them
                          differ. Printing "Limit 2/2" on twenty-four identical
                          rows is noise that hides the row where it is 2/4. */}
                      <span>
                        Limit{' '}
                        <span className="text-foreground font-medium">
                          {capsDiffer(period)
                            ? `${capForRole('sales_specialist', period)} Sales · ${capForRole('rsr', period)} RSR`
                            : capForRole('sales_specialist', period)}
                        </span>
                        /client
                      </span>
                      <span>
                        Sales{' '}
                        <span className="text-foreground font-medium">
                          {period.sales_target ?? '—'}
                        </span>
                        /month
                      </span>
                      <span>
                        Manager{' '}
                        <span className="text-foreground font-medium">
                          {period.manager_target ?? '—'}
                        </span>
                        /month
                      </span>
                      <span>
                        RSR{' '}
                        <span className="text-foreground font-medium">
                          {period.rsr_daily_target ?? '—'}
                        </span>
                        /day
                      </span>
                    </div>

                    {canEdit && (
                      <div className="flex items-center gap-1.5 w-full sm:w-auto">
                        {(period.status === 'draft' || period.status === 'scheduled') && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === period.id}
                            onClick={() => setStatus(period, 'active')}
                          >
                            Activate
                          </Button>
                        )}
                        {/* Named for what it does to THIS period, not for the
                            status it writes. Generating a year ahead means two
                            dozen rows are `active` at once, so a single "Close"
                            label sat on every one of them — including periods
                            that had not started, where closing is not ending
                            something but calling it off. Only the row actually
                            running gets the emphasis; the rest stay quiet, since
                            closing a future period silently opens a gap that
                            nothing later moves meetings out of. */}
                        {period.status === 'active' && (
                          <Button
                            size="sm"
                            variant={phase === 'current' ? 'outline' : 'ghost'}
                            disabled={busyId === period.id}
                            onClick={() => setStatus(period, 'closed')}
                          >
                            {phase === 'upcoming' ? 'Cancel' : 'Close'}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  )
                })}

                {ordered.length > visible.length && (
                  <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                    Show all {ordered.length} periods
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* ---- Generate a repeating set ------------------------------------- */}
            {canEdit && creator === 'repeat' && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Repeat className="w-4 h-4 text-primary" />
                    <CardTitle>Generate repeating periods</CardTitle>
                  </div>
                  <CardDescription>
                    Set the shape once and create a year of periods at a time. They are still
                    stored one row per period — this only saves you entering each one. Dates
                    that already have a period are skipped, so you can run this again later to
                    top up.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="r-ends">Cutoff ends on day</Label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {QUICK_PATTERNS.map(p => (
                        <Button
                          key={p.value}
                          type="button"
                          size="sm"
                          variant={endDays.join(', ') === p.value ? 'default' : 'outline'}
                          onClick={() => setRepeatField('endDays', p.value)}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                    <Input
                      id="r-ends"
                      placeholder="8, 23"
                      value={repeat.endDays}
                      onChange={e => setRepeatField('endDays', e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Any days of the month, separated by commas — the buttons above are just
                      shortcuts. Each period starts the day after the previous one ended, so a
                      cutoff can run across a month boundary and no day is ever left uncovered.
                      Use 31 to mean the last day, whatever the month is.
                    </p>
                  </div>

                  {/* items-start, or the cells stretch to match the taller one and the
                      inner grid spreads its rows to fill — which drops this row's label
                      and input below the ones beside it, purely because only one column
                      carries a hint underneath. */}
                  <div className="grid gap-3 sm:grid-cols-2 items-start">
                    <div className="grid gap-1.5">
                      <Label htmlFor="r-from">First month to cover</Label>
                      <Input
                        id="r-from"
                        type="month"
                        value={repeat.fromMonth}
                        onChange={e => setRepeatField('fromMonth', e.target.value)}
                      />
                      {/* A period ending on the 8th began in the month before, so the
                          first row reaches back past this month. Said plainly here
                          because the preview showing an earlier date looks like a bug. */}
                      <p className="text-xs text-muted-foreground">
                        Periods that <em>end</em> in this month. The first one may start in the
                        month before.
                      </p>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="r-months">Months to cover</Label>
                      <Input
                        id="r-months"
                        type="number"
                        min={1}
                        max={36}
                        value={repeat.months}
                        onChange={e => setRepeatField('months', e.target.value)}
                      />
                    </div>
                  </div>

                  {/*
                    Read-only, not three more inputs. These numbers have exactly one
                    home — the Quota targets card above — and duplicating them here
                    would re-create the trap this section used to set: values typed
                    into a generator look per-batch, but the next "Save targets"
                    rewrites the targets on every period that has not ended.
                  */}
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                    <p className="text-xs text-muted-foreground">
                      New periods will use{' '}
                      <span className="font-medium text-foreground">
                        {settings?.sales_target != null
                          ? `Sales ${settings.sales_target} per month`
                          : 'no Sales target'}
                      </span>
                      ,{' '}
                      <span className="font-medium text-foreground">
                        {settings?.manager_target != null
                          ? `Manager ${settings.manager_target} per month`
                          : 'no Manager target'}
                      </span>
                      ,{' '}
                      <span className="font-medium text-foreground">
                        {settings?.rsr_daily_target != null
                          ? `RSR ${settings.rsr_daily_target} per working day`
                          : 'no RSR target'}
                      </span>
                      , and visit limits of{' '}
                      <span className="font-medium text-foreground">
                        {settings
                          ? `Sales ${settings.sales_client_meeting_cap ?? settings.client_meeting_cap} and RSR ${settings.rsr_client_meeting_cap ?? settings.client_meeting_cap} per client`
                          : '—'}
                      </span>
                      . Change them in Quota targets above.
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A period that needs different numbers is a single period — create it
                    by hand below, where they can be overridden.
                  </p>

                  {preview.length > 0 && (
                    <div className="rounded-lg border border-border">
                      <div className="px-3 py-2 border-b border-border flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-foreground">
                          {toCreate.length} to create
                        </span>
                        {skipped.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            · {skipped.length} skipped, already covered
                          </span>
                        )}
                      </div>
                      <div className="max-h-48 overflow-y-auto divide-y divide-border">
                        {preview.map(row => {
                          const isSkipped = skipped.includes(row)
                          return (
                            <div
                              key={row.starts_on}
                              className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                                isSkipped ? 'text-muted-foreground/60' : 'text-foreground'
                              }`}
                            >
                              <span className="font-medium w-24 shrink-0">{row.label}</span>
                              <span className="text-muted-foreground tabular-nums">
                                {row.starts_on} → {row.ends_on}
                              </span>
                              {isSkipped && <span className="ml-auto shrink-0">skipped</span>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <Button disabled={!repeatValid || generating} onClick={generate}>
                    {generating && <Loader2 className="w-4 h-4 animate-spin" />}
                    Create {toCreate.length} {toCreate.length === 1 ? 'period' : 'periods'}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* ---- New period --------------------------------------------------- */}
            {canEdit && creator === 'single' && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Plus className="w-4 h-4 text-primary" />
                    <CardTitle>Single period</CardTitle>
                  </div>
                  <CardDescription>
                    For a cutoff that does not fit the repeating shape — a holiday-shifted
                    window, or one with its own cap. Dates are inclusive on both ends and must
                    not overlap any period that is already scheduled or active.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-label">Label</Label>
                      <Input
                        id="p-label"
                        placeholder="Aug 1–15"
                        value={draft.label}
                        onChange={e => set('label', e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-start">Starts on</Label>
                      <Input
                        id="p-start"
                        type="date"
                        value={draft.starts_on}
                        onChange={e => set('starts_on', e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-end">Ends on</Label>
                      <Input
                        id="p-end"
                        type="date"
                        value={draft.ends_on}
                        onChange={e => set('ends_on', e.target.value)}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Prefilled from the standing numbers — change them only if this one
                    period genuinely differs. Note that saving Quota targets afterwards
                    rewrites the two targets on every period that has not ended, this one
                    included; the visit limits survive once the period has started.
                  </p>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-cap-sales">Sales visit limit (per client)</Label>
                      <Input
                        id="p-cap-sales"
                        type="number"
                        min={1}
                        value={draft.sales_client_meeting_cap}
                        onChange={e => set('sales_client_meeting_cap', e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        One pool across new and existing. Prospects are uncapped.
                      </p>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-cap-rsr">RSR visit limit (per client)</Label>
                      <Input
                        id="p-cap-rsr"
                        type="number"
                        min={1}
                        value={draft.rsr_client_meeting_cap}
                        onChange={e => set('rsr_client_meeting_cap', e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Counted separately from the Sales pool, not shared with it.
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-sales">Sales target (per month)</Label>
                      <Input
                        id="p-sales"
                        type="number"
                        min={1}
                        placeholder="Not configured"
                        value={draft.sales_target}
                        onChange={e => set('sales_target', e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-manager">Manager target (per month)</Label>
                      <Input
                        id="p-manager"
                        type="number"
                        min={1}
                        placeholder="Not configured"
                        value={draft.manager_target}
                        onChange={e => set('manager_target', e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="p-rsr">RSR target (per working day)</Label>
                      <Input
                        id="p-rsr"
                        type="number"
                        min={1}
                        placeholder="Not configured"
                        value={draft.rsr_target}
                        onChange={e => set('rsr_target', e.target.value)}
                      />
                    </div>
                  </div>

                  {draft.starts_on !== '' && draft.ends_on !== '' && draft.ends_on < draft.starts_on && (
                    <p className="text-xs text-destructive">The end date is before the start date.</p>
                  )}

                  <div className="flex items-center gap-2">
                    <Button disabled={!draftValid || creating} onClick={() => createPeriod('active')}>
                      {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                      Create and activate
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!draftValid || creating}
                      onClick={() => createPeriod('scheduled')}
                    >
                      Save as scheduled
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

          </TabsContent>

          {/* --- How much work is expected --- */}
          <TabsContent value="quota" className="mt-4">
            {/* Side by side from lg up, because they are one calculation read
                left to right: the RSR daily figure, then the calendar that
                turns it into a period expectation. Stacked below that width —
                two half-width forms on a laptop are worse than two full ones. */}
            <div className="grid gap-4 lg:grid-cols-2 items-start">
              <StandingTargetsCard
                settings={settings}
                holidays={holidays}
                canEdit={canEdit}
                onSaved={refreshAll}
              />

              <HolidaysCard
                holidays={holidays}
                periods={periods}
                profileId={profile?.id}
                canEdit={canEdit}
                onChanged={refreshAll}
              />
            </div>
          </TabsContent>

          {/* --- What changed, and who changed it --- */}
          <TabsContent value="history" className="mt-4">
            <PeriodHistoryCard periods={periods} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
