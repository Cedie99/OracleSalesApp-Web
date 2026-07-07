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
  },
  standard: {
    label: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
  terrain: {
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
} as const

export type MapTileType = keyof typeof TILE_LAYERS
