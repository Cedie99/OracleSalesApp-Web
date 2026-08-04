'use client'

import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Popup, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { ExternalLink } from 'lucide-react'
import { TILE_LAYERS, type MapTileType } from '@/components/maps/map-constants'
import { InvalidateOnResize } from '@/components/maps/invalidate-on-resize'

const PIN_PATH =
  'M172.268 501.67C26.97 291.031 0 269.413 0 192 0 85.961 85.961 0 192 0s192 85.961 192 192c0 77.413-26.97 99.031-172.268 309.67-9.535 13.774-29.93 13.773-39.464 0zM192 272c44.183 0 80-35.817 80-80s-35.817-80-80-80-80 35.817-80 80 35.817 80 80 80z'

function createPinIcon(
  color: string,
  active: boolean,
  avatarUrl?: string | null,
  badge?: string | number | null,
  badgeColor?: string | null
) {
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
  // Order badge for trip stops — the driver's/collector's own sequence number,
  // so a route reads 1-2-3 without needing arrowheads on the line. Sits clear of
  // the pin head so it never covers the face.
  //
  // The two colours carry different facts on purpose: the PIN is the worker
  // (every stop on one run is one colour, which is what makes a route legible at
  // a glance), and the BADGE is how that stop ended. Without the split, a failed
  // stop would either vanish into its run's colour or make two drivers'
  // failures indistinguishable.
  const badgeSize = active ? 17 : 15
  const order =
    badge != null
      ? `<span style="position:absolute;top:-2px;right:-3px;min-width:${badgeSize}px;height:${badgeSize}px;padding:0 3px;border-radius:9999px;background:${badgeColor ?? '#0f172a'};color:${badgeColor ? '#0f172a' : '#fff'};border:1.5px solid ${color};font-size:${badgeSize - 6}px;font-weight:700;line-height:${badgeSize - 3}px;text-align:center;box-sizing:border-box;">${badge}</span>`
      : ''
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${width}px;height:${height}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5))${glow};">
      <svg width="${width}" height="${height}" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg">
        <path fill="${color}" stroke="#fff" stroke-width="8" fill-rule="evenodd" d="${PIN_PATH}"/>
      </svg>${avatar}${order}
    </div>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height + 6],
  })
}

// A soft pulsing ring used to call out a one-off location the user asked to see:
// the pin of a stop they clicked in the history, or a raw lat/lng search.
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
    // Last line of defence, not a data check: Leaflet THROWS on a non-finite
    // pair ("Invalid LatLng object: (NaN, NaN)"), and because this runs in an
    // effect the throw escapes to the error boundary and blanks the entire
    // page — losing the map, the list and the panel over one bad number.
    // Callers already gate on isPlottableMeeting/parseLatLng, so reaching this
    // means bad data upstream; staying put is the recoverable answer.
    if (!Number.isFinite(focus.lat) || !Number.isFinite(focus.lng)) return
    map.flyTo([focus.lat, focus.lng], focus.zoom ?? 15, { duration: 0.6 })
  }, [focus, map])
  return null
}

/**
 * Frames the current pins whenever the *set* of pins changes (i.e. filters
 * changed) — not on selection, which only flips a pin's active flag and is
 * handled by FlyTo. Keyed on the sorted id list so re-selecting doesn't refit.
 *
 * Fitting pins alone is enough even with trips on screen: a trip line is drawn
 * through the very stops that produced those pins, so it can never fall outside
 * their bounds.
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
  /**
   * Extra popup lines under the sublabel, rendered muted and one per line.
   *
   * Exists because a pin's caption is several separate facts — when the record
   * was captured, where the coordinates actually resolve to, what the worker
   * tagged it as — and folding them into one dot-separated sentence made the
   * popup read as a single ambiguous statement. Empty/undefined entries are
   * dropped, so callers can build the list conditionally without filtering.
   */
  meta?: (string | null | undefined)[]
  avatarUrl?: string | null
  /** Position in a trip, drawn as a small numbered bubble on the pin. */
  badge?: string | number | null
  /** Fills the badge to show how the stop ended. Defaults to a neutral dark. */
  badgeColor?: string | null
}

/**
 * One worker's route through one day — a collector's stores or a driver's stops,
 * in the order they actually worked them.
 *
 * Sales has no equivalent and passes none: a client's pin marks their most
 * recent visit, and stringing one agent's meetings together would draw a line
 * between accounts that were never a route. Trips only mean something where the
 * day IS a run.
 */
export interface TripPath {
  id: string
  /** The worker's colour — pins on this trip carry the same one. */
  color: string
  /** Stop coordinates, already ordered. Fewer than 2 draws nothing. */
  points: { lat: number; lng: number }[]
  /** Dimmed and thinner, for trips other than the selected one. */
  muted?: boolean
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
  /** Muted lines under the label — same purpose as `MapPin.meta`. */
  meta?: (string | null | undefined)[]
  /** For kind 'meeting': status colour + agent face so it matches the status pins. */
  color?: string
  avatarUrl?: string | null
}

