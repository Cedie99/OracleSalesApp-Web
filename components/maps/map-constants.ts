import type { Client, ClientStatus, CustomerType, Meeting, MeetingOutcome } from '@/types'
import { CUSTOMER_TYPE_LABEL } from '@/lib/status-styles'
import type { QuotaState } from '@/lib/cutoff'

/**
 * The map's status vocabulary is deliberately one narrower than CustomerType:
 * 'in_progress' shares the prospect pin, so there is no such key here. See
 * getMapStatus.
 */
export type MapStatus = Exclude<CustomerType, 'in_progress'> | Extract<ClientStatus, 'lost'>

/**
 * Key order is the legend and filter order — most-established stage first,
 * mirroring CUSTOMER_TYPE_TONE. Colours are the map's own palette rather than
 * the badge tones: pins sit on satellite imagery, where the badge greens and
 * navies disappear into the ground.
 */
export const STATUS_META: Record<MapStatus, { label: string; color: string }> = {
  existing: { label: 'Existing', color: '#60a5fa' },
  new: { label: 'New', color: '#fbbf24' },
  prospect: { label: 'Prospect', color: '#c084fc' },
  lost: { label: 'Lost Opportunity', color: '#f87171' },
}

/**
 * Fallback for a customer_type this build doesn't model. The database is shared
 * with the mobile repo and its lifecycle has grown twice by hand already
 * (migrations 038 and 040 added 'in_progress'), so an unrecognised value is a
 * question of when, not if. Grey and unlabelled beats a crash — which is
 * literally what the previous `STATUS_META[…].color` did on the first
 * 'in_progress' row to reach the map.
 */
const UNKNOWN_STATUS_META = { label: 'Unspecified', color: '#94a3b8' }

export function getMapStatus(client: Client): MapStatus {
  if (client.status === 'lost') return 'lost'
  // In Progress is a qualified prospect, not a peer stage — one pin colour covers
  // the whole pre-customer family, and the legend carries the subset as a
  // sub-count. Five pin colours on satellite imagery was one too many to read.
  if (client.customer_type === 'in_progress') return 'prospect'
  return client.customer_type
}

/** True where the client is a prospect that has cleared its qualifying meeting. */
export function isInProgress(client: Client): boolean {
  return client.status !== 'lost' && client.customer_type === 'in_progress'
}

/**
 * Pin colour and legend label for a client, drift-proof. Prefer this over
 * indexing STATUS_META directly.
 *
 * In Progress takes the prospect colour but keeps its name in the label, for the
 * surfaces with room to show it — the selected-client badge. The legend and the
 * list dots use the colour only, so they stay a four-colour vocabulary.
 */
export function mapStatusMeta(client: Client): { label: string; color: string } {
  const meta = STATUS_META[getMapStatus(client)] ?? UNKNOWN_STATUS_META
  return isInProgress(client) ? { ...meta, label: `${meta.label} · ${CUSTOMER_TYPE_LABEL.in_progress}` } : meta
}

/**
 * Colours for the "colour by outcome" map mode — how the *visit* went, rather
 * than what kind of client it is. A separate palette from STATUS_META on
 * purpose: the two are never shown at the same time.
 */
export const OUTCOME_META: Record<MeetingOutcome, { label: string; color: string }> = {
  successful: { label: 'Successful', color: '#34d399' },
  follow_up: { label: 'Follow-up', color: '#60a5fa' },
  no_decision: { label: 'No Decision', color: '#94a3b8' },
  lost_opportunity: { label: 'Lost', color: '#f87171' },
}

/**
 * Colours for the "visit quota" lens — how heavily an account has been worked
 * this cutoff, rather than what it is or how the visit went. A third palette
 * for the same reason OUTCOME_META is a second one: only ever shown alone.
 *
 * There is no "approaching the limit" colour, deliberately. The cap is a
 * CEILING, not a target: a client at 2 of 2 is in exactly as good a state as
 * one at 0 of 2, and nobody is in trouble for not having visited an account.
 * An amber "At limit" band said the opposite — that filling the allowance was
 * a thing to chase, and that stopping just short deserved a warning colour.
 *
 * 'exempt' borrows the prospect purple, because in practice that IS the
 * prospect bucket — uncapped is a property of the lifecycle stage, not a quota
 * outcome.
 */
export const QUOTA_META: Record<QuotaState, { label: string; color: string }> = {
  within: { label: 'Within limit', color: '#34d399' },
  over: { label: 'Over limit', color: '#f87171' },
  exempt: { label: 'Uncapped', color: '#c084fc' },
}

/**
 * A Lost Opportunity keeps its last agent on the row for history, but per the
 * handle_lost_opportunity() trigger (supabase/migrations/001_initial.sql) it
 * enters a 14-day cooldown (reassignable_at) before it's meant to be picked
 * up by a different agent. Everything else is always reserved to its agent.
 */
export function isAvailableForReassignment(client: Client): boolean {
  if (client.status !== 'lost') return false
  if (!client.reassignable_at) return true
  return new Date(client.reassignable_at) <= new Date()
}

export const TILE_LAYERS = {
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
    // Fixed low-zoom tile used as a literal thumbnail preview in the map-type picker.
    preview: 'https://a.basemaps.cartocdn.com/light_all/3/6/3.png',
  },
  standard: {
    label: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    preview: 'https://a.tile.openstreetmap.org/3/6/3.png',
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
    preview: 'https://a.basemaps.cartocdn.com/dark_all/3/6/3.png',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    preview: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/6',
    // Transparent place/road/border labels overlaid on top of the imagery, mirroring Google Maps' hybrid satellite view.
    labelsUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  },
  terrain: {
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
    preview: 'https://a.tile.opentopomap.org/3/6/3.png',
  },
} as const

export type MapTileType = keyof typeof TILE_LAYERS

/**
 * A meeting we can drop a pin for: one carrying real coordinates.
 *
 * Meeting mode is deliberately NOT part of this test. Mobile gates every save on
 * a GPS fix with no branch on mode (`app/(tabs)/meetings/record.tsx` — "GPS
 * Required") and writes it unconditionally (`lib/meeting-service.ts`), typing
 * its own `gps_lat` as a non-nullable number. Online meetings therefore DO carry
 * coordinates: wherever the agent dialled in from.
 *
 * Caveat that matters when reading the map: a pin marks where the AGENT stood,
 * which for an online meeting is not the client's premises. Do not reuse these
 * coordinates as a client's location — see the note on `Client.office_lat` in
 * types/index.ts, and the office-map boundary in the 2026-07-25 sales meeting.
 */
export function isPlottableMeeting(m: Meeting): boolean {
  return m.gps_lat != null && m.gps_lng != null
}

/**
 * Parse a Google-Maps-style coordinate entry ("14.5547, 121.0244") from the
 * search box. Returns null for anything that isn't a bare "lat, lng" pair inside
 * the valid ranges, so ordinary name/address searches fall through untouched.
 * A space-separated pair ("14.55 121.02") is accepted too, matching gmaps.
 */
export function parseLatLng(input: string): { lat: number; lng: number } | null {
  const m = input.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}
