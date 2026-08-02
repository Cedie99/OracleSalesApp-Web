'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { canManageUsers } from '@/lib/permissions'
import { useQuotaConfig, type QuotaConfig } from '@/lib/hooks/use-quota-config'
import { cutoffPeriodFor } from '@/lib/cutoff'
import { CUSTOMER_TYPE_LABEL } from '@/lib/status-styles'
import type { CustomerType } from '@/types'
import { CalendarRange, Info, Gauge, RotateCcw, Check, TriangleAlert } from 'lucide-react'

/** Anchors are constrained to 1–28 — see the note in the picker below. */
const SELECTABLE_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

/** The stages a visit cap can bind. Ordered as the lifecycle runs. */
const CAPPABLE_TYPES: CustomerType[] = ['prospect', 'in_progress', 'new', 'existing']

/**
 * Settings — quota configuration.
 *
 * Exists because of the rule the team settled on 2026-08-02: cutoff dates are
 * set by an admin, never hardcoded. That closes an item the mobile side had
 * left open since 2026-07-25 ("exact cut-off dates should be set by an
 * Admin-configurable calendar"), and it is what makes the Maps quota lens
 * meaningful — the lens counts visits per cutoff, so someone has to be able to
 * say when a cutoff starts.
 *
 * Route access comes free from lib/permissions.ts: '/settings' is absent from
 * every SCOPE_ROUTES entry, so canAccessRoute only passes an unrestricted admin
 * or a superadmin, exactly like '/users'. Editing is narrowed once more to
 * superadmin (canManageUsers) — changing an anchor day silently moves every
 * agent's quota window, which is not a change a scoped admin should make in
 * passing.
 */
