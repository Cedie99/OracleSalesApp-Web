'use client'

import { useState } from 'react'
import { Layers, ChevronDown, Check } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { TILE_LAYERS, type MapTileType } from '@/components/maps/map-constants'

const TILE_KEYS = Object.keys(TILE_LAYERS) as MapTileType[]

interface MapTypePickerProps {
  mapType: MapTileType
  onChange: (type: MapTileType) => void
  /** Positions the trigger within its (relatively-positioned) container, e.g. "bottom-4 left-4". */
  className?: string
}

/**
 * The pill-and-preview-grid map type switcher — same widget on the Sales Map,
 * Trip Map, and Field Map (each of which used to reimplement it locally).
 * Pulled out here so a fourth map (the meeting route map) doesn't do it again.
 *
 * The panel is a Base UI Popover rather than a hand-rolled absolutely-positioned
 * div: it portals to the document body and flips side automatically when there
 * isn't room, which matters here specifically because this map sits inside a
 * short, scrollable dialog — a locally-positioned panel got clipped by that
 * scroll container instead of just opening on the other side.
 */
export function MapTypePicker({ mapType, onChange, className = 'bottom-4 left-4' }: MapTypePickerProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={`absolute z-[1000] ${className}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-full bg-card/95 border border-border backdrop-blur-sm shadow-sm text-xs font-medium text-foreground hover:bg-muted/50 transition-colors">
          <Layers className="w-3.5 h-3.5 text-muted-foreground" />
          {TILE_LAYERS[mapType].label}
          <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? '' : 'rotate-180'}`} />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className="w-[15.5rem] p-2">
          <div className="flex items-center gap-1.5 px-1 pt-0.5 pb-1.5">
            <Layers className="w-3 h-3 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-foreground">Map Type</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {TILE_KEYS.map(key => {
              const active = mapType === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { onChange(key); setOpen(false) }}
                  className="flex flex-col items-stretch gap-1 p-1 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className={`relative w-full aspect-square rounded-md overflow-hidden ring-2 ${active ? 'ring-primary' : 'ring-transparent'}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={TILE_LAYERS[key].preview} alt="" className="w-full h-full object-cover" />
                    {active && (
                      <div className="absolute top-1 right-1 bg-primary rounded-full p-0.5">
                        <Check className="w-2 h-2 text-primary-foreground" />
                      </div>
                    )}
                  </div>
                  <span className={`text-[11px] text-center ${active ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                    {TILE_LAYERS[key].label}
                  </span>
                </button>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
