'use client'

import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { TILE_LAYERS, type MapTileType } from '@/components/maps/map-constants'
import { MapTypePicker } from '@/components/maps/map-type-picker'

function pinIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.45);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

/**
 * Caps the map's zoom to whatever the active tile layer actually has data
 * for. Terrain (OpenTopoMap) tops out at 17 where Satellite/Light go to
 * 19-20 — without this, switching to Terrain after the view had zoomed
 * further left it past Terrain's own ceiling, and OpenTopoMap serves back a
 * literal "max zoom" placeholder tile instead of real terrain.
 */
function SyncMaxZoom({ maxZoom }: { maxZoom: number }) {
  const map = useMap()
  useEffect(() => {
    map.setMaxZoom(maxZoom)
  }, [map, maxZoom])
  return null
}

/** Frames whichever pins are on the map — one point centers and zooms in, two points fit both with room to spare. Never past the active layer's own maxZoom (see SyncMaxZoom). */
function FitToPoints({ points, maxZoom }: { points: [number, number][]; maxZoom: number }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 1) {
      map.setView(points[0], Math.min(16, maxZoom))
    } else if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: Math.min(18, maxZoom) })
    }
  }, [map, points, maxZoom])
  return null
}

interface RoutePoint {
  lat: number
  lng: number
  label: string
}

interface MeetingRouteMapProps {
  start: RoutePoint | null
  end: RoutePoint | null
  /** e.g. "13 m" — printed as a permanent label on the route line itself, not just in a details panel below. */
  distanceLabel?: string | null
}

/** Where a meeting was opened and closed, as pins on a map — green for start, red for end, joined by a dashed line labeled with the gap between them so it reads at a glance. */
export default function MeetingRouteMap({ start, end, distanceLabel }: MeetingRouteMapProps) {
  const [mapType, setMapType] = useState<MapTileType>('satellite')
  const points: [number, number][] = []
  if (start) points.push([start.lat, start.lng])
  if (end) points.push([end.lat, end.lng])
  if (points.length === 0) return null
  const tile = TILE_LAYERS[mapType]

  return (
    <div className="relative w-full h-full">
      <MapContainer center={points[0]} zoom={Math.min(16, tile.maxZoom)} maxZoom={tile.maxZoom} className="w-full h-full" zoomControl={true} attributionControl={false}>
        <TileLayer url={tile.url} maxZoom={tile.maxZoom} />
        <SyncMaxZoom maxZoom={tile.maxZoom} />
        <FitToPoints points={points} maxZoom={tile.maxZoom} />
        {start && end && (
          <Polyline
            positions={[[start.lat, start.lng], [end.lat, end.lng]]}
            pathOptions={{ color: '#16a34a', weight: 3, dashArray: '6 6' }}
          >
            {distanceLabel && (
              <Tooltip permanent direction="right" offset={[6, 0]} opacity={1} className="!bg-white !text-black !border-none !shadow-md !font-bold !text-xs !px-2 !py-1 !rounded-md">
                {distanceLabel}
              </Tooltip>
            )}
          </Polyline>
        )}
        {start && (
          <Marker position={[start.lat, start.lng]} icon={pinIcon('#16a34a')}>
            <Popup>{start.label}</Popup>
          </Marker>
        )}
        {end && (
          <Marker position={[end.lat, end.lng]} icon={pinIcon('#dc2626')}>
            <Popup>{end.label}</Popup>
          </Marker>
        )}
      </MapContainer>
      <MapTypePicker mapType={mapType} onChange={setMapType} className="bottom-3 left-3" />
    </div>
  )
}
