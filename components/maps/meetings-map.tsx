'use client'

import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { TILE_LAYERS, type MapTileType } from '@/components/maps/map-constants'

const PIN_PATH =
  'M172.268 501.67C26.97 291.031 0 269.413 0 192 0 85.961 85.961 0 192 0s192 85.961 192 192c0 77.413-26.97 99.031-172.268 309.67-9.535 13.774-29.93 13.773-39.464 0zM192 272c44.183 0 80-35.817 80-80s-35.817-80-80-80-80 35.817-80 80 35.817 80 80 80z'

function createPinIcon(color: string, active: boolean, avatarUrl?: string | null) {
  const width = active ? 38 : 30
  const height = Math.round(width * (512 / 384))
  const glow = active ? ` drop-shadow(0 0 5px ${color})` : ''
  // Agent face inside the pin head: the head is a circle centered at (192,192)
  // in the 384x512 viewBox; a 280/384-wide photo covers the white cutout while
  // leaving the status-colored ring visible around it.
  const face = Math.round((280 / 384) * width)
  const faceTop = Math.round((192 / 512) * height - face / 2)
  const avatar = avatarUrl
    ? `<img src="${avatarUrl}" alt="" style="position:absolute;top:${faceTop}px;left:${(width - face) / 2}px;width:${face}px;height:${face}px;border-radius:9999px;object-fit:cover;" onerror="this.remove()"/>`
    : ''
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${width}px;height:${height}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5))${glow};">
      <svg width="${width}" height="${height}" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg">
        <path fill="${color}" stroke="#fff" stroke-width="8" fill-rule="evenodd" d="${PIN_PATH}"/>
      </svg>${avatar}
    </div>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height + 6],
  })
}

// A soft pulsing ring used to call out a one-off location the user asked to see:
// the pin of a meeting they clicked in the history, or a raw lat/lng search.
function createHighlightIcon(kind: 'meeting' | 'search') {
  const color = kind === 'search' ? '#10b981' : '#0ea5e9'
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:26px;height:26px;">
      <span style="position:absolute;inset:0;border-radius:9999px;background:${color};opacity:0.25;animation:mm-pulse 1.6s ease-out infinite;"></span>
      <span style="position:absolute;top:7px;left:7px;width:12px;height:12px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>
    </div>
    <style>@keyframes mm-pulse{0%{transform:scale(0.6);opacity:0.45}100%{transform:scale(2.2);opacity:0}}</style>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

/** Flies the map to `focus` whenever it changes. Null leaves the view alone. */
function FlyTo({ focus }: { focus: FocusTarget | null }) {
  const map = useMap()
  useEffect(() => {
    if (!focus) return
    map.flyTo([focus.lat, focus.lng], focus.zoom ?? 15, { duration: 0.6 })
  }, [focus, map])
  return null
}

/**
 * Frames the current pins whenever the *set* of pins changes (i.e. filters
 * changed) — not on selection, which only flips a pin's active flag and is
 * handled by FlyTo. Keyed on the sorted id list so re-selecting doesn't refit.
 */
function FitToPins({ pins }: { pins: MapPin[] }) {
  const map = useMap()
  const key = pins.map(p => p.id).sort().join(',')
  useEffect(() => {
    if (pins.length === 0) return
    if (pins.length === 1) {
      map.setView([pins[0].lat, pins[0].lng], 14, { animate: true })
      return
    }
    const bounds = L.latLngBounds(pins.map(p => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 15, animate: true })
    // Intentionally keyed on `key`, not `pins` — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map])
  return null
}

export interface MapPin {
  id: string
  lat: number
  lng: number
  color: string
  active: boolean
  label: string
  sublabel?: string
  avatarUrl?: string | null
}

export interface FocusTarget {
  lat: number
  lng: number
  zoom?: number
  /** Bumped by callers to re-trigger a fly-to even when coordinates repeat. */
  nonce: number
}

export interface HighlightMarker {
  lat: number
  lng: number
  kind: 'meeting' | 'search'
  label?: string
  /** For kind 'meeting': status colour + agent face so it matches the status pins. */
  color?: string
  avatarUrl?: string | null
}

interface MeetingsMapProps {
  pins: MapPin[]
  onSelect: (id: string) => void
  mapType: MapTileType
  focus: FocusTarget | null
  highlight: HighlightMarker | null
}

/**
 * The meetings-tracking map. Unlike the old account map, a pin here is a CLIENT
 * placed at the GPS of their most recent face-to-face visit — real coordinates
 * the mobile app captures on every f2f meeting. `highlight` marks a single spot
 * the user drilled into (a clicked meeting or a lat/lng search); `focus` drives
 * the camera.
 */
export default function MeetingsMap({ pins, onSelect, mapType, focus, highlight }: MeetingsMapProps) {
  const tile = TILE_LAYERS[mapType]

  return (
    <MapContainer
      center={[14.55, 121.0]}
      zoom={10}
      scrollWheelZoom
      zoomControl={false}
      // zIndex:0 (with Leaflet's own position:relative) makes the container its
      // own stacking context, trapping Leaflet's high-z panes inside it. Without
      // this, those panes leak into the root stack and cover portaled dropdowns
      // from the filter toolbar (which sit at z-50). Page overlays are z-[1000].
      style={{ height: '100%', width: '100%', zIndex: 0 }}
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
      {pins.map(pin => (
        <Marker
          key={pin.id}
          position={[pin.lat, pin.lng]}
          icon={createPinIcon(pin.color, pin.active, pin.avatarUrl)}
          eventHandlers={{ click: () => onSelect(pin.id) }}
          zIndexOffset={pin.active ? 1000 : 0}
        >
          <Popup>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
              <strong>{pin.label}</strong>
              {pin.sublabel && (
                <>
                  <br />
                  {pin.sublabel}
                </>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
      {highlight && (
        <Marker
          position={[highlight.lat, highlight.lng]}
          // A located meeting reads as the same avatar pin as the status markers
          // (rendered active so it stands out); a raw lat/lng search — which has
          // no client or agent — keeps the simple pulsing dot.
          icon={
            highlight.kind === 'meeting'
              ? createPinIcon(highlight.color ?? '#0ea5e9', true, highlight.avatarUrl)
              : createHighlightIcon('search')
          }
          zIndexOffset={2000}
        >
          {highlight.label && (
            <Popup>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{highlight.label}</div>
            </Popup>
          )}
        </Marker>
      )}
      <FitToPins pins={pins} />
      <FlyTo focus={focus} />
    </MapContainer>
  )
}
