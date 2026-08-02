'use client'

import { useMemo, useState } from 'react'

export interface UsePaginationResult<T> {
  /** The clamped current page (1-indexed). */
  page: number
  /** Total number of pages (always ≥ 1). */
  pageCount: number
  /** The slice of `items` for the current page. */
  pageItems: T[]
  /** Total number of items across all pages. */
  total: number
  pageSize: number
  /** 1-indexed position of the first item on this page (0 when empty). */
  from: number
  /** 1-indexed position of the last item on this page. */
  to: number
  setPage: (page: number) => void
}

/**
 * Client-side pagination over an already-filtered array.
 *
 * Pass a `resetKey` built from the active filters/search so the view jumps back
 * to page 1 whenever the result set changes underneath it — otherwise a user
 * sitting on page 5 could filter down to two results and see an empty page.
 * The page is also clamped whenever the list shrinks below the current page.
 */
export function usePagination<T>(
  items: T[],
  pageSize = 12,
  resetKey?: unknown,
): UsePaginationResult<T> {
  const [page, setPage] = useState(1)
  const [prevKey, setPrevKey] = useState(resetKey)

  // Snap back to the first page when the filter signature changes. Done during
  // render (React's recommended alternative to an effect) so the reset lands in
  // the same commit as the new filter, with no flash of a stale page.
  if (prevKey !== resetKey) {
    setPrevKey(resetKey)
    setPage(1)
  }

  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // Derived rather than stored, so a list that shrinks below the current page
  // is clamped without a second setState.
  const current = Math.min(page, pageCount)
  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize],
  )

  return {
    page: current,
    pageCount,
    pageItems,
    total,
    pageSize,
    from: total === 0 ? 0 : (current - 1) * pageSize + 1,
    to: Math.min(current * pageSize, total),
    setPage,
  }
}
