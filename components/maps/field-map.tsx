'use client'

import { Fragment, useEffect } from 'react'
import {
  Circle, MapContainer, Polygon, Polyline, Popup, Marker, TileLayer, ZoomControl, useMap,
} from 'react-leaflet'
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
  badgeColor?: string | null,
  /**
   * Pushed into the background because the user is inspecting one record.
   *
   * Faded rather than removed: the surrounding pins are the context that makes
   * a location mean something ("this stop is in the middle of the day's other
   * work"), and pulling them off the map to focus on one of them throws that
   * away. They stay clickable at this opacity, so the way out of a drill-down
   * is still to click whatever you want next.
   */
  dimmed?: boolean
) {
  const width = active ? 38 : 30
  const height = Math.round(width * (512 / 384))
  const glow = active && !dimmed ? ` drop-shadow(0 0 5px ${color})` : ''
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
    html: `<div style="position:relative;width:${width}px;height:${height}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5))${glow};${dimmed ? 'opacity:0.3;' : ''}">
      <svg width="${width}" height="${height}" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg">
        <path fill="${color}" stroke="#fff" stroke-width="8" fill-rule="evenodd" d="${PIN_PATH}"/>
      </svg>${avatar}${order}
    </div>`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height + 6],
  })
}

/**
 * Where a meeting was CLOSED, as a small hollow ring.
 *
 * Deliberately not a second teardrop pin: a pin is one located record, and the
 * end fix is not a record of its own — it is the far end of one meeting. A ring
 * reads as a mark on the same thing rather than another thing, which is what
 * stops "one meeting" from looking like "two meetings" on the map.
 *
 * Small on purpose too. The pair is usually metres apart (the agent stayed put),
 * so at any useful zoom this sits under the start pin's tip and has to peek out
 * from behind it rather than swallow it.
 */
function createEndFixIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:9999px;background:#fff;border:4px solid ${color};box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,0.45);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
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
    const finite = (p: { lat: number; lng: number }) =>
      Number.isFinite(p.lat) && Number.isFinite(p.lng)

    // Last line of defence, not a data check: Leaflet THROWS on a non-finite
    // pair ("Invalid LatLng object: (NaN, NaN)"), and because this runs in an
    // effect the throw escapes to the error boundary and blanks the entire
    // page — losing the map, the list and the panel over one bad number.
    // Callers already gate on isPlottableMeeting/parseLatLng, so reaching this
    // means bad data upstream; staying put is the recoverable answer.
    if (!finite(focus)) return

    // Several points to show at once (a meeting's start and end fixes): frame
    // them instead of flying to one, or the other falls off screen the moment
    // the two are far enough apart to be worth looking at. maxZoom keeps the
    // usual case — a pair metres apart, where the bounds are nearly a point —
    // from zooming to the tile ceiling.
    const fit = (focus.fitTo ?? []).filter(finite)
    if (fit.length > 1) {
      map.flyToBounds(L.latLngBounds(fit.map(p => [p.lat, p.lng] as [number, number])), {
        paddingTopLeft: focus.padTopLeft ?? [80, 80],
        paddingBottomRight: focus.padBottomRight ?? [80, 80],
        maxZoom: focus.zoom ?? 16,
        duration: 0.6,
      })
      return
    }
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
function FitToPins({ pins, areas }: { pins: MapPin[]; areas: MapArea[] }) {
  const map = useMap()
  const key = [...pins.map(p => p.id), ...areas.map(a => `~${a.id}`)].sort().join(',')
  useEffect(() => {
    // Areas are framed alongside pins, not instead of them: the not-worked lens
    // can show a mix — the stores with a real pin, and a circle for the towns
    // holding the ones without — and framing only the pins would push those
    // circles off screen, hiding exactly the records that have least known
    // about them.
    const bounds = L.latLngBounds([])
    for (const pin of pins) bounds.extend([pin.lat, pin.lng])
    for (const area of areas) {
      // The drawn shape's own extent, so the camera frames what is on screen:
      // an outline's bounds are the boundary itself, and only a fallback circle
      // is framed by its radius.
      if (area.outline) {
        for (const ring of area.outline) for (const point of ring) bounds.extend(point)
      } else {
        bounds.extend(L.latLng(area.lat, area.lng).toBounds(area.radiusMeters * 2))
      }
    }
    if (!bounds.isValid()) return

    // One point and nothing around it has no extent to fit, so fitBounds would
    // run to the tile ceiling. A circle always has extent, so it never lands here.
    if (pins.length === 1 && areas.length === 0) {
      map.setView([pins[0].lat, pins[0].lng], 14, { animate: true })
      return
    }
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 15, animate: true })
    // Intentionally keyed on `key`, not `pins`/`areas` — see the note above.
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
  /** Faded into the background while the user is drilled into one record. */
  dimmed?: boolean
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

/**
 * A place a record is known to be INSIDE, drawn as a shape rather than a pin.
 *
 * The distinction a pin cannot make: a pin says "the store is HERE", and putting
 * one at a town's centre because a town is all the record carries is a lie with
 * four decimal places on it. An outline says "somewhere in Quezon City", which
 * is the truth about a store that has a `city` and no coordinate — see the
 * not-worked lens in trip-map-view.tsx, and `app/api/geocode/city/route.ts` for
 * where the shape comes from.
 *
 * Drawn under everything else and kept deliberately faint: it is the backdrop a
 * real pin is read against, never a thing competing with one for attention.
 */
export interface MapArea {
  id: string
  /** Centre, used for the circle fallback and to frame the camera. */
  lat: number
  lng: number
  /** The circle's size, used ONLY when `outline` is absent. */
  radiusMeters: number
  /**
   * The real municipal boundary, as one `[lat, lng]` ring per part. When present
   * this is what is drawn; a circle is the cruder fallback for towns OSM has no
   * shape for, and the difference in how they read is deliberate.
   */
  outline?: [number, number][][]
  color: string
  /** Place name, e.g. "Quezon City, Metro Manila". */
  label: string
  /** Shown on the area's own marker, e.g. how many records sit in it. */
  badge?: string | number | null
  /** Popup lines under the label — same purpose as `MapPin.meta`. */
  meta?: (string | null | undefined)[]
}

/**
 * The area's marker: a flat name chip at its centre, NOT a teardrop pin.
 *
 * The shape is the whole message. A teardrop means "the thing is exactly at the
 * point I am standing on", which is the one claim an area explicitly cannot
 * make — so reusing it here would undo the reason the outline exists. A label
 * lying flat on the map reads the way a place name reads on any atlas: it names
 * the region under it rather than marking a spot inside it.
 *
 * Centre-anchored for the same reason. A pin's tip is meaningful and its anchor
 * sits at the bottom; this has no tip, so it is centred on the centroid and the
 * eye takes it as the whole shape's caption.
 */
function createAreaLabelIcon(color: string, label: string, badge?: string | number | null) {
  const count =
    badge != null
      ? `<span style="background:${color};color:#0f172a;border-radius:9999px;padding:0 5px;font-weight:700;margin-left:5px;">${badge}</span>`
      : ''
  return L.divIcon({
    className: '',
    html: `<div style="display:inline-flex;align-items:center;white-space:nowrap;transform:translate(-50%,-50%);padding:2px 4px 2px 8px;border-radius:9999px;background:rgba(15,23,42,0.82);border:1.5px solid ${color};color:#fff;font-size:11px;font-weight:600;line-height:17px;box-shadow:0 1px 4px rgba(0,0,0,0.45);">${label}${count}</div>`,
    // Sized 0x0 with the chip translated by -50%: the label is variable-width
    // and Leaflet needs a fixed iconSize to anchor from, so the anchoring is
    // done in CSS where the real width is known.
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -12],
  })
}

/**
 * Shared by both shapes, so an outline and a fallback circle read as one thing.
 *
 * Weighted to survive the basemap rather than to be tasteful in isolation: the
 * standard tiles are a dense field of grey and pink roads, and the first pass at
 * this (1.5px, 70% opacity, 8% fill) was in the DOM and invisible on screen. A
 * boundary nobody can see is the same as no boundary.
 */
function areaPathOptions(color: string) {
  return {
    color,
    weight: 3,
    opacity: 0.95,
    fillColor: color,
    // Enough to tint the towns apart from their surroundings, low enough to read
    // the roads and the basemap's own labels straight through.
    fillOpacity: 0.15,
    // Dashed because the claim is "somewhere inside this", not "on this line" —
    // and for the circle, because its boundary is an approximation of an
    // approximation.
    dashArray: '8 6',
  }
}

