'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { CLIENT_SEARCH_LIMIT, clientWhere, searchClients } from '@/lib/client-search'
import { peso, pesoDelta } from '@/lib/money'
import { StorePaymentCalendar } from '@/components/collection/store-payment-calendar'
import type { CreditAdjustment } from '@/lib/hooks/use-store-credit'
import type { Client, ClientCreditEntry } from '@/types'
import { format } from 'date-fns'
import { Search, Wallet } from 'lucide-react'

/**
 * The Collection admin's store-credit tool (migration 117).
 *
 * A store now carries a running credit balance that persists across days and is
 * drawn down automatically by every collection. This is where the admin MAINTAINS
 * that balance: set a store's opening credit, add a charge when it buys more
 * goods, or correct the figure. Each action writes one signed-delta ledger entry;
 * the automatic `collection` drawdowns are the trigger's job and only ever appear
 * here as read-only history.
 *
 * Deliberately separate from Add-store: that dialog LISTS a store for a day (and
 * now auto-fills the day's amount from this balance); this one moves the balance
 * itself. Keeping them apart stops "set what the store owes overall" from being
 * confused with "collect from it today".
 */

interface StoreBalancesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The collectible customers (prospects/lost already filtered out by the caller). */
  clients: Client[]
  /** Every store's ledger history, keyed by client id — from `useStoreCredit`. */
  entriesByClient: Map<string, ClientCreditEntry[]>
  /** Records one signed-delta entry. Returns an error message, or null on success. */
  onAdjust: (input: CreditAdjustment) => Promise<string | null>
  /** The signed-in admin, stamped onto the entry's `created_by`. */
  createdBy: string | null
}

/** The three ways an admin moves a balance. `set` is an adjustment to an absolute target. */
type Mode = 'set' | 'charge' | 'adjust'

const MODE_LABEL: Record<Mode, string> = {
  set: 'Set balance',
  charge: 'Add charge',
  adjust: 'Adjust',
}

const ENTRY_LABEL: Record<ClientCreditEntry['entry_type'], string> = {
  adjustment: 'Adjustment',
  charge: 'Charge',
  collection: 'Collected',
}

/**
 * The store's live balance is the SUM of its ledger entries — authoritative and
 * instant, so it reflects an edit the moment `onAdjust` reloads them, without
 * waiting for the denormalized `clients.credit_balance` to refresh. Falls back to
 * that column before any entries have loaded.
 */
function balanceFor(client: Client, entries: ClientCreditEntry[] | undefined): number {
  if (entries && entries.length > 0) {
    return entries.reduce((sum, e) => sum + e.amount, 0)
  }
  return client.credit_balance ?? 0
}

