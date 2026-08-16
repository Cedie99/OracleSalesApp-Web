'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Background refresh for the data hooks in this folder.
 *
 * Every page here is a client component that loads its rows once on mount and
 * then sits there — so an admin watching the Collection board while collectors
 * work it was looking at whatever the table said when they opened the tab. This
 * keeps those screens current without asking anyone to hit reload.
 *
 * The whole design is about not paying for that with server load:
 *
 *  1. **One clock, not one timer per hook.** Every subscriber registers a job on
 *     a single module-level ticker. A page with six hooks mounted wakes the
 *     browser once, not six times.
 *
 *  2. **Hidden tabs cost nothing.** The ticker checks `visibilityState` and
 *     returns immediately when the tab is in the background, so a dashboard left
 *     open behind twenty other tabs issues zero requests. Coming back to the tab
 *     re-checks anything gone stale, which is the case that actually matters —
 *     you switch back and the numbers are already right.
 *
 *  3. **A cheap change-stamp before the expensive read.** This is the important
 *     one. Rather than re-running `useClients`' full join every minute, a job
 *     first asks the table one question: "how many rows do you have, and when
 *     was the newest one written?" That is a single row over the wire, answered
 *     from the `(stamp DESC)` indexes added in migration 101. Only when the
 *     answer differs from last time does the real query run. A quiet hour costs
 *     one tiny probe per minute per table instead of sixty full table reads.
 *
 *  4. **Idle tabs slow down but never stop.** After {@link IDLE_AFTER_MS} with no
 *     pointer or keyboard input the cadence stretches by
 *     {@link IDLE_INTERVAL_FACTOR}, so a screen left up overnight keeps itself
 *     current without polling all night at full rate. Any real interaction puts
 *     it straight back on the fast lane.
 *
 * Refreshes here are silent on purpose: they call the hook's `load`, never its
 * `refresh`, so `loading` stays false and the table re-renders in place instead
 * of blinking back to a spinner under someone's cursor.
 */

/** How often the shared clock wakes to see whether any job has come due. */
const TICK_MS = 5_000

/** Default cadence — a page's own working data. */
export const REFRESH_INTERVAL_MS = 60_000

/**
 * The fast lane: the counts in the chrome (the header bell, the Approvals pill)
 * and the operational boards someone sits and watches while the field works —
 * Collection and Delivery. These are the screens where being a minute behind is
 * noticed.
 */
export const LIVE_INTERVAL_MS = 30_000

/** Reference data that barely moves — people, teams, quota configuration. */
export const SLOW_INTERVAL_MS = 5 * 60_000

/** Returning to the tab re-checks anything older than this, whatever its cadence. */
const FOCUS_STALE_MS = 10_000

/** No deliberate input for this long and the tab drops to the slow lane. */
const IDLE_AFTER_MS = 15 * 60_000
const IDLE_INTERVAL_FACTOR = 5

/**
 * A full re-fetch happens at least this often even when the stamp says nothing
 * moved. It is the safety net for anything a stamp cannot see — a column the
 * mobile app updates without touching `updated_at`, or an insert that landed in
 * the split second between this hook's mount read and its first probe.
 */
const MAX_SKIP_MS = 10 * 60_000

/** Window in which two hooks watching the same table share one stamp read. */
const STAMP_CACHE_MS = 3_000

/**
 * A table to watch for changes, and the column that moves when a row is written.
 *
 * `column` defaults to `updated_at`; pass `created_at` (or `occurred_at`, or
 * whatever the table calls it) for the append-only tables that have no
 * `updated_at` to keep. Migration 101 indexes every column named here.
 */
export interface ChangeStamp {
  table: string
  column?: string
  /** Equality filters mirroring the hook's own query, e.g. `{ client_id: id }`. */
  match?: Record<string, string>
}

