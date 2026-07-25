import type { Client, ClientStatus, CustomerType, Meeting, MeetingOutcome, MeetingType } from '@/types'

export type MapStatus = CustomerType | Extract<ClientStatus, 'lost'>

export const STATUS_META: Record<MapStatus, { label: string; color: string }> = {
  existing: { label: 'Existing', color: '#60a5fa' },
  new: { label: 'New', color: '#fbbf24' },
  prospect: { label: 'Prospect', color: '#c084fc' },
  lost: { label: 'Lost Opportunity', color: '#f87171' },
}

export function getMapStatus(client: Client): MapStatus {
  if (client.status === 'lost') return 'lost'
  return client.customer_type
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
 * How each meeting mode reads on the meetings-tracking map. A meeting only earns
 * a pin when it was captured face-to-face WITH GPS; online meetings are recorded
 * from wherever the agent dialled in, so they carry no location and stay in the
 * list rather than on the map.
 */
export const MEETING_TYPE_META: Record<
  MeetingType,
  { label: string; plottable: boolean }
> = {
  f2f: { label: 'Face-to-face', plottable: true },
  online: { label: 'Online', plottable: false },
}

/** A meeting we can drop a pin for: face-to-face and carrying real coordinates. */
export function isPlottableMeeting(m: Meeting): boolean {
  return m.meeting_type === 'f2f' && m.gps_lat != null && m.gps_lng != null
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
