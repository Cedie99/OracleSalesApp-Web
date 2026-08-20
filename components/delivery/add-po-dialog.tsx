'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ClientPicker } from '@/components/ui/client-picker'
import { recentClientIds } from '@/lib/client-search'
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
  /** Returns an error message, or null once the PO is on the list. */
  onAdd: (draft: AddPoDraft) => Promise<string | null>
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
  // Handed over, COD only part-paid — still open on its list (migration 073).
  partial: 'It was delivered, with COD still part-paid, to',
}

/** And what that means for the admin about to reuse it. */
const PRIOR_USE_ADVICE: Record<DeliveryStatus, string> = {
  pending: ' Listing it twice at once would put the same order on two trucks.',
  delivered: ' Make sure this is a second order and not a repeat of that one.',
  failed: ' Listing it again is how a backload goes back out, so this is expected.',
  partial: ' That COD is still being collected on the open stop — this would be a separate order.',
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
  // `null`, not '', is the picker's "nothing chosen" value. An empty string is
  // treated as a selected-but-unknown value and the popup silently refuses to
  // commit a click — see base-ui's select docs, "Placeholder values".
  const [clientId, setClientId] = useState<string | null>(null)
  const [poNumber, setPoNumber] = useState('')
  const [scheduledFor, setScheduledFor] = useState(defaults?.scheduledFor ?? today)
  const [area, setArea] = useState('')
  /**
   * Whether the area on screen is the admin's own wording rather than the
   * customer's town. It is what stops a later customer change overwriting text
   * someone typed on purpose — and it goes back to false when they empty the
   * field, because clearing an area is asking for the default back, not
   * overriding it with a blank.
   */
  const [areaEdited, setAreaEdited] = useState(false)
  const [cod, setCod] = useState(false)
  const [codDue, setCodDue] = useState('')
  const [error, setError] = useState('')
  /** Set once the admin has seen and accepted the history warning below. */
  const [warningAccepted, setWarningAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  /** How many POs this sitting has already put on the list — see "Save & add another". */
  const [addedCount, setAddedCount] = useState(0)

  /**
   * The customers most recently listed, pinned to the top of the picker.
   * Derived from the orders this dialog already receives for the duplicate
   * check, so nothing extra is loaded to get it.
   */
  const recentIds = useMemo(() => recentClientIds(orders), [orders])

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

  /** The town the picked customer is in, when their record carries one. */
  const clientCity = selectedClient?.city?.trim() || null

  /**
   * Every area already in use, for the spelling snap below. Read off the orders
   * this dialog already receives, so no extra load.
   */
  const knownAreas = useMemo(
    () => [...new Set(orders.map(po => po.area?.trim()).filter((a): a is string => !!a))],
    [orders]
  )

  /** True when the field says exactly where the customer is. */
  const areaMatchesCity =
    clientCity !== null && area.trim().toLowerCase() === clientCity.toLowerCase()

  /**
   * The customer's town, when it is on file and is NOT what the field says —
   * i.e. the admin has typed over it, or emptied it. Offered as one click
   * rather than applied, because a delivery area legitimately differs from the
   * customer's registered town and their wording wins.
   */
  const citySuggestion = clientCity !== null && !areaMatchesCity ? clientCity : null

  /**
   * Snap what was typed onto an area already in use when the two differ only in
   * case or spacing. The trip board and the delivery dashboard group stops by
   * this string EXACTLY, so "balanga", "Balanga" and "Balanga " quietly split
   * one town into three areas on the ticket.
   */
  function normalizeArea(raw: string): string {
    const cleaned = raw.trim().replace(/\s+/g, ' ')
    return knownAreas.find(known => known.toLowerCase() === cleaned.toLowerCase()) ?? cleaned
  }

  /**
   * Picking the customer fills the area, since that is where they are — and
   * KEEPS filling it as the customer is changed again. The earlier version
   * filled an empty field once and then went quiet, so correcting a mis-picked
   * customer left the previous customer's town sitting on the PO.
   */
  function handleClientChange(id: string | null) {
    setClientId(id)
    if (areaEdited) return
    const picked = clients.find(c => c.id === id)
    setArea(picked?.city?.trim() ?? '')
  }

  function handleAreaChange(next: string) {
    setArea(next)
    setAreaEdited(next.trim() !== '')
  }

  /** Take the customer's town, and hand the field back to auto-fill. */
  function useCityAsArea() {
    if (!clientCity) return
    setArea(normalizeArea(clientCity))
    setAreaEdited(false)
  }

  async function handleAdd(andAnother: boolean) {
    if (!poNumber.trim()) return setError('Enter the PO number from the paperwork.')
    if (!PO_PATTERN.test(normalizedPo)) {
      return setError('PO numbers look like PO-2100 — check what was typed.')
    }
    if (openPoNumbers.has(normalizedPo)) {
      return setError('That PO is already waiting on a trip list.')
    }
    if (!clientId) return setError('Pick the customer this PO delivers to.')
    if (!scheduledFor) return setError('Set the delivery day.')
    // The real guard — `min` on the input is a browser hint and is bypassed by
    // typing straight into the field.
    if (scheduledFor < today()) {
      return setError('That delivery day has already passed. Pick today or a later day.')
    }
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

    setBusy(true)
    const message = await onAdd({
      // Normalized here too, not just on blur — this is the value that becomes
      // an area on the trip ticket, and it must not depend on the field having
      // lost focus first.
      poNumber: normalizedPo, clientId, scheduledFor, area: normalizeArea(area), cod, codDue: due,
    })
    setBusy(false)
    if (message) return setError(message)

    if (!andAnother) return onOpenChange(false)

    // A stack of PO paperwork is worked through in one sitting, so keep the
    // delivery day and clear everything that belongs to the sheet just entered.
    // The area is cleared with the rest because picking the next customer
    // refills it, and a stale area is worse than an empty one.
    setAddedCount(n => n + 1)
    setPoNumber('')
    setClientId(null)
    setArea('')
    setAreaEdited(false)
    setCod(false)
    setCodDue('')
    setWarningAccepted(false)
    setError('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Same height guard as the store dialog: the history warning and the COD
          field both appear conditionally, and on a short window they were
          enough to push the footer off screen. */}
      {/* A size wider than the fields need, because the footer carries three
          controls and a running count — at `md` the "Add to list" button was
          wrapping onto its own row. */}
      <DialogContent className="sm:max-w-lg max-h-[min(90dvh,52rem)] grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Add a PO to the trip list</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 min-h-0 overflow-y-auto -mx-1 px-1">
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
                // Today is the floor — a PO published into a past day is
                // invisible to the drivers' phones, which work today's list, so
                // it would be born as "not worked". See the twin note on
                // AddStoreDialog.
                min={today()}
                onChange={e => setScheduledFor(e.target.value)}
              />
              {scheduledFor && scheduledFor < today() && (
                <p className="text-[11px] text-destructive">
                  That day has already passed. Pick today or a later day.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-po-client">Customer</Label>
            {/* Typed, not scrolled. The customer is named on the PO in the
                admin's hand, so the fast path is to type it — see ClientPicker
                for why a plain dropdown stopped working at this list's size. */}
            <ClientPicker
              id="add-po-client"
              clients={clients}
              value={clientId}
              onChange={handleClientChange}
              recentIds={recentIds}
              placeholder={`Search ${clients.length.toLocaleString()} customers…`}
              className="w-full"
            />
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
              onChange={e => handleAreaChange(e.target.value)}
              // Snapped on the way out, not per keystroke — mid-word the typed
              // text matches nothing and the cursor would fight the correction.
              onBlur={() => area.trim() && setArea(normalizeArea(area))}
              className="w-full"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {citySuggestion ? (
                <>
                  {/* The escape hatch for the case the sync deliberately will
                      not handle: the admin typed their own area, so we offer
                      the customer's town instead of overwriting with it. */}
                  This customer is in{' '}
                  <button
                    type="button"
                    onClick={useCityAsArea}
                    className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
                  >
                    {citySuggestion}
                  </button>
                  {area.trim() ? ' — click to use that instead.' : ' — click to fill it in.'}
                </>
              ) : areaMatchesCity ? (
                <>From this customer&apos;s address. How the trip ticket groups stops.</>
              ) : selectedClient ? (
                <>
                  This customer has no town on file, so type the area. It is how the trip ticket
                  groups stops.
                </>
              ) : (
                <>How the trip ticket groups stops. There is no GPS on this module.</>
              )}
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

        <DialogFooter className="sm:justify-between">
          {/* Reassurance, not decoration: with the dialog staying open after a
              save, the only other evidence a PO landed is behind it. */}
          <span className="self-center text-[11px] whitespace-nowrap text-muted-foreground">
            {addedCount > 0 && `${addedCount} PO${addedCount === 1 ? '' : 's'} added`}
          </span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {addedCount > 0 ? 'Done' : 'Cancel'}
            </Button>
            {/* POs arrive as a stack of paper for one delivery day, and closing
                the dialog per sheet meant reopening it and re-picking the day
                every time. */}
            <Button variant="outline" onClick={() => handleAdd(true)} disabled={busy}>
              Save &amp; add another
            </Button>
            <Button onClick={() => handleAdd(false)} disabled={busy}>Add to list</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
