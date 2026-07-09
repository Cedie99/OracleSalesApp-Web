import type { Client, ClientStatus, CustomerType } from '@/types'

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
