'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { AlertTriangle } from 'lucide-react'

/**
 * Confirmation for an action that is hard to take back.
 *
 * Both callers on the operational boards are icon-only controls — an `×` that
 * deletes a store off a published list, and a padlock that releases somebody's
 * claim. An icon with no label and no confirmation gives an admin no way to
 * learn what a button does except by pressing it and finding out, and both of
 * these reach the field: a removed store vanishes from a collector's phone, and
 * a released claim unlocks a stop someone may already be driving to.
 *
 * The `description` is where the CONSEQUENCE goes, not a restatement of the
 * title — "this cannot be undone" is far less useful than saying what the person
 * in the field will see.
 */
export function ConfirmDialog({
  open, title, description, confirmLabel, destructive = false, busy = false,
  onConfirm, onOpenChange,
}: {
  open: boolean
  title: string
  /** What actually happens, in the field, if they go ahead. */
  description: React.ReactNode
  /** Names the action rather than saying "OK", so the button is readable alone. */
  confirmLabel: string
  destructive?: boolean
  /** Keeps the dialog up and the buttons quiet while the write is in flight. */
  busy?: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={o => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive && <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />}
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground leading-relaxed">{description}</div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