/**
 * The muted tail of a popup. Inline styles rather than Tailwind because Leaflet
 * renders popups into its own DOM subtree with its own reset, where the app's
 * type scale doesn't reach.
 */
function PopupMeta({ meta }: { meta?: (string | null | undefined)[] }) {
  const lines = (meta ?? []).filter((line): line is string => !!line)
  if (lines.length === 0) return null
  return (
    <div style={{ marginTop: 2, opacity: 0.75 }}>
      {/* Index keys: these are plain caption lines in a fixed order, and two of
          them can legitimately read the same. */}
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  )
}

/**
 * "Open in Google Maps" for the coordinate a popup is describing.
 *
 * Built here from the marker's own position rather than passed in, so every pin
 * on every lens gets it for free and no caller can supply a link that points
 * somewhere other than its pin.
 *
 * It lives on the popup — not in the detail panel, where it used to sit next to
 * a place name. The panel names the CLIENT; a coordinate you can open on the
 * ground belongs to the marker standing on it, which is also where a user
 * already is when they want it.
 */
function PopupMapsLink({ lat, lng }: { lat: number; lng: number }) {
  return (
    <a
      href={`https://www.google.com/maps?q=${lat},${lng}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 6,
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--primary, #059669)',
        textDecoration: 'none',
      }}
    >
      Open in Google Maps
      <ExternalLink style={{ width: 11, height: 11 }} />
    </a>
  )
}

interface FieldMapProps {
  pins: MapPin[]
  onSelect: (id: string) => void
  mapType: MapTileType
  focus: FocusTarget | null
  highlight: HighlightMarker | null
  /** Routes to draw under the pins. Omit for lenses that have no notion of a run. */
  trips?: TripPath[]
}

/**
 * The shared field map, used by all three admin lenses.
 *
 * A pin is one located record, coloured by whatever the lens cares about:
 *
 *  - **Sales** — a CLIENT at the GPS of their most recent located visit. The
 *    coordinates are where the AGENT stood, which for an online meeting is not
 *    the client's premises, so don't reuse them as a client's address (see the
 *    note on `Client.office_lat` in types/index.ts).
 *  - **Collection** — a STORE at the fix taken when the collector photographed
 *    the payment.
 *  - **Delivery** — a STOP at the fix taken with the proof or backload photo
 *    (added 2026-07-27; see the GPS-reversal note on PurchaseOrder).
 *
 * The last two also pass `trips`, which connect one worker's stops in the order
 * they were worked — that is the "trace the trip" the office asked for.
 * `highlight` marks a single spot the user drilled into; `focus` drives the
 * camera.
 */
export default function FieldMap({
  pins,
  onSelect,
  mapType,
  focus,
  highlight,
  trips = [],
}: FieldMapProps) {
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
      // from the filter toolbar (which sit at z-50). Because the panes are
      // trapped, the page's map overlays only need z-10 to clear the map — and
      // staying under 50 keeps them below those same dropdowns.
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

      {/* Routes render before the markers so pins always sit on top of the line. */}
      {trips
        .filter(trip => trip.points.length > 1)
        .map(trip => (
          <Polyline
            key={trip.id}
            positions={trip.points.map(p => [p.lat, p.lng] as [number, number])}
            pathOptions={{
              color: trip.color,
              weight: trip.muted ? 2 : 3.5,
              opacity: trip.muted ? 0.35 : 0.85,
              // Dashes read as "the path between stops is inferred" — we know
              // where the truck stopped, never which roads it took between them.
              dashArray: '6 8',
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        ))}

      {pins.map(pin => (
        <Marker
          key={pin.id}
          position={[pin.lat, pin.lng]}
          icon={createPinIcon(pin.color, pin.active, pin.avatarUrl, pin.badge, pin.badgeColor)}
          eventHandlers={{ click: () => onSelect(pin.id) }}
          zIndexOffset={pin.active ? 1000 : 0}
        >
          <Popup>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
              <strong>{pin.label}</strong>
              {pin.sublabel && <div>{pin.sublabel}</div>}
              <PopupMeta meta={pin.meta} />
              <PopupMapsLink lat={pin.lat} lng={pin.lng} />
            </div>
          </Popup>
        </Marker>
      ))}
      {highlight && (
        <Marker
          position={[highlight.lat, highlight.lng]}
          // A located record reads as the same avatar pin as the status markers
          // (rendered active so it stands out); a raw lat/lng search — which has
          // no client or worker — keeps the simple pulsing dot.
          icon={
            highlight.kind === 'meeting'
              ? createPinIcon(highlight.color ?? '#0ea5e9', true, highlight.avatarUrl)
              : createHighlightIcon('search')
          }
          zIndexOffset={2000}
        >
          {highlight.label && (
            <Popup>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <strong>{highlight.label}</strong>
                <PopupMeta meta={highlight.meta} />
                <PopupMapsLink lat={highlight.lat} lng={highlight.lng} />
              </div>
            </Popup>
          )}
        </Marker>
      )}
      <InvalidateOnResize />
      <FitToPins pins={pins} />
      <FlyTo focus={focus} />
    </MapContainer>
  )
}
