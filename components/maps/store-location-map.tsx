'use client'

import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { TILE_LAYERS, REGISTERED_COLOR, UPDATED_COLOR } from '@/components/maps/map-constants'
import { InvalidateOnResize } from '@/components/maps/invalidate-on-resize'
import type { StorePin } from '@/lib/hooks/use-store-locations'

const PIN_PATH =
  'M172.268 501.67C26.97 291.031 0 269.413 0 192 0 85.961 85.961 0 192 0s192 85.961 192 192c0 77.413-26.97 99.031-172.268 309.67-9.535 13.774-29.93 13.773-39.464 0zM192 272c44.183 0 80-35.817 80-80s-35.817-80-80-80-80 35.817-80 80 35.817 80 80 80z'

function pinIcon(color: string): L.DivIcon {
  const width = 30
  const height = Math.round(width * (512 / 384))
  return L.divIcon({
    className: '',
    html: `<div style="width:${width}px;height:${height}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5));">
      <svg width="${width}" height="${height}" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg">
        <path fill="${color}" stroke="#fff" stroke-width="8" fill-rule="evenodd" d="${PIN_PATH}"/>
      </svg>
    </div>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height + 6],
  })
}

const REGISTERED_ICON = pinIcon(REGISTERED_COLOR)
const UPDATED_ICON = pinIcon(UPDATED_COLOR)

/** Frames both pins on mount / when either moves. */
function FitToPins({ pins }: { pins: StorePin[] }) {
  const map = useMap()
  useEffect(() => {
    if (pins.length === 0) return
    if (pins.length === 1) {
      map.setView([pins[0].lat, pins[0].lng], 15)
      return
    }
    map.fitBounds(L.latLngBounds(pins.map(p => [p.lat, p.lng] as [number, number])), {
      padding: [36, 36],
      maxZoom: 16,
    })
  }, [pins, map])
  return null
}

interface StoreLocationMapProps {
  registered: StorePin | null
  updated: StorePin | null
}

/**
 * A compact two-pin map for a single store: its registered office pin and its
 * current field-set pin. Either may be absent. Mirrors client-map.tsx's Leaflet
 * setup (tiles, InvalidateOnResize for the dialog-open animation) but plots the
 * two location kinds rather than a client list.
 */
export default function StoreLocationMap({ registered, updated }: StoreLocationMapProps) {
  const tile = TILE_LAYERS.standard
  const pins = [registered, updated].filter((p): p is StorePin => p != null)
  const center: [number, number] = pins[0] ? [pins[0].lat, pins[0].lng] : [14.55, 121.0]

  return (
    <MapContainer
      center={center}
      zoom={13}
      scrollWheelZoom
      zoomControl={false}
      style={{ height: '100%', width: '100%' }}
    >
      <ZoomControl position="bottomright" />
      <TileLayer attribution={tile.attribution} url={tile.url} maxZoom={tile.maxZoom} />
      {registered && (
        <Marker position={[registered.lat, registered.lng]} icon={REGISTERED_ICON}>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <strong>Registered location</strong>
              <br />
              Office pin set by sales / RSR
            </div>
          </Popup>
        </Marker>
      )}
      {updated && (
        <Marker position={[updated.lat, updated.lng]} icon={UPDATED_ICON}>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <strong>Updated location</strong>
              <br />
              Set on the ground by Collection / Delivery
            </div>
          </Popup>
        </Marker>
      )}
      <FitToPins pins={pins} />
      <InvalidateOnResize />
    </MapContainer>
  )
}
