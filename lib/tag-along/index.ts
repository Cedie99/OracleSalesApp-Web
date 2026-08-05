import type { BadgeTone } from '@/lib/status-styles'
import type { TagAlongInviteeKind, TagAlongRequest, TagAlongStatus } from '@/types'

/**
 * Reading the tag-along ledger. Pure derivation over an already-loaded set —
 * no fetching here, so every surface reads the same rows the same way.
 *
 * The one rule that governs this whole file: a `manager` invitee and a
 * `teammate` invitee are different facts and never sum. A manager tag-along is
 * a validation gate with consequences in the cutoff ledger and the lifecycle
 * triggers; a teammate tag-along is someone riding along to learn. Presenting
 * "4 tag-alongs" would be true of both and useful for neither.
 */

export const TAG_ALONG_STATUS_LABEL: Record<TagAlongStatus, string> = {
  pending: 'Awaiting response',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
}

export const TAG_ALONG_STATUS_TONE: Record<TagAlongStatus, BadgeTone> = {
  pending: 'amber',
  accepted: 'brand',
  declined: 'red',
  cancelled: 'neutral',
}

export const INVITEE_KIND_LABEL: Record<TagAlongInviteeKind, string> = {
  manager: 'Manager',
  teammate: 'Teammate',
}

/**
 * The manager-confirmation state of a single meeting.
 *
 * `none` means no manager was invited, which is the normal case and carries no
 * suspicion — it is not a missing approval. Kept distinct from `accepted` so
 * the UI can stay silent instead of displaying a reassurance nobody asked for.
 */
export type ManagerGate = 'none' | 'pending' | 'accepted' | 'declined'

export const MANAGER_GATE_LABEL: Record<ManagerGate, string> = {
  none: 'No manager tag-along',
  pending: 'Awaiting manager confirmation',
  accepted: 'Manager confirmed',
  declined: 'Manager declined',
}

export const MANAGER_GATE_TONE: Record<ManagerGate, BadgeTone> = {
  none: 'neutral',
  pending: 'amber',
  accepted: 'brand',
  declined: 'red',
}

/** Group by the meeting a request is attached to. Client-creation rows have none. */
export function tagAlongsByMeeting(requests: TagAlongRequest[]): Map<string, TagAlongRequest[]> {
  const map = new Map<string, TagAlongRequest[]>()
  for (const r of requests) {
    if (!r.related_meeting_id) continue
    const list = map.get(r.related_meeting_id)
    if (list) list.push(r)
    else map.set(r.related_meeting_id, [r])
  }
  return map
}

/**
 * Group by client. A client accumulates rows from both contexts — the
 * companions picked when it was created, plus every meeting logged against it.
 */
export function tagAlongsByClient(requests: TagAlongRequest[]): Map<string, TagAlongRequest[]> {
  const map = new Map<string, TagAlongRequest[]>()
  for (const r of requests) {
    if (!r.related_client_id) continue
    const list = map.get(r.related_client_id)
    if (list) list.push(r)
    else map.set(r.related_client_id, [r])
  }
  return map
}

/** Group by the person invited — how a manager finds what is waiting on them. */
export function tagAlongsByInvitee(requests: TagAlongRequest[]): Map<string, TagAlongRequest[]> {
  const map = new Map<string, TagAlongRequest[]>()
  for (const r of requests) {
    const list = map.get(r.invitee_id)
    if (list) list.push(r)
    else map.set(r.invitee_id, [r])
  }
  return map
}

/**
 * Where a meeting stands on its manager gate, from that meeting's own requests.
 *
 * Declined outranks pending because a decline is terminal: mobile's
 * `shouldMeetingBecomeValid` clears a meeting only when nothing is pending AND
 * nothing is declined, so one decline holds it out of the quota permanently
 * even after the other invitees answer. Reporting such a meeting as "pending"
 * would imply it may still resolve. It will not.
 *
 * Cancelled rows are ignored — the requester withdrew before anyone answered,
 * which leaves no gate behind.
 */
export function managerGate(requests: TagAlongRequest[]): ManagerGate {
  const managers = requests.filter(r => r.invitee_kind === 'manager')
  if (managers.some(r => r.status === 'declined')) return 'declined'
  if (managers.some(r => r.status === 'pending')) return 'pending'
  if (managers.some(r => r.status === 'accepted')) return 'accepted'
  return 'none'
}

/** Companion names for a record, kind-tagged. Reads left to right in a cell. */
export function companionSummary(requests: TagAlongRequest[]): string {
  return requests
    .filter(r => r.status !== 'cancelled')
    .map(r => `${r.invitee_name ?? 'Unknown'} (${INVITEE_KIND_LABEL[r.invitee_kind]}, ${TAG_ALONG_STATUS_LABEL[r.status].toLowerCase()})`)
    .join('; ')
}

/**
 * Distinct people who tagged along, names only.
 *
 * Deduplicated, because a client-level list spans every meeting on the account:
 * a manager who joined six visits is one participant, not six. Names without
 * capacity or answer, for a column read alongside `companionSummary` rather
 * than instead of it.
 */
export function companionParticipants(requests: TagAlongRequest[]): string {
  const names = new Set(
    requests.filter(r => r.status !== 'cancelled').map(r => r.invitee_name ?? 'Unknown')
  )
  return Array.from(names).join('; ')
}

/**
 * Requests still waiting on an answer, oldest first.
 *
 * Oldest first because the list exists to be chased, and the one that has sat
 * longest is the one to chase. Manager-kind only: a teammate who never replied
 * blocks nothing, so including them would pad a queue meant to be actionable.
 */
export function pendingManagerRequests(requests: TagAlongRequest[]): TagAlongRequest[] {
  return requests
    .filter(r => r.invitee_kind === 'manager' && r.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** Whole days a request has been unanswered, for "waiting 9 days". */
export function daysWaiting(request: TagAlongRequest, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(request.created_at).getTime()
  return Math.max(0, Math.floor(ms / 86_400_000))
}

/**
 * Counts for a set of requests, split by the distinction that matters.
 *
 * `managerPending` and `managerDeclined` are the two that carry consequences;
 * the rest are context. Cancelled rows are excluded from every figure — the
 * request was withdrawn, so counting it anywhere would inflate the activity.
 */
export function tagAlongTotals(requests: TagAlongRequest[]) {
  const live = requests.filter(r => r.status !== 'cancelled')
  const managers = live.filter(r => r.invitee_kind === 'manager')
  return {
    total: live.length,
    manager: managers.length,
    teammate: live.length - managers.length,
    managerPending: managers.filter(r => r.status === 'pending').length,
    managerAccepted: managers.filter(r => r.status === 'accepted').length,
    managerDeclined: managers.filter(r => r.status === 'declined').length,
  }
}
