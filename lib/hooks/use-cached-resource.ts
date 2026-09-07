'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A read that survives unmounting.
 *
 * Every data hook in this folder holds its rows in `useState`, which means the
 * rows die with the component. The admin layout mounts a new page component on
 * every navigation, so Clients -> Meetings -> back to Clients re-runs the same
 * queries from scratch, both times, and the user watches a spinner for data the
 * tab already had thirty seconds ago. `useAutoRefresh` solved the *polling*
 * half of staying current very well; this is the other half — not re-paying for
 * a read you have already made.
 *
 * Three things, and deliberately no more:
 *
 *  1. **A module-level store.** Values outlive the components that fetched
 *     them, so a remount renders from cache on the FIRST paint rather than
 *     after a round-trip. This is the whole point.
 *
 *  2. **In-flight sharing.** Two components mounting the same key in the same
 *     tick (the sidebar and a page both wanting profiles) issue one request,
 *     not two.
 *
 *  3. **Stale-while-revalidate.** A cache hit renders immediately AND kicks off
 *     a background read, so nobody is ever looking at data the app knows is old
 *     without also fixing it. `loading` stays false through that revalidation —
 *     the table must not blink back to a skeleton under someone's cursor, which
 *     is the same discipline `useAutoRefresh` follows by calling `load` rather
 *     than `refresh`.
 *
 * NOT a general query library. There is no garbage collection (the cached sets
 * here are reference data — people, teams — measured in kilobytes and bounded
 * by headcount), no retry policy, and no invalidation graph. Anything wanting
 * those should get them explicitly rather than by growing this.
 *
 * Cache lifetime is the tab. A reload starts empty, which is correct: a hard
 * refresh is the one gesture that unambiguously means "I do not trust what is
 * on screen".
 */

interface Entry {
  value: unknown
  /** When this value was read, for the staleness check on mount. */
  at: number
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()

/**
 * A cache hit older than this still renders instantly, but is revalidated
 * behind. Shorter than any of the `useAutoRefresh` cadences on purpose —
 * arriving at a page is exactly when a stale number is most likely to be
 * noticed and least likely to be forgiven.
 */
const REVALIDATE_AFTER_MS = 10_000

/**
 * Drop a cached key so the next mount re-reads it.
 *
 * For mutations: a hook that writes should evict what it invalidated rather
 * than trust its own optimistic update to have been complete.
 */
export function evictCachedResource(key: string) {
  cache.delete(key)
}

/** Drop everything. Used on sign-out, where the next user must share nothing. */
export function clearResourceCache() {
  cache.clear()
  inflight.clear()
}

/**
 * Run `load` for `key`, sharing an already-running call rather than starting a
 * second one. The result is cached on success; a failure caches nothing, so the
 * next caller retries instead of inheriting an error.
 */
async function readThrough<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const promise = load()
    .then(value => {
      cache.set(key, { value, at: Date.now() })
      return value
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, promise)
  return promise
}

export interface CachedResource<T> {
  data: T
  /** True only when there is nothing to show yet — never during a revalidation. */
  loading: boolean
  error: string
  /** Silent re-read. Safe to call from an effect or a background timer. */
  reload: () => Promise<void>
  /** Re-read and raise the spinner. For explicit user gestures only. */
  refresh: () => Promise<void>
}

/**
 * @param key      Stable cache identity. Include every input the query varies
 *                 on — a hook taking arguments must put them in here, or two
 *                 different reads will collide on one entry.
 * @param load     Fetches the value. Must THROW on failure; a returned value is
 *                 taken as success and cached.
 * @param fallback Rendered before the first successful read.
 */
export function useCachedResource<T>(
  key: string,
  load: () => Promise<T>,
  fallback: T,
): CachedResource<T> {
  const cached = cache.get(key) as { value: T; at: number } | undefined

  const [data, setData] = useState<T>(cached ? cached.value : fallback)
  // A cache hit is not loading — it has something real to render this frame.
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState('')

  // `load` is typically an inline closure, so it is a new function every
  // render. Reading it through a ref keeps the effects below keyed on `key`
  // alone instead of re-firing on every parent render.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  const run = useCallback(
    async (withSpinner: boolean) => {
      if (withSpinner) setLoading(true)
      try {
        const value = await readThrough(key, () => loadRef.current())
        setError('')
        setData(value)
      } catch (loadError) {
        // The last good value stays on screen. An error banner beside real data
        // is more useful than an empty table that looks like an empty database.
        setError(loadError instanceof Error ? loadError.message : 'Could not load.')
      }
      setLoading(false)
    },
    [key],
  )

  const reload = useCallback(() => run(false), [run])
  const refresh = useCallback(() => run(true), [run])

  useEffect(() => {
    const hit = cache.get(key) as { value: T; at: number } | undefined

    // Re-seed from the cache when `key` changes, so a hook whose arguments
    // moved renders the new key's cached value rather than the old key's rows.
    if (hit) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setData(hit.value)
      setLoading(false)
      // Fresh enough that a revalidation would be noise.
      if (Date.now() - hit.at < REVALIDATE_AFTER_MS) return
    }

    // Miss, or a stale hit: read behind whatever is already on screen.
    void reload()
  }, [key, reload])

  return { data, loading, error, reload, refresh }
}
