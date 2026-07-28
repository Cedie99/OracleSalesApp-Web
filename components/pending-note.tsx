'use client'

import { TONE_CLASS } from '@/lib/status-styles'
import { CircleHelp } from 'lucide-react'

/**
 * An unresolved question rendered on the page rather than buried in a comment.
 *
 * The mobile wireframes flag their open items the same way (the "Open questions"
 * rail and the amber `pendbanner` in Wireframe-Collection-Delivery.html), and
 * the reason carries over: these are the client's calls to make, and a screen
 * that quietly picks an answer for them stops anyone from noticing it was ever
 * a question. Keeping them visible in the demo is what gets them answered.
 */
export function PendingNote({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-border bg-muted/30 px-3.5 py-2.5">
      <CircleHelp className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <span
          className={`mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${TONE_CLASS.amber}`}
        >
          {label}
        </span>
        {children}
      </p>
    </div>
  )
}