export interface FocusTarget {
  lat: number
  lng: number
  zoom?: number
  /**
   * Points that must all be in frame. When two or more are given the camera
   * fits them and `zoom` becomes the CEILING rather than the target; `lat`/`lng`
   * stay the fallback for one point or none.
   */
  fitTo?: { lat: number; lng: number }[]
  /**
   * Room to leave around `fitTo`, as Leaflet [x, y] pixel pairs.
   *
   * Split into two corners rather than one symmetric value because every lens
   * that fits a pair of points does it FROM a detail panel pinned over the
   * right-hand side of the map — so even padding centres the pair underneath
   * that panel, technically in frame and entirely invisible. Callers with no
   * overlay can omit both and get an even margin.
   */
  padTopLeft?: [number, number]
  padBottomRight?: [number, number]
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
  /**
   * Where the meeting was closed, when mobile captured a second fix.
   *
   * The marker above is the START — the fix every other surface in the app plots
   * and the one the pin stands on. This is drawn as a ring joined to it by a
   * line, so the two read as one meeting seen from both ends. That comparison is
   * the whole reason the end fix exists (ADR-019 dropped the start photo because
   * the admin validates a meeting by looking at start against end here).
   *
   * Absent on most meetings — the capture pair postdates them.
   */
  end?: {
    lat: number
    lng: number
    label?: string
    meta?: (string | null | undefined)[]
  }
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
  /** Approximate areas, drawn beneath everything. See `MapArea`. */
  areas?: MapArea[]
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
  areas = [],
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

      {/* Areas first of all: they are the backdrop. Markers live in Leaflet's
          own higher pane, so a pin inside one stays clickable through it, and
          the fill is faint enough to read the basemap through. */}
      {areas.map(area => {
        const popup = (
          <Popup>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
              <strong>{area.label}</strong>
              <PopupMeta meta={area.meta} />
            </div>
          </Popup>
        )
        return (
          <Fragment key={area.id}>
            {area.outline ? (
              // `positions` takes the array of rings directly, which is what
              // draws a municipality split across several islands as several
              // shapes under one identity rather than as one ring zig-zagging
              // between them.
              <Polygon positions={area.outline} pathOptions={areaPathOptions(area.color)}>
                {popup}
              </Polygon>
            ) : (
              <Circle
                center={[area.lat, area.lng]}
                radius={area.radiusMeters}
                pathOptions={areaPathOptions(area.color)}
              >
                {popup}
              </Circle>
            )}
            {/* The name chip. Given the LOWEST zIndex offset of anything on the
                map so a real pin standing on the same spot always wins — the
                area is context, and context must never cover the thing it is
                context for. */}
            <Marker
              position={[area.lat, area.lng]}
              icon={createAreaLabelIcon(area.color, area.label, area.badge)}
              zIndexOffset={-1000}
            >
              {popup}
            </Marker>
          </Fragment>
        )
      })}

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
          icon={createPinIcon(
            pin.color,
            pin.active,
            pin.avatarUrl,
            pin.badge,
            pin.badgeColor,
            pin.dimmed
          )}
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
      {/* The start-to-end connector, under both markers. Dotted and thin so it
          reads as "these two dots are one meeting" rather than as a route — a
          trip line (above, dashed and heavier) means a worker's ordered run,
          and this is emphatically not that. */}
      {highlight?.end && (
        <Polyline
          positions={[
            [highlight.lat, highlight.lng],
            [highlight.end.lat, highlight.end.lng],
          ]}
          pathOptions={{
            color: highlight.color ?? '#0ea5e9',
            weight: 2,
            opacity: 0.9,
            dashArray: '2 6',
            lineCap: 'round',
          }}
        />
      )}
      {highlight?.end && (
        <Marker
          position={[highlight.end.lat, highlight.end.lng]}
          icon={createEndFixIcon(highlight.color ?? '#0ea5e9')}
          // Under the start pin: when the two fixes are metres apart they land on
          // top of each other, and the pin carrying the agent's face is the one
          // that should win.
          zIndexOffset={1900}
        >
          <Popup>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
              <strong>{highlight.end.label ?? 'Meeting ended here'}</strong>
              <PopupMeta meta={highlight.end.meta} />
              <PopupMapsLink lat={highlight.end.lat} lng={highlight.end.lng} />
            </div>
          </Popup>
        </Marker>
      )}
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
      <FitToPins pins={pins} areas={areas} />
      <FlyTo focus={focus} />
    </MapContainer>
  )
}
