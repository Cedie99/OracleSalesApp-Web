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
import { TONE_TEXT } from '@/lib/status-styles'
import type { Client, DeliveryStatus, PurchaseOrder } from '@/types'
import { AlertTriangle } from 'lucide-react'
import { format } from 'date-fns'

export interface AddPoDraft {
  poNumber: string
  clientId: string
  /** yyyy-MM-dd, straight off the date input. */
  scheduledFor: string
  area: string
  cod: boolean
  /** Whole pesos. Null when the PO isn't COD. */
  codDue: number | null
}

interface AddPoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clients: Client[]
  /** Existing rows, used to catch a PO number being listed twice. */
  orders: PurchaseOrder[]
  /** Pre-selected day when opened from a specific list's "Add PO". */
  defaults?: { scheduledFor?: string }
  onAdd: (draft: AddPoDraft) => void
}

function today(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

/**
 * The shape every PO number in the system has: `PO-` and a run of digits.
 * Enforced because this field is typed by hand, and a malformed number is the
 * cheapest typo to catch.
 */
const PO_PATTERN = /^PO-\d{3,8}$/

/**
 * Tidy what was typed into that shape without rejecting reasonable input:
 * lowercase, stray spaces, a bare `2100`, or `PO2100` all resolve to `PO-2100`.
 * Anything still not matching is a real error the admin has to look at.
 */
export function normalizePoNumber(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '')
  if (/^\d+$/.test(cleaned)) return `PO-${cleaned}`
  return cleaned.replace(/^PO-?/, 'PO-')
}

/** How the earlier use of this number reads, per what became of it. */
const PRIOR_USE_PHRASE: Record<DeliveryStatus, string> = {
  pending: 'It is already waiting on the list for',
  delivered: 'It was delivered to',
  failed: 'It came back from',
}

/** And what that means for the admin about to reuse it. */
const PRIOR_USE_ADVICE: Record<DeliveryStatus, string> = {
  pending: ' Listing it twice at once would put the same order on two trucks.',
  delivered: ' Make sure this is a second order and not a repeat of that one.',
  failed: ' Listing it again is how a backload goes back out, so this is expected.',
}

/**
 * Puts one PO on a day's trip list: PO number, customer, area, and a COD amount
 * where there is one. That is the whole of it.
 *
 * What is deliberately absent is most of it. **No line items** — the trip ticket
 * carries customer and plate, not a manifest, and the goods are on the paper PO
 * the driver already has. **No driver picker and no plate field** — the list is
 * a shared pool any driver works down, and the plate is typed by whoever
 * actually drives the stop.
 *
 * That settles OQ-5 ("who inputs the customer + plate trip list?"): the admin
 * lists the customers, the driver picks the list up and works it, plate
 * included. Confirmed by Adrian 2026-07-27 — do not add a driver or plate field
 * to this form.
 *
 * The duplicate check blocks a PO number that is already waiting on some day's
 * list, not one that has been closed out. Re-listing a failed delivery for
 * another attempt means adding the same PO number to a later day, and that is
 * the only path back onto a truck — nothing rolls forward on its own.
 *
 * Fields initialise from `defaults` and are never synced back to them, so the
 * caller remounts this component per opening with a `key` rather than having an
 * effect reset the fields.
 */
