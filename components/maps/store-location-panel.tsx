'use client'

import dynamic from 'next/dynamic'
import { format } from 'date-fns'
import { Building2, Navigation, ExternalLink, MapPinOff, ArrowRight } from 'lucide-react'
import {
  useStoreLocations,
  metresBetween,
  type StoreLocation,
} from '@/lib/hooks/use-store-locations'
import { officePinSourceLabel } from '@/lib/client-info'
import { REGISTERED_COLOR, UPDATED_COLOR } from '@/components/maps/map-constants'

const StoreLocationMap = dynamic(() => import('@/components/maps/store-location-map'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-muted animate-pulse" />,
})

function mapsHref(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

function coords(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
}

/** "moved ~1.2 km" / "moved ~340 m" when the two pins differ meaningfully. */
function movedLabel(loc: StoreLocation): string | null {
  if (!loc.registered || !loc.updated) return null
  const m = metresBetween(loc.registered, loc.updated)
  if (m < 25) return null // within GPS noise — not a real relocation
  return m >= 1000 ? `moved ~${(m / 1000).toFixed(1)} km` : `moved ~${Math.round(m)} m`
}

interface LocationRowProps {
  color: string
  title: string
  subtitle: string
  lat: number
  lng: number
}

function LocationRow({ color, title, subtitle, lat, lng }: LocationRowProps) {
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-0.5 w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-background"
        style={{ backgroundColor: color }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Navigation className="w-3 h-3 shrink-0" />
          <span className="font-mono">{coords(lat, lng)}</span>
          <a
            href={mapsHref(lat, lng)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            View on map
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  )
}

interface StoreLocationPanelProps {
  /** The store's client id. The panel self-fetches both locations for it. */
  clientId: string | null | undefined
  /** Hide the embedded mini-map (e.g. very tight surfaces) — rows still render. */
  hideMap?: boolean
  className?: string
}

/**
 * The one place the product shows a store's location, reused on every page a
 * store appears. Shows both, deliberately kept apart (see useStoreLocations):
 *
 *  - REGISTERED — the office pin a sales agent / RSR set (blue).
 *  - UPDATED    — the current pin a Collection / Delivery officer set on the
 *                 ground when the store had relocated (orange), with who set it
 *                 and when, plus how far it moved.
 *
 * A store with neither shows a quiet "no location on file" rather than nothing,
 * so an admin can tell "not set" apart from "still loading".
 */
export function StoreLocationPanel({ clientId, hideMap, className }: StoreLocationPanelProps) {
  const { get, loading } = useStoreLocations([clientId])
  const loc = get(clientId)
  const hasAny = !!loc.registered || !!loc.updated
  const moved = movedLabel(loc)

  if (loading && !hasAny) {
    return <div className={`h-24 rounded-md bg-muted animate-pulse ${className ?? ''}`} />
  }

  if (!hasAny) {
    return (
      <div
        className={`flex items-center gap-2 text-[11px] text-muted-foreground rounded-md border border-dashed border-border px-3 py-2 ${className ?? ''}`}
      >
        <MapPinOff className="w-3.5 h-3.5 shrink-0" />
        No store location on file yet.
      </div>
    )
  }

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
          Store location
        </p>
        {moved && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-500">
            <ArrowRight className="w-3 h-3" />
            {moved}
          </span>
        )}
      </div>

      {!hideMap && (
        <div className="h-44 rounded-md overflow-hidden border border-border">
          <StoreLocationMap registered={loc.registered} updated={loc.updated} />
        </div>
      )}

      <div className="space-y-2">
        {loc.registered && (
          <LocationRow
            color={REGISTERED_COLOR}
            title="Registered location"
            subtitle={`Office pin · ${officePinSourceLabel(loc.registered.source)}`}
            lat={loc.registered.lat}
            lng={loc.registered.lng}
          />
        )}
        {loc.updated && (
          <LocationRow
            color={UPDATED_COLOR}
            title="Updated location"
            subtitle={
              `Set on the ground` +
              (loc.updated.setByName ? ` by ${loc.updated.setByName}` : '') +
              (loc.updated.capturedAt
                ? ` · ${format(new Date(loc.updated.capturedAt), 'MMM d, yyyy')}`
                : '') +
              (loc.updated.label ? ` · ${loc.updated.label}` : '')
            }
            lat={loc.updated.lat}
            lng={loc.updated.lng}
          />
        )}
      </div>
    </div>
  )
}
