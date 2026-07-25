'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PaginationProps {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  /** 1-indexed position of the first item on this page. */
  from: number
  /** 1-indexed position of the last item on this page. */
  to: number
  total: number
  /** Plural noun for the count line, e.g. "clients". */
  itemLabel?: string
  className?: string
}

/** Compact page list with ellipsis gaps: 1 … 4 5 [6] 7 8 … 20 */
function pageWindow(page: number, pageCount: number): (number | 'gap')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)

  const pages: (number | 'gap')[] = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pageCount - 1, page + 1)

  if (start > 2) pages.push('gap')
  for (let p = start; p <= end; p++) pages.push(p)
  if (end < pageCount - 1) pages.push('gap')

  pages.push(pageCount)
  return pages
}

/**
 * Presentational pager driven by `usePagination`. Renders a "Showing X–Y of Z"
 * summary and, when there is more than one page, prev/next plus numbered pills.
 * Returns nothing for an empty result set so callers can drop it in
 * unconditionally beneath their list.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  from,
  to,
  total,
  itemLabel = 'items',
  className,
}: PaginationProps) {
  if (total === 0) return null

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 pt-1', className)}>
      <p className="text-xs text-muted-foreground">
        Showing <span className="font-medium text-foreground">{from}–{to}</span> of{' '}
        <span className="font-medium text-foreground">{total}</span> {itemLabel}
      </p>

      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {pageWindow(page, pageCount).map((p, i) =>
            p === 'gap' ? (
              <span
                key={`gap-${i}`}
                className="inline-flex w-8 h-8 items-center justify-center text-xs text-muted-foreground"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-current={p === page ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center justify-center min-w-8 h-8 px-2 rounded-full border text-xs font-medium transition-colors',
                  p === page
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {p}
              </button>
            ),
          )}

          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