export function AddPoDialog({
  open, onOpenChange, clients, orders, defaults, onAdd,
}: AddPoDialogProps) {
  // `null`, not '', is this Select's "nothing chosen" value. An empty string is
  // treated as a selected-but-unknown value and the popup silently refuses to
  // commit a click — see base-ui's select docs, "Placeholder values".
  const [clientId, setClientId] = useState<string | null>(null)
  const [poNumber, setPoNumber] = useState('')
  const [scheduledFor, setScheduledFor] = useState(defaults?.scheduledFor ?? today)
  const [area, setArea] = useState('')
  const [cod, setCod] = useState(false)
  const [codDue, setCodDue] = useState('')
  const [error, setError] = useState('')
  /** Set once the admin has seen and accepted the history warning below. */
  const [warningAccepted, setWarningAccepted] = useState(false)

  const normalizedPo = normalizePoNumber(poNumber)

  /** PO numbers still waiting on some day's list — the ones a re-list would double up. */
  const openPoNumbers = useMemo(
    () =>
      new Set(orders.filter(po => po.status === 'pending').map(po => po.po_number.toUpperCase())),
    [orders]
  )

  /**
   * The last time this PO number was used, if ever. A number that already exists
   * is not automatically wrong — re-listing a failed delivery reuses it on
   * purpose — but it is the single best signal that a digit got mistyped, so the
   * admin is shown who it belonged to and made to confirm.
   */
  const priorUse = useMemo(() => {
    if (!PO_PATTERN.test(normalizedPo)) return null
    const matches = orders.filter(po => po.po_number.toUpperCase() === normalizedPo)
    if (matches.length === 0) return null
    return [...matches].sort(
      (a, b) => new Date(b.scheduled_for).getTime() - new Date(a.scheduled_for).getTime()
    )[0]
  }, [orders, normalizedPo])

  /**
   * A PO belongs to one customer. The same number turning up against a different
   * one is a typo far more often than it is a coincidence, so that case is
   * worded as a mistake while a genuine re-list is worded as what it is.
   */
  const wrongCustomer = priorUse !== null && clientId !== null && priorUse.client_id !== clientId

  const selectedClient = clients.find(c => c.id === clientId)

  /** Picking the customer fills the area, since that is where they are. */
  function handleClientChange(id: string | null) {
    setClientId(id)
    const picked = clients.find(c => c.id === id)
    if (picked?.city && !area) setArea(picked.city)
  }

  function handleAdd() {
    if (!poNumber.trim()) return setError('Enter the PO number from the paperwork.')
    if (!PO_PATTERN.test(normalizedPo)) {
      return setError('PO numbers look like PO-2100 — check what was typed.')
    }
    if (openPoNumbers.has(normalizedPo)) {
      return setError('That PO is already waiting on a trip list.')
    }
    if (!clientId) return setError('Pick the customer this PO delivers to.')
    if (!scheduledFor) return setError('Set the delivery day.')
    if (!area.trim()) return setError('Set the delivery area.')

    let due: number | null = null
    if (cod) {
      const amount = Number(codDue)
      if (!Number.isFinite(amount) || amount <= 0) {
        return setError('Enter the COD amount, in whole pesos.')
      }
      due = Math.round(amount)
    }

    // Everything else is valid, so the history warning is the last gate: show it
    // once, and let a second click through. Nothing is blocked outright — the
    // admin has the paperwork in front of them and we don't.
    if (priorUse && !warningAccepted) {
      setError('')
      return setWarningAccepted(true)
    }

    onAdd({
      poNumber: normalizedPo, clientId, scheduledFor, area: area.trim(), cod, codDue: due,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a PO to the trip list</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-po-number">PO number</Label>
              <Input
                id="add-po-number"
                placeholder="PO-2100"
                value={poNumber}
                onChange={e => {
                  setPoNumber(e.target.value)
                  // Editing the number invalidates whatever warning was accepted
                  // for the old one.
                  setWarningAccepted(false)
                }}
                onBlur={() => poNumber.trim() && setPoNumber(normalizePoNumber(poNumber))}
              />
              <p className="text-[11px] text-muted-foreground">Copy it off the PO paperwork</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-po-day">Delivery day</Label>
              <Input
                id="add-po-day"
                type="date"
                value={scheduledFor}
                onChange={e => setScheduledFor(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-po-client">Customer</Label>
            <Select value={clientId} onValueChange={handleClientChange}>
              <SelectTrigger id="add-po-client" className="w-full">
                <SelectValue placeholder="Select a customer" />
              </SelectTrigger>
              <SelectContent>
                {/* One string per item, not a fragment — the Select derives its
                    trigger label from string children and falls back to the raw
                    value otherwise (see collectSelectItems in ui/select.tsx). */}
                {clients.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedClient?.office_address && (
              <p className="text-[11px] text-muted-foreground">{selectedClient.office_address}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-po-area">Area</Label>
            <Input
              id="add-po-area"
              placeholder="Balanga"
              value={area}
              onChange={e => setArea(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              How the trip ticket groups stops. There is no GPS on this module.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-po-cod">Cash on delivery</Label>
              <Select value={cod ? 'yes' : 'no'} onValueChange={v => setCod(v === 'yes')}>
                <SelectTrigger id="add-po-cod" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">Not COD</SelectItem>
                  <SelectItem value="yes">COD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {cod && (
              <div className="space-y-1.5">
                <Label htmlFor="add-po-cod-due">COD amount</Label>
                <Input
                  id="add-po-cod-due"
                  inputMode="numeric"
                  placeholder="0"
                  value={codDue}
                  onChange={e => setCodDue(e.target.value.replace(/[^\d]/g, ''))}
                />
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {codDue ? peso(Number(codDue)) : 'Shown to the driver'}
                </p>
              </div>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Whichever driver reaches this customer delivers it — no one is
            assigned, and the stop&apos;s number in the run comes from the order they
            actually drive. On a COD stop the driver does see this amount: it is
            the fixed price of the goods, not an outstanding balance. The PO
            belongs to this day only; if it doesn&apos;t go out, the goods come back
            and someone here lists it again.
          </p>

          {/* The typo catch. A PO number is typed off paper and nothing upstream
              issues it, so its history is the only thing we can check it against. */}
          {priorUse && (
            <div
              className={`rounded-xl p-3 ${
                wrongCustomer ? 'bg-[var(--badge-red-bg)]' : 'bg-[var(--badge-amber-bg)]'
              }`}
            >
              <p
                className={`text-xs font-semibold flex items-center gap-1.5 ${
                  wrongCustomer ? TONE_TEXT.red : TONE_TEXT.amber
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {wrongCustomer
                  ? `${normalizedPo} belongs to a different customer`
                  : `${normalizedPo} has been listed before`}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                {PRIOR_USE_PHRASE[priorUse.status]}{' '}
                <span className="font-medium text-foreground">
                  {priorUse.client?.company_name}
                </span>{' '}
                on {format(new Date(priorUse.scheduled_for), 'MMM d')}.
                {wrongCustomer
                  ? ' Check the number against the paperwork — a mistyped digit usually looks exactly like this.'
                  : PRIOR_USE_ADVICE[priorUse.status]}
              </p>
              {warningAccepted && (
                <p className="text-[11px] font-medium text-foreground mt-1.5">
                  Press &ldquo;Add to list&rdquo; again to go ahead.
                </p>
              )}
            </div>
          )}

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
