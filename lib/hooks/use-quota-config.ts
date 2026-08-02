'use client'

import { useCallback, useSyncExternalStore } from 'react'
import type { CutoffCalendar, QuotaPolicy } from '@/types'
import { activeCalendar, cutoffPeriodFor, type CutoffPeriod } from '@/lib/cutoff'

/**
 * Quota configuration — cutoff calendar + the per-client visit cap.
 *
 * ⚠️ THIS IS A LOCAL STAND-IN, NOT THE REAL SOURCE. `cutoff_calendar` does not
 * exist in the database yet and `quota_policy` (mobile's migration 028) has no
 * `client_visit_cap` rows, because the mobile side owns migrations to that
 * table. Config is held in localStorage so the settings UI and the maps quota
 * lens are demoable end-to-end ahead of the schema.
 *
 * Everything above this line is throwaway; everything below the store is not.
 * The hook's return shape is deliberately what a Supabase-backed version would
 * return, so swapping the two `read`/`write` functions for queries is the whole
 * migration — no caller changes. Types come from `@/types`, which describes the
 * agreed table shape rather than this file's storage format.
 */

const STORAGE_KEY = 'oracle.quota-config.v1'

export interface QuotaConfig {
  calendars: CutoffCalendar[]
  policies: QuotaPolicy[]
}

/**
 * Seeded semi-monthly, matching how Philippine payroll actually runs — but the
 * whole point of the 2026-08-02 decision is that this is data, not a constant.
 * An admin can change the anchors, or clear the calendar entirely to see the
 * unconfigured state the real rule demands ("nothing may enforce a cutoff date
 * until an admin sets one").
 */
const DEFAULT_CONFIG: QuotaConfig = {
  calendars: [
    {
      id: 'seed-semi-monthly',
      name: 'Semi-monthly',
      anchor_days: [1, 16],
      timezone: 'Asia/Manila',
      effective_from: '2026-01-01',
      effective_until: null,
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  policies: [
    {
      id: 'seed-client-visit-cap',
      role: null,
      policy_kind: 'client_visit_cap',
      target_value: 2,
      applies_to: ['new', 'existing'],
      timezone: 'Asia/Manila',
      effective_from: '2026-01-01',
      effective_until: null,
      is_active: true,
    },
  ],
}

// --- Store -------------------------------------------------------------------
//
// useSyncExternalStore rather than useState so the settings page and the maps
// lens observe the same config without a provider — editing the cutoff in one
// tab updates the map in the other. getSnapshot must return a STABLE reference
// or React re-renders forever, hence the cache.

const listeners = new Set<() => void>()
let cache: QuotaConfig | null = null

function read(): QuotaConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CONFIG
    const parsed = JSON.parse(raw) as Partial<QuotaConfig>
    // An empty calendars array is meaningful (admin cleared it), so only fall
    // back to the seed when the key is absent or the shape is unusable.
    if (!Array.isArray(parsed.calendars) || !Array.isArray(parsed.policies)) return DEFAULT_CONFIG
    return { calendars: parsed.calendars, policies: parsed.policies }
  } catch {
    // Corrupt JSON shouldn't take the page down — an unreadable config reads as
    // the seed, and the next save overwrites it.
    return DEFAULT_CONFIG
  }
}

function emit() {
  listeners.forEach(fn => fn())
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Cross-tab: another tab's write fires 'storage' here, never our own.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = null
      emit()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function getSnapshot(): QuotaConfig {
  return (cache ??= read())
}

function getServerSnapshot(): QuotaConfig {
  return DEFAULT_CONFIG
}

/** Replace the stored config and notify every subscriber. */
export function saveQuotaConfig(next: QuotaConfig): void {
  cache = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private-mode / quota errors: keep the in-memory value so the session still
    // works, and let it fall back to the seed on reload.
  }
  emit()
}

/** Drop any saved config and return to the seeded default. */
export function resetQuotaConfig(): void {
  cache = null
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear */
  }
  emit()
}

// --- Hook --------------------------------------------------------------------

export interface UseQuotaConfigResult {
  calendars: CutoffCalendar[]
  policies: QuotaPolicy[]
  /** The calendar governing today, or null when the cutoff is unconfigured. */
  calendar: CutoffCalendar | null
  /** Today's cutoff period, or null when unconfigured. */
  period: CutoffPeriod | null
  /**
   * False when no cutoff is configured. Callers must hide quota UI rather than
   * assume a semi-monthly default — see the note on CutoffCalendar.
   */
  isConfigured: boolean
  save: (next: QuotaConfig) => void
  reset: () => void
}

export function useQuotaConfig(): UseQuotaConfigResult {
  const config = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const calendar = activeCalendar(config.calendars)
  const period = calendar ? cutoffPeriodFor(new Date(), calendar) : null

  const save = useCallback((next: QuotaConfig) => saveQuotaConfig(next), [])
  const reset = useCallback(() => resetQuotaConfig(), [])

  return {
    calendars: config.calendars,
    policies: config.policies,
    calendar,
    period,
    isConfigured: period != null,
    save,
    reset,
  }
}
