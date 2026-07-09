'use client'

import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Client } from '@/types'
import { getMapStatus, STATUS_META, TILE_LAYERS, type MapTileType } from '@/components/maps/map-constants'

const PIN_PATH =
  'M172.268 501.67C26.97 291.031 0 269.413 0 192 0 85.961 85.961 0 192 0s192 85.961 192 192c0 77.413-26.97 99.031-172.268 309.67-9.535 13.774-29.93 13.773-39.464 0zM192 272c44.183 0 80-35.817 80-80s-35.817-80-80-80-80 35.817-80 80 35.817 80 80 80z'

function createPinIcon(color: string, active: boolean) {
  const width = active ? 34 : 26
  const height = Math.round(width * (512 / 384))
  const glow = active ? ` drop-shadow(0 0 5px ${color})` : ''
  return L.divIcon({
    className: '',
    html: `<div style="width:${width}px;height:${height}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5))${glow};">
      <svg width="${width}" height="${height}" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg">
        <path fill="${color}" stroke="#fff" stroke-width="8" fill-rule="evenodd" d="${PIN_PATH}"/>
      </svg>
    </div>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height + 6],
  })
}

function FlyToSelected({ client }: { client: Client | null }) {
  const map = useMap()
  useEffect(() => {
    if (client?.office_lat != null && client?.office_lng != null) {
      map.flyTo([client.office_lat, client.office_lng], 14, { duration: 0.6 })
    }
  }, [client, map])
  return null
}

interface ClientMapProps {
  clients: Client[]
  selectedId: string | null
  onSelect: (id: string) => void
  mapType: MapTileType
}

export default function ClientMap({ clients, selectedId, onSelect, mapType }: ClientMapProps) {
  const plottable = clients.filter(c => c.office_lat != null && c.office_lng != null)
  const selected = plottable.find(c => c.id === selectedId) ?? null
  const tile = TILE_LAYERS[mapType]

  return (
    <MapContainer
      center={[14.55, 121.0]}
      zoom={10}
      scrollWheelZoom
      zoomControl={false}
      style={{ height: '100%', width: '100%' }}
    >
      <ZoomControl position="bottomright" />
      <TileLayer
        key={mapType}
        attribution={tile.attribution}
        url={tile.url}
        maxZoom={tile.maxZoom}
      />
      {mapType === 'satellite' && (
        <TileLayer
          url={TILE_LAYERS.satellite.labelsUrl}
          attribution={TILE_LAYERS.satellite.attribution}
          maxZoom={TILE_LAYERS.satellite.maxZoom}
        />
      )}
      {plottable.map(client => {
        const status = getMapStatus(client)
        return (
          <Marker
            key={client.id}
            position={[client.office_lat!, client.office_lng!]}
            icon={createPinIcon(STATUS_META[status].color, client.id === selectedId)}
            eventHandlers={{ click: () => onSelect(client.id) }}
          >
            <Popup>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <strong>{client.company_name}</strong>
                <br />
                {client.office_address}
                <br />
                Agent: {client.agent?.full_name ?? 'Unassigned'}
              </div>
            </Popup>
          </Marker>
        )
      })}
      <FlyToSelected client={selected} />
    </MapContainer>
  )
}
