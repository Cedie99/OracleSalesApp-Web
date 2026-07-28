'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { peso } from '@/lib/money'
import type { Client, CollectionVisit } from '@/types'
import { format } from 'date-fns'

export interface AddStoreDraft {
  clientId: string
  /** yyyy-MM-dd, straight off the date input. */
  scheduledFor: string
  amountDue: number
}

interface AddStoreDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clients: Client[]
  /** Existing rows, used to catch a store being listed twice for one day. */
  visits: CollectionVisit[]
  /** Pre-selected day when opened from a specific list's "Add store". */
  defaults?: { scheduledFor?: string }
  onAdd: (draft: AddStoreDraft) => void
}

function today(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

/**
 * Puts one store on a day's collection list.
 *
 * This is the Collection Admin's core action, and the only place a collection
 * record comes into existence — the collector's app is mobile-only and has no
 * "add a store to the list" path. Note what is deliberately absent: there is no
 * collector picker. The list is a shared pool that any collector works down, so
 * naming one here would invent a routing model the product doesn't have.
 *
 * That settles the July 3 meeting's OQ-4 ("who assigns collection routes/stores
 * to collectors?"): nobody does. Confirmed by Adrian 2026-07-27 — the admin
 * lists the stores, the mobile collector picks them up. Do not add a collector
 * field to this form.
 *
 * The amount due is captured here and, per the 2026-07-25 anchoring-bias
 * decision, never travels to the collector's Collect Payment screen; it stays
 * office-side as the figure the collected amount is later reconciled against.
 *
 * Fields initialise from `defaults` and are never synced back to them. Reopening
 * for a different day has to start over, so the caller remounts this component
 * per opening with a `key` rather than having an effect reset the fields.
 */
export function AddStoreDialog({
  open, onOpenChange, clients, visits, defaults, onAdd,
}: AddStoreDialogProps) {
  // `null`, not '', is this Select's "nothing chosen" value. An empty string is
  // treated as a selected-but-unknown value and the popup silently refuses to
  // commit a click — see base-ui's select docs, "Placeholder values".
  const [clientId, setClientId] = useState<string | null>(null)
  const [scheduledFor, setScheduledFor] = useState(defaults?.scheduledFor ?? today)
  const [amountDue, setAmountDue] = useState('')
  const [error, setError] = useState('')

  /** Stores already on that day's list — a store owes once per collection day. */
  const takenClientIds = useMemo(() => {
    const taken = new Set<string>()
    for (const v of visits) {
      if (v.scheduled_for.slice(0, 10) === scheduledFor) taken.add(v.client_id)
    }
    return taken
  }, [visits, scheduledFor])

  const selectedClient = clients.find(c => c.id === clientId)

  function handleAdd() {
    if (!clientId) return setError('Pick the store to collect from.')
    if (!scheduledFor) return setError('Set the collection day.')

    const amount = Number(amountDue)
    if (!Number.isFinite(amount) || amount <= 0) {
      return setError('Enter the amount owed, in whole pesos.')
    }
    if (takenClientIds.has(clientId)) {
      return setError('That store is already on the list for this day.')
    }

    onAdd({ clientId, scheduledFor, amountDue: Math.round(amount) })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a store to the list</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-store">Store</Label>
            <Select value={clientId} onValueChange={v => setClientId(v)}>
              <SelectTrigger id="add-store" className="w-full">
                <SelectValue placeholder="Select a store" />
              </SelectTrigger>
              <SelectContent>
                {/* One string per item, not a fragment — the Select derives its
                    trigger label from string children and falls back to the raw
                    value otherwise (see collectSelectItems in ui/select.tsx). */}
                {clients.map(c => (
                  <SelectItem key={c.id} value={c.id} disabled={takenClientIds.has(c.id)}>
                    {takenClientIds.has(c.id) ? `${c.company_name} — already listed` : c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedClient?.office_address && (
              <p className="text-[11px] text-muted-foreground">{selectedClient.office_address}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-day">Collection day</Label>
              <Input
                id="add-day"
                type="date"
                value={scheduledFor}
                onChange={e => setScheduledFor(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-due">Amount due</Label>
              <Input
                id="add-due"
                inputMode="numeric"
                placeholder="0"
                value={amountDue}
                onChange={e => setAmountDue(e.target.value.replace(/[^\d]/g, ''))}
              />
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {amountDue ? peso(Number(amountDue)) : 'Office-side only'}
              </p>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Whichever collector reaches this store takes it off the list — no one
            is assigned. They never see the amount due either; their app asks them
            to type what was actually handed over, with no target on screen.
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleAdd}>Add to list</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