export default function SettingsPage() {
  const { profile } = useCurrentProfile()
  const canEdit = canManageUsers(profile?.role)
  const { calendars, policies, period, isConfigured, save, reset } = useQuotaConfig()

  // Draft state, so a half-typed anchor list never reaches the map mid-edit.
  const [draft, setDraft] = useState<QuotaConfig | null>(null)
  const working: QuotaConfig = draft ?? { calendars, policies }
  const dirty = draft !== null

  const workingCalendar = working.calendars[0] ?? null
  const capPolicy = working.policies.find(p => p.policy_kind === 'client_visit_cap') ?? null

  // Preview the period the working draft would produce, so an admin sees the
  // consequence of an anchor change before saving it.
  const previewPeriod = workingCalendar ? cutoffPeriodFor(new Date(), workingCalendar) : null

  function edit(mutate: (config: QuotaConfig) => QuotaConfig) {
    setDraft(mutate(structuredClone(working)))
  }

  function toggleAnchor(day: number) {
    edit(config => {
      const cal = config.calendars[0]
      if (!cal) return config
      const has = cal.anchor_days.includes(day)
      const next = has ? cal.anchor_days.filter(d => d !== day) : [...cal.anchor_days, day]
      // At least one boundary, at most four — beyond that a "cutoff" stops
      // being a payroll period and the label stops fitting anywhere.
      if (next.length === 0 || next.length > 4) return config
      cal.anchor_days = next.sort((a, b) => a - b)
      return config
    })
  }

  function toggleAppliesTo(type: CustomerType) {
    edit(config => {
      const policy = config.policies.find(p => p.policy_kind === 'client_visit_cap')
      if (!policy) return config
      const current = policy.applies_to ?? []
      policy.applies_to = current.includes(type)
        ? current.filter(t => t !== type)
        : [...current, type]
      return config
    })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Header
        title="Settings"
        subtitle={
          isConfigured && period
            ? `Current cutoff · ${period.label}`
            : 'No cutoff configured'
        }
      />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* The honest caveat. This page writes to the browser, not to Supabase —
            `cutoff_calendar` doesn't exist yet and `quota_policy` belongs to the
            mobile repo, so the migration is theirs to apply. */}
        <Alert>
          <Info className="w-4 h-4" />
          <AlertTitle>Not saved to the database yet</AlertTitle>
          <AlertDescription>
            These settings are stored in this browser only, so the cutoff rules can be
            reviewed and demoed ahead of the schema. The <code>cutoff_calendar</code> table
            does not exist yet and <code>quota_policy</code> is owned by the mobile repo —
            once that migration lands, this page reads and writes the real rows with no
            change to how it works.
          </AlertDescription>
        </Alert>

        {!canEdit && (
          <Alert>
            <TriangleAlert className="w-4 h-4" />
            <AlertTitle>View only</AlertTitle>
            <AlertDescription>
              Changing a cutoff moves every agent&apos;s quota window, so edits are limited to
              a super admin.
            </AlertDescription>
          </Alert>
        )}

        {/* ---- Cutoff calendar --------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CalendarRange className="w-4 h-4 text-primary" />
              <CardTitle>Cutoff calendar</CardTitle>
            </div>
            <CardDescription>
              The days each pay period starts on. Periods run from one anchor to the next, so
              two anchors give the usual semi-monthly cutoff and month length takes care of
              itself.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {workingCalendar ? (
              <>
                <div className="grid gap-1.5 max-w-xs">
                  <Label htmlFor="cutoff-name">Name</Label>
                  <Input
                    id="cutoff-name"
                    value={workingCalendar.name}
                    disabled={!canEdit}
                    onChange={e =>
                      edit(config => {
                        config.calendars[0].name = e.target.value
                        return config
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Period start days</Label>
                  {/* 1–28 only. A 29th/30th/31st anchor has no meaning in
                      February and every fallback is wrong for a payroll
                      boundary, so the choice is removed rather than guessed. */}
                  <div className="flex flex-wrap gap-1.5">
                    {SELECTABLE_DAYS.map(day => {
                      const on = workingCalendar.anchor_days.includes(day)
                      return (
                        <button
                          key={day}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => toggleAnchor(day)}
                          className={`w-9 h-9 rounded-full text-xs font-medium tabular-nums transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                            on
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          {day}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Days 29–31 are not selectable — they don&apos;t exist in every month.
                  </p>
                </div>

                <div className="grid gap-1.5 max-w-xs">
                  <Label htmlFor="cutoff-tz">Timezone</Label>
                  <Input
                    id="cutoff-tz"
                    value={workingCalendar.timezone}
                    disabled={!canEdit}
                    onChange={e =>
                      edit(config => {
                        config.calendars[0].timezone = e.target.value
                        return config
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    A cutoff starts at local midnight, so this decides where the boundary
                    actually falls.
                  </p>
                </div>

                <Separator />

                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Current period would be</span>
                  <Badge variant="outline" className="font-medium">
                    {previewPeriod?.label ?? 'undefined'}
                  </Badge>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground space-y-3">
                <p>
                  No cutoff is configured, so visit-quota tracking is switched off across the
                  app — the Maps quota lens is hidden rather than assuming a default.
                </p>
                {canEdit && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      edit(config => {
                        config.calendars = [
                          {
                            id: 'semi-monthly',
                            name: 'Semi-monthly',
                            anchor_days: [1, 16],
                            timezone: 'Asia/Manila',
                            effective_from: new Date().toISOString().slice(0, 10),
                            effective_until: null,
                            is_active: true,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                          },
                        ]
                        return config
                      })
                    }
                  >
                    Add a semi-monthly calendar
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- Visit cap ---------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-primary" />
              <CardTitle>Visits per client, per cutoff</CardTitle>
            </div>
            <CardDescription>
              A ceiling, not a target — an account below the limit is not flagged. Stages left
              unticked are uncapped, which is how prospects are meant to stay.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {capPolicy && (
              <>
                <div className="grid gap-1.5 max-w-[8rem]">
                  <Label htmlFor="visit-cap">Maximum visits</Label>
                  <Input
                    id="visit-cap"
                    type="number"
                    min={1}
                    value={capPolicy.target_value}
                    disabled={!canEdit}
                    onChange={e =>
                      edit(config => {
                        const policy = config.policies.find(p => p.policy_kind === 'client_visit_cap')
                        // An empty or zero cap would read as "no visits allowed",
                        // which is never what an admin means — floor it at 1.
                        if (policy) policy.target_value = Math.max(1, Number(e.target.value) || 1)
                        return config
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Applies to</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPPABLE_TYPES.map(type => {
                      const on = capPolicy.applies_to?.includes(type) ?? false
                      return (
                        <button
                          key={type}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => toggleAppliesTo(type)}
                          className={`flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                            on
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          {on && <Check className="w-3 h-3" />}
                          {CUSTOMER_TYPE_LABEL[type]}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Save bar ------------------------------------------------------- */}
      {canEdit && (
        <div className="shrink-0 border-t border-border bg-card/50 px-4 py-3 flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              setDraft(null)
            }}
          >
            <RotateCcw className="w-4 h-4" />
            Reset to defaults
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            <Button variant="outline" disabled={!dirty} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={!dirty}
              onClick={() => {
                save(working)
                setDraft(null)
              }}
            >
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