interface AutoRefreshOptions {
  /**
   * Tables to probe before re-fetching. Omit for hooks that read through a
   * Server Function (there is nothing cheap to ask), and they will simply
   * re-fetch on their interval.
   */
  watch?: ChangeStamp[]
  intervalMs?: number
  /** Set false to leave a hook out — e.g. while its inputs are still unknown. */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Change stamps
// ---------------------------------------------------------------------------

const stampCache = new Map<string, { at: number; value: Promise<string> }>()

/**
 * Specs whose stamp column is not there — retired for the life of the tab.
 *
 * This is the deploy-ordering window: app code that watches `updated_at` reaches
 * production before migration 101 applies it, and PostgREST answers 400 for
 * every probe in between. The same shape as `isMissingAdditionalColumn` in
 * use-collection.ts, and for the same reason — the web and the schema deploy
 * separately, so each has to tolerate briefly leading the other.
 *
 * Only a *schema* error retires a spec. A transient failure (offline, a dropped
 * connection) must not, or one bad minute on hotel wifi would cost the tab its
 * probes for the rest of the day.
 */
const retiredSpecs = new Set<string>()

function isMissingColumnOrTable(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  // 42703 undefined_column, 42P01 undefined_table.
  return code === '42703' || code === '42P01' || /does not exist/i.test(message ?? '')
}

/**
 * `rowCount:newestWrite` for one table — the whole state of it, in two numbers.
 *
 * Both halves are needed. The timestamp alone misses deletes (removing a row
 * moves nothing forward); the count alone misses edits. Together they change on
 * any insert, update or delete an admin could care about, and the read is one
 * indexed row plus a count.
 */
async function readStamp(spec: ChangeStamp): Promise<string> {
  const column = spec.column ?? 'updated_at'

  let query = createClient()
    .from(spec.table)
    .select(column, { count: 'exact' })

  for (const [key, value] of Object.entries(spec.match ?? {})) {
    query = query.eq(key, value)
  }

  // nullsFirst: false so a row with a null stamp can never masquerade as the
  // newest one and freeze the comparison.
  const { data, count, error } = await query
    .order(column, { ascending: false, nullsFirst: false })
    .limit(1)

  if (error) throw error

  // `column` is a runtime string, so PostgREST's row type cannot be inferred
  // from it — hence the cast rather than a typed row.
  const rows = data as unknown as Record<string, unknown>[] | null
  const newest = rows?.[0]?.[column]
  return `${spec.table}:${count ?? -1}:${newest ?? ''}`
}

function cachedStamp(spec: ChangeStamp): Promise<string> {
  const key = JSON.stringify(spec)
  if (retiredSpecs.has(key)) return Promise.reject(new Error('stamp unavailable'))

  const now = Date.now()
  const hit = stampCache.get(key)
  if (hit && now - hit.at < STAMP_CACHE_MS) return hit.value

  // Two hooks on the same page often watch the same table (Clients is read by
  // the clients page and by half the dialogs). They tick together, so one read
  // answers both.
  const value = readStamp(spec)
  stampCache.set(key, { at: now, value })
  void value.catch((error: unknown) => {
    stampCache.delete(key)
    if (isMissingColumnOrTable(error)) retiredSpecs.add(key)
  })
  return value
}

/**
 * The combined stamp for a hook's tables, or null if it could not be read.
 *
 * Null means "no opinion", and every caller treats it as "assume it changed" —
 * so a probe that fails (offline, or a column migration 101 has not applied yet)
 * degrades to plain polling rather than to a screen that stops updating.
 */
async function readVersion(specs: ChangeStamp[]): Promise<string | null> {
  try {
    return (await Promise.all(specs.map(cachedStamp))).join('|')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The shared clock
// ---------------------------------------------------------------------------

interface Job {
  intervalMs: number
  lastRunAt: number
  run: () => void
}

const jobs = new Set<Job>()
let ticker: ReturnType<typeof setInterval> | null = null
let lastInteractionAt = Date.now()

/** Deliberate input only — mouse movement over a dashboard is not attention. */
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function intervalFactor(): number {
  return Date.now() - lastInteractionAt >= IDLE_AFTER_MS ? IDLE_INTERVAL_FACTOR : 1
}

/**
 * Run every job that has gone unrefreshed for `minAgeMs` — or, by default, for
 * its own interval. Hidden tabs run nothing at all: that is the entire reason a
 * background tab is free.
 */
function runDue(minAgeMs?: number) {
  if (!isVisible()) return

  const now = Date.now()
  const factor = intervalFactor()

  for (const job of jobs) {
    const due = minAgeMs ?? job.intervalMs * factor
    if (now - job.lastRunAt < due) continue
    job.lastRunAt = now
    job.run()
  }
}

function handleInteraction() {
  lastInteractionAt = Date.now()
}

/**
 * Back in view, back from sleep, or back online — all three mean the same thing:
 * whatever is on screen may have been overtaken while we were not looking. The
 * `FOCUS_STALE_MS` floor stops a flick through three tabs from re-probing
 * everything three times.
 */
function handleWake() {
  lastInteractionAt = Date.now()
  runDue(FOCUS_STALE_MS)
}

function startClock() {
  if (ticker) return
  ticker = setInterval(() => runDue(), TICK_MS)
  document.addEventListener('visibilitychange', handleWake)
  window.addEventListener('focus', handleWake)
  window.addEventListener('online', handleWake)
  for (const event of INTERACTION_EVENTS) {
    window.addEventListener(event, handleInteraction, { passive: true })
  }
}

function stopClock() {
  if (!ticker) return
  clearInterval(ticker)
  ticker = null
  document.removeEventListener('visibilitychange', handleWake)
  window.removeEventListener('focus', handleWake)
  window.removeEventListener('online', handleWake)
  for (const event of INTERACTION_EVENTS) {
    window.removeEventListener(event, handleInteraction)
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Keep a data hook's rows current in the background.
 *
 * Call it beside the hook's own mount effect, passing the same silent `load` the
 * mount effect uses — not `refresh`, which raises the spinner:
 *
 * ```ts
 * useAutoRefresh(load, { watch: [{ table: 'clients' }] })
 * ```
 */
export function useAutoRefresh(load: () => Promise<void>, options: AutoRefreshOptions = {}) {
  const { watch, intervalMs = REFRESH_INTERVAL_MS, enabled = true } = options

  // Serialised so an inline `watch` literal — which is a new array on every
  // render — does not re-register the job sixty times a minute and leave it
  // permanently "just run".
  const watchKey = watch && watch.length > 0 ? JSON.stringify(watch) : ''

  const loadRef = useRef(load)
  const versionRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)
  // When the rows on screen were last read in full. Seeded on mount rather than
  // at declaration because `Date.now()` during render is impure (and the React
  // Compiler lint says so); the hook that owns us has just loaded anyway, so
  // mount is the honest starting point for the MAX_SKIP_MS backstop.
  const lastFullAt = useRef(0)

  // `load` is re-created whenever a hook's filters change (useAuditLogs,
  // useMeetings). Reading it through a ref keeps the schedule stable across
  // those changes while still always calling the current query.
  useEffect(() => {
    loadRef.current = load
  })

  // Take a baseline as soon as we mount, so the first tick can tell "nothing has
  // changed" from "we have never looked". Without it the first tick would always
  // re-fetch, which is exactly the cost this hook exists to avoid.
  useEffect(() => {
    if (!enabled || !watchKey) return
    let cancelled = false
    void readVersion(JSON.parse(watchKey) as ChangeStamp[]).then(version => {
      if (!cancelled) versionRef.current = version
    })
    return () => {
      cancelled = true
    }
  }, [enabled, watchKey])

  useEffect(() => {
    if (!enabled) return

    if (lastFullAt.current === 0) lastFullAt.current = Date.now()

    const specs = watchKey ? (JSON.parse(watchKey) as ChangeStamp[]) : null

    const job: Job = {
      intervalMs,
      lastRunAt: Date.now(),
      run: () => {
        // A slow query must not stack up behind itself on a busy connection.
        if (inFlightRef.current) return
        inFlightRef.current = true

        void (async () => {
          try {
            const forceFull = Date.now() - lastFullAt.current >= MAX_SKIP_MS
            const version = specs ? await readVersion(specs) : null

            // The common case, and the whole point: the table is untouched, so
            // the expensive read never happens.
            if (!forceFull && version !== null && version === versionRef.current) return

            await loadRef.current()
            lastFullAt.current = Date.now()
            versionRef.current = version
          } catch {
            // Transient — a dropped connection, a sleeping laptop. The next tick
            // tries again, and the hook's own error state still shows anything
            // the query itself reported.
          } finally {
            inFlightRef.current = false
          }
        })()
      },
    }

    jobs.add(job)
    startClock()

    return () => {
      jobs.delete(job)
      if (jobs.size === 0) stopClock()
    }
  }, [enabled, intervalMs, watchKey])
}
