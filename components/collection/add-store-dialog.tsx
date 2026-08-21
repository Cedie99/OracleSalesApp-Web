'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { CLIENT_SEARCH_LIMIT, clientWhere, recentClientIds, searchClients } from '@/lib/client-search'
import { peso } from '@/lib/money'
import type { Client, CollectionVisit } from '@/types'
import { format } from 'date-fns'
import { Check, Search, X } from 'lucide-react'

export interface AddStoreDraft {
  clientId: string
  /** yyyy-MM-dd, straight off the date input. */
  scheduledFor: string
  amountDue: number
  /**
   * The admin deliberately marked this an "additional" store — one added to an
   * already-live day list, urgent enough to badge on the collectors' phones and
   * text them about. Never inferred from the date (see migration 068). Routes
   * the publish through the server so the SMS can fire; a normal store stays on
   * the client-side insert.
   */
  isAdditional: boolean
}

interface AddStoreDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clients: Client[]
  /** Existing rows, used to catch a store being listed twice for one day. */
  visits: CollectionVisit[]
  /** Pre-selected day when opened from a specific list's "Add store". */
  defaults?: { scheduledFor?: string }
  /**
   * Publishes the whole batch. Returns an error message, or null when every
   * store landed.
   */
  onAdd: (drafts: AddStoreDraft[]) => Promise<string | null>
}

