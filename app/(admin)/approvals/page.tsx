'use client'

import { Header } from '@/components/header'
import { StoreLocationPanel } from '@/components/maps/store-location-panel'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Pagination } from '@/components/ui/pagination'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useEditRequests } from '@/lib/hooks/use-edit-requests'
import { usePoConfirmations } from '@/lib/hooks/use-po-confirmations'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PersonSelect } from '@/components/ui/person-select'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { useTeams } from '@/lib/hooks/use-teams'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { teamsWithManagers } from '@/lib/teams'
import { roleLabel } from '@/lib/permissions'
import { PhotoLightbox, captionFor, type LightboxPhoto } from '@/components/photo-lightbox'
import type { ApprovalStatus, ClientEditRequest, PoConfirmationRequest } from '@/types'
import { ClipboardCheck, Check, CheckCheck, X, Clock, ArrowRight, Loader2, FileCheck, Camera, Maximize2, Hourglass, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { toast } from 'sonner'
import { APPROVAL_TONE, CUSTOMER_TYPE_LABEL, FIELD_LABEL, OUTCOME_LABEL_SHORT, TONE_CLASS, VALUE_LABEL } from '@/lib/status-styles'
import { cn } from '@/lib/utils'

/** Which record kind the queue is narrowed to. */
type KindFilter = 'all' | 'edit' | 'po'

/**
 * How long a request has been sitting unanswered — the manager app leads its
 * detail screen with this (BizPendingBanner), because "waiting since" is what
 * turns a queue into a priority order. Shown on pending cards only.
 */
function WaitingSince({ since }: { since: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-3">
      <Hourglass className="w-3 h-3 shrink-0 opacity-70" />
      Waiting {formatDistanceToNowStrict(new Date(since))}
    </p>
  )
}

/**
 * One changed value, as a manager should read it.
 *
 * `String(change.old)` was rendering the literal text "null" for any field
 * that was previously blank — which is most of them, since the common case is
 * an agent FILLING IN a detail that was never set (spotted on a device
 * 2026-08-31). An em dash is what "there was nothing here before" looks like,
 * and it matches what mobile already showed via
 * `formatClientEditFieldValue()` in lib/client-edit-field-labels.ts.
 */
function changeValueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const asString = String(value)
  return VALUE_LABEL[asString] ?? asString
}

