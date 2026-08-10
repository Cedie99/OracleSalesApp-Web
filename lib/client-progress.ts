import type { Meeting } from '@/types'

// Single source of truth for "client progress" everywhere on web — the card
// ring on the Clients list and the big ring in the client detail dialog both
// call this, so the same client always shows the same number in both places.
//
// Mirrors the mobile app's MEETING_AGENDAS (types/index.ts) — the 6 topics
// (every entry except the terminal "Close deal") whose coverage across a
// client's recorded meetings drives mobile's My Clients "Qualified agenda
// progress" meter and "{completed}/6 agenda milestones" copy. Ported here so
// web shows the same number mobile does for the same client.
const QUALIFIED_AGENDA_MILESTONES = [
  'New business opportunity',
  'Product / company presentation',
  'Price negotiation / quotation',
  'Terms & limit negotiation',
  'Relationship building',
  'Technical support',
] as const

export interface QualifiedAgendaMilestones {
  completed: number
  total: number
  percent: number
}

export function getQualifiedAgendaMilestones(clientId: string, meetings: Meeting[]): QualifiedAgendaMilestones {
  const covered = new Set<string>()
  meetings.forEach(m => {
    if (m.client_id !== clientId) return
    ;(m.agenda ?? []).forEach(a => covered.add(a))
  })
  const completed = QUALIFIED_AGENDA_MILESTONES.filter(a => covered.has(a)).length
  const total = QUALIFIED_AGENDA_MILESTONES.length
  return { completed, total, percent: Math.round((completed / total) * 100) }
}