export function StoreBalancesDialog({
  open, onOpenChange, clients, entriesByClient, onAdjust, createdBy,
}: StoreBalancesDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Which face of the right pane: maintain the balance, or read the payment calendar.
  const [view, setView] = useState<'manage' | 'calendar'>('manage')
  const [mode, setMode] = useState<Mode>('set')
  // Digits as typed; a string so the field can be legitimately empty. `set` and
  // `charge` are always positive; `adjust` pairs this with the sign toggle.
  const [amount, setAmount] = useState('')
  const [sign, setSign] = useState<1 | -1>(-1)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const clientsById = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients])
  const selected = selectedId ? clientsById.get(selectedId) : undefined

  const { matches, hidden } = useMemo(() => {
    const { matches, total } = searchClients(clients, query)
    return { matches, hidden: Math.max(0, total - CLIENT_SEARCH_LIMIT) }
  }, [clients, query])

  const selectedEntries = selectedId ? entriesByClient.get(selectedId) : undefined
  const balance = selected ? balanceFor(selected, selectedEntries) : 0

  function pick(id: string) {
    setSelectedId(id)
    setView('manage')
    setMode('set')
    setAmount('')
    setSign(-1)
    setNote('')
    setError('')
  }

  /** The signed delta and entry type this form would write, or an error string. */
  function resolveDelta(): { amount: number; entryType: CreditAdjustment['entryType']; note: string } | string {
    const magnitude = Number(amount)
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      return mode === 'set' ? 'Enter the new balance, in whole pesos.' : 'Enter an amount, in whole pesos.'
    }
    const whole = Math.round(magnitude)

    if (mode === 'charge') {
      return { amount: whole, entryType: 'charge', note: note.trim() || 'New charge' }
    }
    if (mode === 'adjust') {
      const delta = whole * sign
      return { amount: delta, entryType: 'adjustment', note: note.trim() || 'Manual adjustment' }
    }
    // set: move the balance to an absolute target via an adjustment of the gap.
    const delta = whole - Math.round(balance)
    if (delta === 0) return 'That is already the balance — nothing to change.'
    return { amount: delta, entryType: 'adjustment', note: note.trim() || `Set balance to ${peso(whole)}` }
  }

  async function handleSubmit() {
    if (!selected) return setError('Pick a store first.')
    const resolved = resolveDelta()
    if (typeof resolved === 'string') return setError(resolved)

    setBusy(true)
    const message = await onAdjust({
      clientId: selected.id,
      clientName: selected.company_name,
      entryType: resolved.entryType,
      amount: resolved.amount,
      note: resolved.note,
      createdBy,
    })
    setBusy(false)
    if (message) return setError(message)
    // Stay on the store so the admin sees the new balance and history; just clear
    // the inputs for the next movement.
    setAmount('')
    setNote('')
    setError('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[min(92dvh,50rem)] grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>Store credit balances</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 md:grid-cols-2">
          {/* --- Left: pick a store --- */}
          <div className="flex min-h-0 flex-col gap-1.5">
            <Label htmlFor="balance-search">Store</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="balance-search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={`Search ${clients.length.toLocaleString()} customers…`}
                className="w-full pl-8"
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
                {matches.length === 0 && (
                  <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                    No customer matches that. Try part of the name, or the town.
                  </p>
                )}
                {matches.map(client => {
                  const active = client.id === selectedId
                  const bal = balanceFor(client, entriesByClient.get(client.id))
                  return (
                    <button
                      key={client.id}
                      type="button"
                      onClick={() => pick(client.id)}
                      className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent ${
                        active ? 'bg-accent' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm text-foreground">{client.company_name}</span>
                          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                            {peso(bal)}
                          </span>
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {clientWhere(client)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {hidden > 0 && (
                <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                  {hidden.toLocaleString()} more {hidden === 1 ? 'match' : 'matches'} — keep typing to narrow it down.
                </p>
              )}
            </div>
          </div>

          {/* --- Right: the selected store's balance, the form, its history --- */}
          <div className="flex min-h-0 flex-col gap-3">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                Pick a store to see and adjust its credit balance.
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-border p-3">
                  <p className="truncate text-sm font-medium text-foreground">{selected.company_name}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xl font-semibold tabular-nums text-foreground">{peso(balance)}</span>
                    <span className="text-[11px] text-muted-foreground">owed</span>
                  </div>
                </div>

                {/* Manage the balance, or read the payment calendar. */}
                <div className="flex gap-1 rounded-lg bg-muted/50 p-0.5 text-xs">
                  {(['manage', 'calendar'] as const).map(v => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView(v)}
                      className={`flex-1 rounded-md px-2 py-1.5 font-medium transition-colors ${
                        view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {v === 'manage' ? 'Adjust' : 'Payment calendar'}
                    </button>
                  ))}
                </div>

                {view === 'calendar' ? (
                  <StorePaymentCalendar entries={selectedEntries ?? []} />
                ) : (
                <>
                {/* Mode picker */}
                <div className="flex gap-1 rounded-lg border border-border p-1">
                  {(['set', 'charge', 'adjust'] as Mode[]).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setMode(m); setError('') }}
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                        mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {MODE_LABEL[m]}
                    </button>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex items-end gap-2">
                    {mode === 'adjust' && (
                      <button
                        type="button"
                        onClick={() => setSign(s => (s === 1 ? -1 : 1))}
                        aria-label={sign === 1 ? 'Increase' : 'Decrease'}
                        className="h-9 w-9 shrink-0 rounded-md border border-input text-base font-semibold text-foreground hover:bg-accent"
                      >
                        {sign === 1 ? '+' : '−'}
                      </button>
                    )}
                    <div className="flex-1 space-y-1.5">
                      <Label htmlFor="balance-amount">
                        {mode === 'set' ? 'New balance' : mode === 'charge' ? 'Charge amount' : 'Amount'}
                      </Label>
                      <Input
                        id="balance-amount"
                        inputMode="numeric"
                        value={amount}
                        onChange={e => { setAmount(e.target.value.replace(/[^\d]/g, '')); setError('') }}
                        placeholder="0"
                        className="tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="balance-note">Note (optional)</Label>
                    <Input
                      id="balance-note"
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      placeholder={mode === 'charge' ? 'e.g. new order — 20 sacks' : 'e.g. opening balance'}
                    />
                  </div>

                  {error && <p className="text-xs text-destructive">{error}</p>}

                  <Button onClick={handleSubmit} disabled={busy} className="w-full">
                    {MODE_LABEL[mode]}
                  </Button>
                </div>

                {/* History */}
                <div className="flex min-h-0 flex-1 flex-col">
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Recent movements
                  </p>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-border">
                    {!selectedEntries || selectedEntries.length === 0 ? (
                      <p className="px-3 py-3 text-xs text-muted-foreground">No movements yet.</p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {selectedEntries.map(entry => (
                          <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                            <div className="min-w-0">
                              <p className="text-foreground">
                                {ENTRY_LABEL[entry.entry_type]}
                                {entry.note && <span className="text-muted-foreground"> · {entry.note}</span>}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {format(new Date(entry.created_at), 'MMM d, yyyy · h:mm a')}
                                {entry.author?.full_name && <> · {entry.author.full_name}</>}
                              </p>
                            </div>
                            <span
                              className={`shrink-0 tabular-nums font-medium ${
                                entry.amount < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'
                              }`}
                            >
                              {pesoDelta(entry.amount)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                </>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