export default function ApprovalsPage() {
  // No useCurrentProfile() here: decide_client_edit_request() stamps
  // reviewed_by from current_profile_id() server-side, so the reviewer's
  // identity is never the client's to assert.
  const { requests, loading, error, review, reviewMany } = useEditRequests()
  const { requests: poRequests, loading: poLoading, error: poError, decide } = usePoConfirmations()
  // Only for the requester picker's team headings, never for the queue itself.
  const { teams } = useTeams()
  const { profiles } = useProfiles()

  // Sibling of the cards, never nested in a dialog — see PhotoLightbox's note.
  const [lightbox, setLightbox] = useState<LightboxPhoto | null>(null)

  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  // By person, through PersonSelect — the same control Clock Records, Maps,
  // Dashboard and Reports use for "filter by person". A plain <Select> of
  // names is what that component exists to replace (its own header calls out
  // "scrolling a forty-name dropdown to find a name you already knew"), and
  // grouping by team comes free. Filtering by ROLE was the wrong axis: only
  // agents file these, so every option but one would return nothing.
  const [agentFilter, setAgentFilter] = useState('all')
  // 'all' by default: an approval queue is a backlog, and defaulting to a
  // window would hide the oldest items — exactly the ones most in need of a
  // decision. Same default the Meetings and Clock Records pages use.
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })

  /**
   * Bulk-approve selection — CLIENT EDITS ONLY, and one agent at a time.
   *
   * Two deliberate exclusions:
   *
   *   - PO confirmations are never selectable. A client edit is a field diff
   *     that is fully readable on the card; a PO is a photo you have to open,
   *     and approving it fires `promote_on_po_confirmed` (040), which promotes
   *     the client In Progress -> New in the same transaction. Bulk-approving
   *     POs is bulk-approving evidence nobody looked at, and nothing on this
   *     page undoes the promotion. They keep their single Approve/Reject.
   *
   *   - Rejection has no bulk path. A rejection is only actionable to the
   *     agent if it says WHY (RequestCard renders `review_note` for exactly
   *     that reason), and one note cannot honestly cover a batch.
   *
   * Locking the selection to a single requester is the rule Adrian asked for
   * and it is also the safe one: "everything Adrian filed today" is a
   * defensible unit of review, "nine cards I happened to tick" is not.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  /**
   * One queue, two record types.
   *
   * A client-edit request (prospect -> existing, contact details) and a PO
   * confirmation (the last gate on in_progress -> new) are the same thing from
   * an admin's chair: an agent is waiting on a decision. Both are normally a
   * manager's call in the mobile app, and on both the admin is the fallback
   * when the manager cannot act — so they belong in the same Pending list
   * rather than a separate read-only shelf.
   *
   * They stay distinguishable by `kind` because the decision goes through a
   * different RPC for each, and because a PO shows a photo reference rather
   * than a field diff.
   */
  /**
   * Filters run over BOTH record types before either list is built, so a
   * search term means the same thing whichever kind it matches. Everything is
   * client-side because both hooks already hold the full set — the same
   * convention as Meetings and Clients.
   */
  const term = search.trim().toLowerCase()
  const matchesEdit = (r: ClientEditRequest) =>
    (kindFilter === 'all' || kindFilter === 'edit') &&
    (agentFilter === 'all' || r.requested_by === agentFilter) &&
    dateFilter.inRange(r.created_at) &&
    (!term ||
      r.client?.company_name?.toLowerCase().includes(term) ||
      r.requester?.full_name?.toLowerCase().includes(term) ||
      // The field being changed is the thing an admin scans for on these.
      Object.keys(r.changes).some(f => (FIELD_LABEL[f] ?? f).toLowerCase().includes(term)))

  const matchesPo = (r: PoConfirmationRequest) =>
    (kindFilter === 'all' || kindFilter === 'po') &&
    (agentFilter === 'all' || r.requester_id === agentFilter) &&
    dateFilter.inRange(r.created_at) &&
    (!term ||
      r.company_name?.toLowerCase().includes(term) ||
      r.requester_name?.toLowerCase().includes(term))

  const pending = [
    ...requests
      .filter(r => r.status === 'pending' && matchesEdit(r))
      .map(r => ({ kind: 'edit' as const, key: `edit-${r.id}`, created_at: r.created_at, edit: r })),
    ...poRequests
      .filter(r => r.status === 'pending' && matchesPo(r))
      .map(r => ({ kind: 'po' as const, key: `po-${r.id}`, created_at: r.created_at, po: r })),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  const teamOptions = useMemo(() => teamsWithManagers(teams, profiles), [teams, profiles])

  // Built from the requests rather than from every profile: this page can only
  // filter to someone who has actually filed one, and offering the rest would
  // be offering guaranteed-empty results. Same reasoning as Clock Records.
  const agentOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; teamId: string | null }>()
    for (const r of requests) {
      if (r.requester) {
        byId.set(r.requested_by, {
          id: r.requested_by,
          name: r.requester.full_name,
          teamId: r.requester.team_id,
        })
      }
    }
    for (const r of poRequests) {
      if (r.requester_name) {
        byId.set(r.requester_id, {
          id: r.requester_id,
          name: r.requester_name,
          teamId: r.requester_team_id ?? null,
        })
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [requests, poRequests])

  // Only decides how the empty state reads — "nothing pending" and "nothing
  // matches" look identical but mean opposite things. Each control clears
  // itself, so there is no page-level reset (matching Meetings and Clock
  // Records, which have none either).
  const filtersActive =
    !!term || kindFilter !== 'all' || agentFilter !== 'all' || dateFilter.isActive

  /**
   * Decided items, newest first — the same merge as `pending`.
   *
   * Worth having both kinds here rather than only edit requests: an approved PO
   * would otherwise disappear off this page entirely the moment it was decided,
   * and the row's `decided_by` is the only record of who did it that survives
   * across platforms. `admin_audit_logs` covers the web side, but a manager
   * approving on mobile never lands there — lib/audit/actions.ts drops anything
   * without web access, by design.
   */
  const resolved = [
    ...requests
      .filter(r => r.status !== 'pending' && matchesEdit(r))
      .map(r => ({
        kind: 'edit' as const,
        key: `edit-${r.id}`,
        at: r.reviewed_at ?? r.created_at,
        edit: r,
      })),
    ...poRequests
      .filter(r => r.status !== 'pending' && matchesPo(r))
      .map(r => ({
        kind: 'po' as const,
        key: `po-${r.id}`,
        at: r.decided_at ?? r.created_at,
        po: r,
      })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  // The reset key carries the filter signature, so narrowing the results from
  // page 4 snaps back to page 1 instead of showing an empty grid.
  const filterKey = `${term}|${kindFilter}|${agentFilter}|${dateFilter.key}`
  const pendingPage = usePagination(pending, 9, `pending|${filterKey}`)
  const resolvedPage = usePagination(resolved, 9, `resolved|${filterKey}`)

  /**
   * The selection, resolved against what is actually on screen.
   *
   * `selected` is never pruned by an effect. It is intersected with the
   * currently-visible pending edits on every render instead, so narrowing a
   * filter, or a request being decided out from under this tab by a manager on
   * mobile, drops it from the selection with no extra state write and no
   * chance of the two disagreeing. Ticks are remembered if the filter is
   * widened again.
   *
   * Deliberately the WHOLE filtered set, not `pendingPage.pageItems`: "select
   * all 12 from this agent" must mean all twelve, including the three on page
   * two. Pagination is a viewport here, not a scope.
   */
  const pendingEdits = pending.flatMap(item => (item.kind === 'edit' ? [item.edit] : []))
  const visibleIds = new Set(pendingEdits.map(r => r.id))
  const selectedIds = [...selected].filter(id => visibleIds.has(id))
  const selectedSet = new Set(selectedIds)

  // Whose queue the current selection belongs to — read off the first ticked
  // card rather than tracked separately, so it cannot drift from `selected`.
  // Null means nothing is ticked and every pending edit is up for grabs.
  const selectionAgentId = selectedIds.length
    ? pendingEdits.find(r => r.id === selectedIds[0])?.requested_by ?? null
    : null
  const selectionAgentName =
    pendingEdits.find(r => r.requested_by === selectionAgentId)?.requester?.full_name ?? 'this agent'
  const agentPendingEdits = selectionAgentId
    ? pendingEdits.filter(r => r.requested_by === selectionAgentId)
    : []
  // Someone else has pending work in view, so the dimming needs explaining.
  const othersPending = pendingEdits.length > agentPendingEdits.length

  function toggleSelected(id: string, checked: boolean) {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /**
   * Approve every ticked request.
   *
   * `reviewMany` returns both lists because partial success is the normal
   * outcome, not an edge case — see its own note. What survives the call is
   * the useful part: the failures stay ticked, so once the toast fades the
   * cards still selected are exactly the ones that need a second look, with
   * their reason on screen rather than only in a dismissed toast.
   */
  async function handleBulkApprove() {
    const ids = selectedIds
    if (!ids.length) return
    // Captured before the await: `load()` re-renders the page and this name is
    // derived from rows that are about to be replaced.
    const agentName = selectionAgentName

    setBulkBusy(true)
    const { approved, failures } = await reviewMany(ids)
    setBulkBusy(false)
    setSelected(new Set(failures.map(f => f.id)))

    // Distinct reasons rather than one line per request: the failures are
    // still ticked on screen, so the toast has to answer "why", not "which".
    const reasons = [...new Set(failures.map(f => f.message))].join(' ')

    if (!failures.length) {
      toast.success(`Approved ${approved.length} request${approved.length === 1 ? '' : 's'} from ${agentName}`)
    } else if (approved.length) {
      toast.warning(
        `${approved.length} approved, ${failures.length} skipped`,
        { description: `${reasons} The skipped requests are still selected.` }
      )
    } else {
      toast.error(
        `Couldn't approve ${failures.length} request${failures.length === 1 ? '' : 's'}`,
        { description: reasons }
      )
    }
  }

  async function handleReview(id: string, action: 'approved' | 'rejected') {
    const reviewError = await review(id, action)
    if (reviewError) {
      toast.error(`Couldn't ${action === 'approved' ? 'approve' : 'reject'}: ${reviewError}`)
      return
    }
    toast.success(`Request ${action === 'approved' ? 'approved' : 'rejected'} successfully`)
  }

  async function handlePoDecision(id: string, action: 'approved' | 'rejected') {
    const decideError = await decide(id, action)
    if (decideError) {
      toast.error(`Couldn't ${action === 'approved' ? 'approve' : 'reject'}: ${decideError}`)
      return
    }
    toast.success(`PO confirmation ${action === 'approved' ? 'approved' : 'rejected'} successfully`)
  }

  /**
   * A PO confirmation awaiting a decision.
   *
   * Approving is what actually unblocks the client: the `promote_on_po_confirmed`
   * trigger (040) re-runs `advance_in_progress_to_new()` in the same
   * transaction, so the client reaches New without anyone touching it again.
   */
  function PoCard({ po }: { po: PoConfirmationRequest }) {
    return (
      <Card className="bg-card border-border h-full flex flex-col">
        <CardContent className="p-4 flex flex-col flex-1">
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0">
              <p className="font-semibold text-foreground text-sm truncate">
                {po.company_name ?? 'Unnamed client'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Requested by <span className="text-foreground">{po.requester_name ?? '—'}</span>
                {po.requester_role && <span className="opacity-70"> ({roleLabel(po.requester_role)})</span>}
                {' · '}{format(new Date(po.created_at), 'MMM d, h:mm a')}
              </p>
            </div>
            {/* Status, exactly as RequestCard renders it. This slot answers
                "where is this in its lifecycle" on every card in the grid; the
                record TYPE is carried by the body line below, not here. */}
            <Badge
              variant="tone"
              className={TONE_CLASS[po.status === 'cancelled' ? 'neutral' : APPROVAL_TONE[po.status as ApprovalStatus]]}
            >
              {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
            </Badge>
          </div>

          {/* Same shape as RequestCard's change rows: what this decision does
              to the record, as a labelled before -> after. A PO carries no
              field diff of its own, but approving it moves customer_type, so
              that IS the change — and it reads identically to the
              Prospect -> Existing rows sitting beside it in the grid.

              Rendered for decided requests too, matching RequestCard, which
              keeps showing a rejected request's diff: the box says what was
              asked for, not what necessarily happened. */}
          <div className="space-y-2 mb-3">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <FileCheck className="w-3.5 h-3.5 shrink-0 opacity-70" />
              Close-deal PO confirmation
            </p>
            <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs">
              <p className="text-muted-foreground mb-1.5 font-medium">Customer Type</p>
              <div className="flex items-center gap-2">
                <span className="bg-destructive/10 text-destructive px-2 py-0.5 rounded line-through">
                  {/* The stage FROZEN at the close-deal meeting (067), not the
                      client's live `customer_type`.

                      The live value was wrong twice over. The old comment here
                      claimed "a PO can only be pending from in_progress —
                      advance_in_progress_to_new() requires it (040)", which
                      migration 110 made false: a prospect's close-deal PO
                      routes through advance_prospect_to_new() and never
                      touches in_progress at all. And on a DECIDED request the
                      live value has already been advanced by
                      trg_promote_on_po_confirmed, so an approved card rendered
                      its own outcome on both sides — the "New -> New" Adrian
                      hit on an approved close-deal PO (2026-09-01).

                      Pre-067 meetings have no frozen stage. Falling back to
                      the live value is right only while the PO is still
                      pending (nothing has moved yet); on a decided one there
                      is no honest answer, so it shows the same em dash
                      changeValueLabel() uses for "nothing recorded". */}
                  {po.stage_at_meeting
                    ? CUSTOMER_TYPE_LABEL[po.stage_at_meeting]
                    : po.status === 'pending' && po.customer_type
                      ? CUSTOMER_TYPE_LABEL[po.customer_type]
                      : '—'}
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="bg-primary/10 text-primary px-2 py-0.5 rounded font-medium">
                  {CUSTOMER_TYPE_LABEL.new}
                </span>
              </div>
            </div>

            {/* The evidence itself. Approving without seeing this is approving
                blind, and it is the whole reason the manager's screen exists —
                their detail view leads with the photo under a "PO Evidence"
                heading. `po_photo_path` holds a full public URL once the phone
                has synced (mobile's po-confirmation-service.ts overwrites the
                local path with the uploaded URL), so it renders directly; the
                bucket is public, like meeting-photos and collection-proofs. */}
            {/* A peek, not the document. Full-bleed 4:3 made every PO card
                tower over the edit-request cards beside it, and a PO is
                unreadable at card width anyway — the decision gets made in the
                lightbox. Sized like RemittanceProofThumb, which exists for
                exactly this reason on the Collection/Delivery cards.

                The thumbnail earns its place by answering "did evidence
                actually arrive?" without a click; the button does the reading. */}
            <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs space-y-1.5">
              <p className="text-muted-foreground font-medium">PO Evidence</p>
              {po.po_photo_path?.startsWith('http') ? (
                <button
                  type="button"
                  onClick={() => setLightbox({
                    url: po.po_photo_path,
                    label: 'Purchase order',
                    caption: captionFor(po.requester_name, po.created_at),
                  })}
                  aria-label="View purchase order full size"
                  className="group flex w-full items-center gap-2.5 cursor-pointer rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="relative block h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={po.po_photo_path} alt="" className="h-full w-full object-cover" />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
                      <Maximize2 className="w-3.5 h-3.5 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium text-primary group-hover:underline">
                      <FileCheck className="w-3.5 h-3.5 shrink-0" /> View PO photo
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {format(new Date(po.created_at), 'MMM d, h:mm a')}
                    </span>
                  </span>
                </button>
              ) : (
                /* Mirrors mobile's "Available after sync": the row exists but
                   the phone has not uploaded the image yet, so the path is
                   still a local file reference. Not a missing PO. */
                <div className="flex items-center gap-2.5 text-muted-foreground">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-border">
                    <Camera className="w-4 h-4 opacity-50" />
                  </span>
                  <span className="text-[11px]">Available after the agent syncs</span>
                </div>
              )}
            </div>

            {/* The meeting this PO came out of. Mobile prints the raw UUID; a
                date and outcome is the same reference an admin can check. */}
            {(po.meeting_date || po.meeting_contact_person) && (
              <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs space-y-1">
                <p className="text-muted-foreground font-medium">Close-deal meeting</p>
                {po.meeting_date && (
                  <p className="text-muted-foreground">
                    <span className="text-foreground">{format(new Date(po.meeting_date), 'MMM d, yyyy')}</span>
                    {po.meeting_outcome && <> · {OUTCOME_LABEL_SHORT[po.meeting_outcome]}</>}
                  </p>
                )}
                {po.meeting_contact_person && (
                  <p className="text-muted-foreground">
                    Met <span className="text-foreground">{po.meeting_contact_person}</span>
                  </p>
                )}
              </div>
            )}
          </div>

          {po.status === 'pending' ? (
            <div className="mt-auto">
              <WaitingSince since={po.created_at} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => handlePoDecision(po.id, 'approved')}
                  className="flex-1 h-8 bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs"
                  variant="outline"
                >
                  <Check className="w-3.5 h-3.5 mr-1" /> Approve
                </Button>
                <Button
                  size="sm"
                  onClick={() => handlePoDecision(po.id, 'rejected')}
                  className="flex-1 h-8 bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/30 text-xs"
                  variant="outline"
                >
                  <X className="w-3.5 h-3.5 mr-1" /> Reject
                </Button>
              </div>
            </div>
          ) : (
            /* Who decided it, on whichever platform they used. */
            <p className="mt-auto text-xs text-muted-foreground">
              {po.decision_note && (
                <span className="mb-2 block rounded-lg bg-muted/30 px-3 py-2 text-foreground">
                  {po.decision_note}
                </span>
              )}
              {po.status === 'cancelled' ? 'Cancelled' : 'Decided'} by{' '}
              <span className="text-foreground">{po.decider_name ?? 'Unknown'}</span>
              {po.decider_role && <span className="opacity-70"> ({roleLabel(po.decider_role)})</span>}
              {' · '}
              {po.decided_at ? format(new Date(po.decided_at), 'MMM d, h:mm a') : '—'}
            </p>
          )}
        </CardContent>
      </Card>
    )
  }

  /**
   * `selectable` is passed only by the Pending tab. The Resolved tab renders
   * the identical card with no tick box, because there is nothing left to
   * decide there.
   */
  function RequestCard({ req, selectable = false }: { req: ClientEditRequest; selectable?: boolean }) {
    const showCheckbox = selectable && req.status === 'pending'
    const checked = selectedSet.has(req.id)
    // Another agent's request while a selection is open. Dimmed AND disabled
    // rather than hidden: the queue still has to read as one backlog, and an
    // admin needs to see that the card is there before deciding to clear the
    // selection and get to it.
    const locked = showCheckbox && selectionAgentId !== null && req.requested_by !== selectionAgentId

    /**
     * A close-deal PO waiting on the SAME client, when this request is the one
     * kind a promotion can invalidate (customer_type -> existing).
     *
     * Scoped to pending-vs-pending: a decided PO has already had its effect,
     * and 129's trigger has already superseded this request if it was going to.
     */
    const competingPo =
      req.status === 'pending' &&
      req.changes.customer_type?.new === 'existing' &&
      poRequests.some(p => p.client_id === req.client_id && p.status === 'pending')

    return (
      <Card
        key={req.id}
        className={cn(
          'bg-card border-border h-full flex flex-col transition-opacity',
          checked && 'border-primary/50 ring-1 ring-primary/30',
          locked && 'opacity-45'
        )}
      >
        <CardContent className="p-4 flex flex-col flex-1">
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="flex items-start gap-2.5 min-w-0">
              {showCheckbox && (
                <Checkbox
                  checked={checked}
                  disabled={locked || bulkBusy}
                  onCheckedChange={value => toggleSelected(req.id, value)}
                  // The company name alone would give the grid nine identical
                  // "Select" controls to a screen reader once two requests
                  // touch the same client.
                  aria-label={`Select the ${Object.keys(req.changes).map(f => FIELD_LABEL[f] ?? f).join(', ')} change for ${req.client?.company_name ?? 'this client'}`}
                  className="mt-0.5"
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-foreground text-sm">{req.client?.company_name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Requested by <span className="text-foreground">{req.requester?.full_name}</span>
                  {req.requester?.role && <span className="opacity-70"> ({roleLabel(req.requester.role)})</span>}
                  {' · '}{format(new Date(req.created_at), 'MMM d, h:mm a')}
                </p>
              </div>
            </div>
            <Badge variant="tone" className={TONE_CLASS[APPROVAL_TONE[req.status]]}>
              {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
            </Badge>
          </div>

          {/* Changes */}
          <div className="space-y-2 mb-3">
            {Object.entries(req.changes).map(([field, change]) => (
              <div key={field} className="bg-muted/30 rounded-lg px-3 py-2 text-xs">
                <p className="text-muted-foreground mb-1.5 font-medium">{FIELD_LABEL[field] ?? field}</p>
                <div className="flex items-center gap-2">
                  <span className="bg-destructive/10 text-destructive px-2 py-0.5 rounded line-through">
                    {changeValueLabel(change.old)}
                  </span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="bg-primary/10 text-primary px-2 py-0.5 rounded font-medium">
                    {changeValueLabel(change.new)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* The order-of-decision warning.
              Both of these are pending on the same client, and approving the
              PO first promotes them to New — which migration 129 then treats
              as superseding this request. So the sequence silently decides the
              outcome, and an admin working down a queue has no way to see that
              from the two cards alone. This is the only place the collision is
              visible before it happens.

              Deliberately a warning and not a block: both decisions are
              legitimate, and which one should win is a judgement about this
              client that belongs to the person reading the card. */}
          {competingPo && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-500 bg-amber-500/10 rounded-lg px-3 py-2 mb-3">
              <FileCheck className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                This client also has a PO confirmation waiting. Approving that
                first promotes them to New and supersedes this request — decide
                them together.
              </span>
            </p>
          )}

          <StoreLocationPanel clientId={req.client_id} hideMap className="mb-3" />

          {/* mt-auto: cards in a row stretch to the tallest one, so without it
              the actions float wherever the content happens to end and no two
              cards agree on where Approve is. */}
          {req.status === 'pending' && (
            <div className="mt-auto">
              <WaitingSince since={req.created_at} />
              {/* Disabled while another agent's batch is staged or running:
                  a one-off decision taken mid-selection is the case where the
                  admin has lost track of what the buttons apply to. Clearing
                  the selection re-enables them. */}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={locked || bulkBusy}
                  onClick={() => handleReview(req.id, 'approved')}
                  className="flex-1 h-8 bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-xs"
                  variant="outline"
                >
                  <Check className="w-3.5 h-3.5 mr-1" /> Approve
                </Button>
                <Button
                  size="sm"
                  disabled={locked || bulkBusy}
                  onClick={() => handleReview(req.id, 'rejected')}
                  className="flex-1 h-8 bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/30 text-xs"
                  variant="outline"
                >
                  <X className="w-3.5 h-3.5 mr-1" /> Reject
                </Button>
              </div>
            </div>
          )}

          {req.status !== 'pending' && (
            <div className="mt-auto">
              {/* The decider's reason, when there is one. Mobile's manager
                  detail screen surfaces this under a "Note" heading; on a
                  rejected request it is the only record of WHY, which the
                  agent has to act on. */}
              {req.review_note && (
                <p className="bg-muted/30 rounded-lg px-3 py-2 text-xs text-foreground mb-2">
                  {req.review_note}
                </p>
              )}
              {req.reviewer && (
                <p className="text-xs text-muted-foreground">
                  Reviewed by {req.reviewer.full_name} ({roleLabel(req.reviewer.role)}) · {req.reviewed_at ? format(new Date(req.reviewed_at), 'MMM d, h:mm a') : '—'}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col flex-1">
      {/* No longer only edit requests, so neither the title nor the subtitle
          can say so — and "Approvals" matches the sidebar label. */}
      <Header
        title="Approvals"
        subtitle="Client detail changes and PO confirmations"
        pendingApprovals={pending.length}
      />

      <div className="flex-1 p-6">
        {(error || poError) && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription className="text-xs">
              Couldn&apos;t load approval requests: {error || poError}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-3 mb-5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search client, requester, or field..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-card border-border h-9"
            />
          </div>
          <Select value={kindFilter} onValueChange={v => setKindFilter((v ?? 'all') as KindFilter)}>
            <SelectTrigger className="w-44 h-9 bg-card border-border">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="edit">Client Edits</SelectItem>
              <SelectItem value="po">PO Confirmations</SelectItem>
            </SelectContent>
          </Select>
          <PersonSelect
            options={agentOptions}
            value={agentFilter}
            onChange={setAgentFilter}
            allLabel="All Agents"
            teams={teamOptions}
            aria-label="Requester"
          />
          <DateRangeFilter filter={dateFilter} />
        </div>

        <Tabs defaultValue="pending">
          <TabsList className="bg-card border border-border mb-5">
            <TabsTrigger value="pending" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Clock className="w-3.5 h-3.5 mr-1.5" /> Pending ({pending.length})
            </TabsTrigger>
            <TabsTrigger value="resolved" className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <ClipboardCheck className="w-3.5 h-3.5 mr-1.5" /> Resolved ({resolved.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            {loading || poLoading ? (
              <div className="text-center py-16 text-muted-foreground">
                <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
                <p className="text-sm">Loading approval requests…</p>
              </div>
            ) : pending.length === 0 ? (
              /* An empty queue and a filter that matches nothing look identical
                 but mean opposite things — one is "you're done", the other is
                 "you're not seeing it". */
              <div className="text-center py-16 text-muted-foreground">
                <ClipboardCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">
                  {filtersActive ? 'No pending approvals match these filters' : 'No pending approvals'}
                </p>
              </div>
            ) : (
              <>
                {/* Sticky under the 61px Header (which is itself sticky
                    top-0), so ticking a card at the bottom of page 1 does not
                    scroll the Approve button out of reach. Bled to the
                    gutters with -mx-6/px-6 and given an opaque backdrop, or
                    the cards would show through it as they scroll under. */}
                {selectedIds.length > 0 && (
                  <div className="sticky top-[61px] z-10 -mx-6 mb-4 bg-background/95 px-6 py-2 backdrop-blur-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
                      <span className="text-xs font-semibold text-foreground">
                        {selectedIds.length} selected from {selectionAgentName}
                      </span>
                      {selectedIds.length < agentPendingEdits.length && (
                        <Button size="xs" variant="ghost" disabled={bulkBusy} onClick={() => setSelected(new Set(agentPendingEdits.map(r => r.id)))}>
                          Select all {agentPendingEdits.length}
                        </Button>
                      )}
                      {othersPending && (
                        <span className="text-[11px] text-muted-foreground">
                          Other agents&apos; requests are locked until you clear this.
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        <Button size="sm" disabled={bulkBusy} onClick={handleBulkApprove}>
                          {bulkBusy
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <CheckCheck className="w-3.5 h-3.5" />}
                          {bulkBusy ? 'Approving…' : `Approve ${selectedIds.length}`}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={bulkBusy}
                          onClick={() => setSelected(new Set())}
                          aria-label="Clear selection"
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {pendingPage.pageItems.map(item =>
                    item.kind === 'po'
                      ? <PoCard key={item.key} po={item.po} />
                      : <RequestCard key={item.key} req={item.edit} selectable />
                  )}
                </div>
                <Pagination
                  className="mt-4"
                  page={pendingPage.page} pageCount={pendingPage.pageCount} onPageChange={pendingPage.setPage}
                  from={pendingPage.from} to={pendingPage.to} total={pendingPage.total} itemLabel="requests"
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="resolved">
            {loading || poLoading ? (
              <div className="text-center py-16 text-muted-foreground">
                <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin opacity-60" />
                <p className="text-sm">Loading approval requests…</p>
              </div>
            ) : resolved.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <ClipboardCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">
                  {filtersActive ? 'No resolved requests match these filters' : 'Nothing has been decided yet'}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {resolvedPage.pageItems.map(item =>
                    item.kind === 'po'
                      ? <PoCard key={item.key} po={item.po} />
                      : <RequestCard key={item.key} req={item.edit} />
                  )}
                </div>
                <Pagination
                  className="mt-4"
                  page={resolvedPage.page} pageCount={resolvedPage.pageCount} onPageChange={resolvedPage.setPage}
                  from={resolvedPage.from} to={resolvedPage.to} total={resolvedPage.total} itemLabel="requests"
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <PhotoLightbox photo={lightbox} onOpenChange={open => !open && setLightbox(null)} />
    </div>
  )
}
