'use client'

import { format } from 'date-fns'
import { GitBranch, MapPin, ExternalLink, ArrowRight } from 'lucide-react'
import {
  useClientFieldLocations,
  type ClientFieldPin,
} from '@/lib/hooks/use-client-field-locations'

/**
 * Store Locations, Option 2 — field-observed municipality + branch triage on the
 * client record (STORE_LOCATIONS_CONTRACT.md §visibility+autoderive).
 *
 * A Collection/Delivery officer standing at a relocated store records where it
 * ACTUALLY is; the municipality is derived from their pin (migration 126). This
 * surfaces that to admin/sales, deliberately ALONGSIDE the registered
 * clients.city — never replacing it, because the registered value stays
 * authoritative for territory and RSR assignment. It also raises any
 * ADDITIONAL-BRANCH pins as a distinct triage list: a field tap must not silently
 * fork a billable account, so admin/sales decides whether a branch becomes real.
 *
 * Complements StoreLocationPanel (which shows the pins on a map); this adds the
 * derived AREA text and the branch flag. Renders nothing until there is a derived
 * field area or a reported branch, so it never duplicates the panel's empty state.
 */

function whoWhen(pin: ClientFieldPin): string {
  const parts: string[] = []
  if (pin.setByName) parts.push(`set by ${pin.setByName}`)
  if (pin.capturedAt) parts.push(format(new Date(pin.capturedAt), 'MMM d, yyyy'))
  return parts.join(' · ')
}

function areaText(pin: ClientFieldPin): string | null {
  if (!pin.area) return null
  return pin.province ? `${pin.area}, ${pin.province}` : pin.area
}

function mapsHref(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

interface ClientFieldLocationsProps {
  clientId: string | null | undefined
  /** The registered municipality (clients.city), shown for comparison. */
  registeredCity?: string | null
  className?: string
}

export function ClientFieldLocations({
  clientId,
  registeredCity,
  className,
}: ClientFieldLocationsProps) {
  const { current, branches } = useClientFieldLocations(clientId)

  const currentArea = current ? areaText(current) : null
  const hasArea = !!currentArea
  const hasBranches = branches.length > 0

  // Nothing field-derived to add yet — StoreLocationPanel covers the rest.
  if (!hasArea && !hasBranches) return null

  const registered = registeredCity?.trim() || null
  // Only worth flagging a difference when we have both to compare.
  const differs =
    hasArea && registered && current?.area?.trim().toLowerCase() !== registered.toLowerCase()

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {hasArea && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1">
          <p className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500" />
            Field-observed area
          </p>
          {registered && (
            <p className="text-[11px] text-muted-foreground">
              Registered: <span className="text-foreground">{registered}</span>
            </p>
          )}
          <p className="text-[11px] text-muted-foreground flex items-center flex-wrap gap-1">
            {registered && <ArrowRight className="w-3 h-3 shrink-0" />}
            Now at: <span className="text-foreground font-medium">{currentArea}</span>
            {current && whoWhen(current) && <span>· {whoWhen(current)}</span>}
          </p>
          {differs && (
            <p className="text-[10px] text-amber-600 dark:text-amber-500">
              Differs from the registered municipality. Registered stays authoritative for
              territory and assignment until an admin promotes the field value.
            </p>
          )}
        </div>
      )}

      {hasBranches && (
        <div className="rounded-md border border-dashed border-amber-500/60 px-3 py-2 space-y-1.5">
          <p className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
            <GitBranch className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500" />
            Additional branches reported ({branches.length})
          </p>
          <p className="text-[10px] text-muted-foreground">
            A field officer reported a separate store at this account. It is NOT the store&apos;s
            location — an admin decides whether a branch becomes its own account.
          </p>
          <ul className="space-y-1.5">
            {branches.map(b => (
              <li key={b.id} className="text-[11px] text-muted-foreground">
                <span className="text-foreground font-medium">
                  {areaText(b) ?? b.label ?? `Branch pin #${b.seq}`}
                </span>
                {whoWhen(b) && <span> · {whoWhen(b)}</span>}
                {' · '}
                <a
                  href={mapsHref(b.lat, b.lng)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  View on map
                  <ExternalLink className="w-3 h-3" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
