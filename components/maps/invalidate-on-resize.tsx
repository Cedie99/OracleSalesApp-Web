'use client'

import { useEffect } from 'react'
import { useMap } from 'react-leaflet'

/**
 * Leaflet caches its container's pixel size and only re-measures on a WINDOW
 * resize. Every map in this app lives in a box that changes size without the
 * window doing anything — the Maps page list collapsing, a dialog animating
 * open from zero height — and Leaflet never hears about it, so it keeps
 * requesting tiles for a viewport that no longer exists and leaves a grey box.
 *
 * Watch the element itself and tell it to re-measure. Drop this inside any
 * MapContainer; it renders nothing.
 */
export function InvalidateOnResize() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    const observer = new ResizeObserver(() => {
      // Wait for the layout/animation frame to settle before remeasuring.
      requestAnimationFrame(() => map.invalidateSize({ animate: false }))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [map])
  return null
}