function today(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

/** One store the admin has ticked, with the amount they are still typing. */
interface PickedStore {
  clientId: string
  /** Digits as typed. Kept a string so the field can legitimately be empty. */
  amount: string
}

/**
 * What to pre-fill the amount field with when a store is ticked: its current
 * running credit balance (migration 117), in whole pesos. This is the auto-fill
 * that replaces re-typing what a store owes every collection day — the admin now
 * confirms or tweaks a figure rather than remembering it. A store with nothing on
 * file (balance 0, or read before 115) starts blank so it reads as "type this in"
 * rather than a listable ₱0.
 */
function openingAmount(client: Client | undefined): string {
  const balance = Math.round(client?.credit_balance ?? 0)
  return balance > 0 ? String(balance) : ''
}

/** How many recently-listed stores are worth pinning above the search results. */
const RECENT_LIMIT = 8

/**
 * Puts stores on a day's collection list — several at a time.
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
 * It publishes a BATCH because that is the shape of the job: a day's list is
 * many stores, and the earlier one-store-per-dialog version made the admin
 * reopen the form and re-pick the same day for each one. Search once, tick the
 * stores, type the amounts down the column. The day and the "additional" flag
 * are set once and apply to everything in the batch, since they describe the
 * publish rather than any one store.
 *
 * Picking is a search, not a scroll. At ~1,500 customers an alphabetical
 * dropdown is unusable, so results are ranked and capped by `searchClients` and
 * every row carries its address — around here two shops genuinely do share a
 * name. Stores already on the chosen day's list stay visible but unpickable,
 * because "why isn't it in the list?" is a worse question than seeing it
 * greyed.
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
  const [scheduledFor, setScheduledFor] = useState(defaults?.scheduledFor ?? today)
  const [picked, setPicked] = useState<PickedStore[]>([])
  const [isAdditional, setIsAdditional] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const clientsById = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients])

  /** Stores already on that day's list — a store owes once per collection day. */
  const takenClientIds = useMemo(() => {
    const taken = new Set<string>()
    for (const v of visits) {
      if (v.scheduled_for.slice(0, 10) === scheduledFor) taken.add(v.client_id)
    }
    return taken
  }, [visits, scheduledFor])

  const pickedIds = useMemo(() => new Set(picked.map(p => p.clientId)), [picked])

  /**
   * The stores listed most recently, pinned above the results. Collection is
   * repetitive work — the same stores come round week after week — so this is
   * the section that most often answers the question without any typing.
   * Derived from the visits already loaded for the duplicate check.
   */
  const recentIds = useMemo(() => recentClientIds(visits, RECENT_LIMIT * 3), [visits])

  /** What the search panel shows: recents first, then everything else matching. */
  const { recent, rest, hidden } = useMemo(() => {
    const { matches, total } = searchClients(clients, query)
    const matched = new Set(matches.map(c => c.id))

    const recentHits = recentIds
      .map(id => clientsById.get(id))
      .filter((c): c is Client => !!c && matched.has(c.id))
      .slice(0, RECENT_LIMIT)

    const recentSet = new Set(recentHits.map(c => c.id))
    return {
      recent: recentHits,
      rest: matches.filter(c => !recentSet.has(c.id)),
      hidden: Math.max(0, total - CLIENT_SEARCH_LIMIT),
    }
  }, [clients, clientsById, query, recentIds])

  function toggle(clientId: string) {
    if (takenClientIds.has(clientId)) return
    setError('')
    setPicked(current =>
      current.some(p => p.clientId === clientId)
        ? current.filter(p => p.clientId !== clientId)
        : [...current, { clientId, amount: openingAmount(clientsById.get(clientId)) }]
    )
  }

  function removeAll() {
    setError('')
    setPicked([])
  }

  function setAmount(clientId: string, amount: string) {
    setPicked(current =>
      current.map(p => (p.clientId === clientId ? { ...p, amount } : p))
    )
  }

  /** Enter in the search box takes the top result — the whole point of typing. */
  function handleSearchKeyDown(key: string) {
    if (key !== 'Enter') return
    const top = recent[0] ?? rest[0]
    if (!top || takenClientIds.has(top.id)) return
    toggle(top.id)
    setQuery('')
  }

  const total = picked.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)

  async function handleAdd() {
    if (picked.length === 0) return setError('Tick at least one store to list.')
    if (!scheduledFor) return setError('Set the collection day.')
    // The real guard. `min` on the input is a browser hint only — it is trivially
    // bypassed by typing, and a store published into a past day is invisible to
    // the collectors' phones, so it would be born as "not worked".
    if (scheduledFor < today()) {
      return setError('That collection day has already passed. Pick today or a later day.')
    }

    const drafts: AddStoreDraft[] = []
    for (const p of picked) {
      const client = clientsById.get(p.clientId)
      const name = client?.company_name ?? 'That store'
      // Re-checked here rather than trusted from the tick: changing the day
      // after picking can put a store back onto a list it is already on.
      if (takenClientIds.has(p.clientId)) {
        return setError(`${name} is already on the list for this day — untick it.`)
      }
      const amount = Number(p.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        return setError(`Enter what ${name} owes, in whole pesos.`)
      }
      drafts.push({
        clientId: p.clientId, scheduledFor, amountDue: Math.round(amount), isAdditional,
      })
    }

    setBusy(true)
    const message = await onAdd(drafts)
    setBusy(false)
    if (message) return setError(message)
    onOpenChange(false)
  }

  function renderRow(client: Client) {
    const taken = takenClientIds.has(client.id)
    const checked = pickedIds.has(client.id)

    return (
      <button
        key={client.id}
        type="button"
        disabled={taken}
        onClick={() => toggle(client.id)}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
      >
        <span
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
          }`}
        >
          {checked && <Check className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm text-foreground">{client.company_name}</span>
            {taken && (
              <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                already listed
              </span>
            )}
          </span>
          {/* Two shops on the same round can share a name; they do not share a
              street. */}
          <span className="block truncate text-[11px] text-muted-foreground">
            {clientWhere(client)}
          </span>
        </span>
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Two columns, and a height that is capped rather than grown.
          Stacked and narrow, the picked list pushed the search box off the top
          and the "Add N stores" button off the bottom as soon as a dozen stores
          were ticked. Side by side, picking and pricing stay visible at once —
          which is the actual job — and each list scrolls inside its own box
          instead of the whole dialog scrolling.

          Wide, but not full-width: past roughly this width a store's name and
          its amount field drift far enough apart to need tracking across the
          row. */}
      <DialogContent className="sm:max-w-3xl max-h-[min(92dvh,50rem)] grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Add stores to the list</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3">
          {/* Full width and first, because it governs both columns: the day
              decides which stores below are already listed. */}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">
            <div className="space-y-1.5">
              <Label htmlFor="add-day">Collection day</Label>
              <Input
                id="add-day"
                type="date"
                value={scheduledFor}
                // Today is the floor. A store published into a past day is
                // invisible to the collectors' phones, which work today's list,
                // so it would be born as "not worked". The day cards disable
                // their own Add button for the same reason — this closes the
                // other route in, where the admin types a date by hand.
                min={today()}
                onChange={e => setScheduledFor(e.target.value)}
                className="w-44"
              />
            </div>
            <p className="min-w-0 flex-1 pb-2 text-[11px] leading-relaxed text-muted-foreground">
              {scheduledFor && scheduledFor < today() ? (
                <span className="text-destructive">
                  That day has already passed. Pick today or a later day.
                </span>
              ) : (
                <>Everything picked here goes onto this one day&apos;s list.</>
              )}
            </p>
          </div>

          {/* A definite height rather than a min/max pair: both columns need a
              box to fill, and this one tracks the viewport, so a short window
              gets a shorter dialog instead of a clipped one. */}
          <div className="grid min-h-0 h-[clamp(15rem,52dvh,26rem)] gap-4 md:grid-cols-2">
            {/* --- Left: what there is to pick --- */}
            <div className="flex min-h-0 flex-col gap-1.5">
              <Label htmlFor="add-store-search">Stores</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="add-store-search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => handleSearchKeyDown(e.key)}
                  placeholder={`Search ${clients.length.toLocaleString()} customers…`}
                  className="w-full pl-8"
                />
              </div>

              <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border">
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
                  {/* Names the exclusion as well as the miss — see the twin
                      note in ClientPicker. */}
                  {recent.length === 0 && rest.length === 0 && (
                    <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                      No customer matches that. Try part of the name, or the town — and note that
                      only customers who have placed an order are listed here, never prospects or
                      lost clients.
                    </p>
                  )}
                  {recent.length > 0 && (
                    <>
                      <p className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Recently listed
                      </p>
                      {recent.map(renderRow)}
                    </>
                  )}
                  {rest.length > 0 && (
                    <>
                      <p className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {query.trim() ? 'Matches' : 'All customers'}
                      </p>
                      {rest.map(renderRow)}
                    </>
                  )}
                </div>
                {/* Below the scroll area, not inside it: it is an instruction
                    about the list rather than the end of it. */}
                {hidden > 0 && (
                  <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                    {hidden.toLocaleString()} more {hidden === 1 ? 'match' : 'matches'} — keep
                    typing to narrow it down.
                  </p>
                )}
              </div>
            </div>

            {/* --- Right: what has been picked, and what each one owes --- */}
            <div className="flex min-h-0 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label>Picked ({picked.length})</Label>
                <div className="flex items-baseline gap-3">
                  {total > 0 && (
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {peso(total)} due in total
                    </span>
                  )}
                  {/* Starting over one X at a time is the tax on a mis-set day
                      or a wrong batch, which is exactly when the list is
                      longest. */}
                  {picked.length > 0 && (
                    <button
                      type="button"
                      onClick={removeAll}
                      className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Remove all
                    </button>
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border">
                {picked.length === 0 ? (
                  <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                    Nothing picked yet. Tick stores on the left, then type what each one
                    owes here.
                  </p>
                ) : (
                  <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-1">
                    {picked.map(p => {
                      const client = clientsById.get(p.clientId)
                      return (
                        <div key={p.clientId} className="flex items-center gap-2 px-1">
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {client?.company_name ?? 'Unknown store'}
                          </span>
                          <Input
                            inputMode="numeric"
                            placeholder="Amount due"
                            aria-label={`Amount due from ${client?.company_name ?? 'this store'}`}
                            value={p.amount}
                            onChange={e => setAmount(p.clientId, e.target.value.replace(/[^\d]/g, ''))}
                            className="h-8 w-32 tabular-nums"
                          />
                          <button
                            type="button"
                            onClick={() => toggle(p.clientId)}
                            aria-label={`Remove ${client?.company_name ?? 'this store'}`}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* The one deliberate escalation. Left unchecked, these are normal
                  stores published quietly to the day's list. Checked, they become
                  "additional" stores: badged and floated to the top on the
                  collectors' phones, and a text goes out per store. Kept a manual
                  choice precisely because it fires an SMS — never inferred from
                  the date. It sits under the picked column because that is the
                  set it applies to. */}
              <label
                htmlFor="add-additional"
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5 transition-colors hover:bg-muted/30"
              >
                <input
                  id="add-additional"
                  type="checkbox"
                  checked={isAdditional}
                  onChange={e => setIsAdditional(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium text-foreground">
                    Mark {picked.length > 1 ? `all ${picked.length}` : 'as'} additional — notify
                    collectors
                  </span>
                  <span className="block text-[11px] leading-relaxed text-muted-foreground">
                    For stores the collectors need to know about now, after the day&apos;s list is
                    already out. Every active collector gets a text
                    {picked.length > 1 ? ' per store' : ''} and the store jumps to the top of
                    their app.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="sm:justify-between">
          {/* The two product rules an admin most often asks about, parked where
              they are readable but out of the way of the work. */}
          <p className="max-w-sm self-center text-[11px] leading-relaxed text-muted-foreground">
            Whichever collector reaches a store takes it off the list — no one is assigned. They
            never see the amount due either; their app asks them to type what was actually handed
            over, with no target on screen.
          </p>
          <div className="flex gap-2 self-end sm:self-center">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={busy || picked.length === 0}>
              {isAdditional ? 'Add & notify' : 'Add'}
              {picked.length > 0 && ` ${picked.length} store${picked.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
