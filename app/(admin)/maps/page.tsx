'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useClients } from '@/lib/hooks/use-clients'
import { useMeetings } from '@/lib/hooks/use-meetings'
import { getMapStatus, isAvailableForReassignment, STATUS_META, TILE_LAYERS, type MapStatus, type MapTileType } from '@/components/maps/map-constants'
import { Search, Building2, Phone, User, History, ShieldCheck, MapPin, Layers, LockOpen, ChevronDown, Check, Info } from 'lucide-react'
import { format } from 'date-fns'

const ClientMap = dynamic(() => import('@/components/maps/client-map'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 h-full flex items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
})

const OUTCOME_LABEL: Record<string, string> = {
  successful: 'Successful',
  follow_up: 'Follow-up',
  no_decision: 'No Decision',
  lost_opportunity: 'Lost',
}

const STATUS_KEYS = Object.keys(STATUS_META) as MapStatus[]
const TILE_KEYS = Object.keys(TILE_LAYERS) as MapTileType[]

export default function MapsPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | MapStatus>('all')
  const [agentFilter, setAgentFilter] = useState<'all' | 'unassigned' | string>('all')
  const [mapType, setMapType] = useState<MapTileType>('satellite')
  const [mapTypeMenuOpen, setMapTypeMenuOpen] = useState(false)
  const mapTypeMenuRef = useRef<HTMLDivElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { clients } = useClients()
  // Meetings back the Activity History panel only — never the pin positions.
  const { meetings } = useMeetings()

  useEffect(() => {
    if (!mapTypeMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (mapTypeMenuRef.current && !mapTypeMenuRef.current.contains(e.target as Node)) {
        setMapTypeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [mapTypeMenuOpen])

  const agentOptions = useMemo(() => {
    const byId = new Map<string, string>()
    let hasUnassigned = false
    clients.forEach(c => {
      if (c.agent) byId.set(c.agent.id, c.agent.full_name)
      else hasUnassigned = true
    })
    return {
      hasUnassigned,
      agents: Array.from(byId, ([id, full_name]) => ({ id, full_name })).sort((a, b) =>
        a.full_name.localeCompare(b.full_name)
      ),
    }
  }, [clients])

  const filtered = useMemo(() => {
    return clients.filter(c => {
      const status = getMapStatus(c)
      const matchStatus = statusFilter === 'all' || status === statusFilter
      const matchAgent =
        agentFilter === 'all' ||
        (agentFilter === 'unassigned' ? !c.agent : c.agent?.id === agentFilter)
      const q = search.toLowerCase()
      const matchSearch =
        c.company_name.toLowerCase().includes(q) ||
        c.office_address.toLowerCase().includes(q)
      return matchStatus && matchAgent && matchSearch
    })
  }, [clients, search, statusFilter, agentFilter])

  // Zero until clients carry their own coordinates — see ClientMap's note.
  const plottedCount = useMemo(
    () => filtered.filter(c => c.office_lat != null && c.office_lng != null).length,
    [filtered]
  )

  const selected = clients.find(c => c.id === selectedId) ?? null
  // Keyed on selectedId (a string) rather than the selected client object:
  // depending on the object trips the React Compiler's mutation analysis.
  const selectedHistory = useMemo(
    () =>
      selectedId
        ? meetings
            .filter(m => m.client_id === selectedId)
            .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
        : [],
    [selectedId, meetings]
  )

  const counts = STATUS_KEYS.reduce((acc, key) => {
    acc[key] = clients.filter(c => getMapStatus(c) === key).length
    return acc
  }, {} as Record<MapStatus, number>)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Counts plotted, not matched — plottedCount is 0 until clients carry
          coordinates, and saying "44 accounts" would overstate what's on screen. */}
      <Header
        title="Maps"
        subtitle={`${plottedCount} of ${filtered.length} accounts plotted`}
      />

      <div className="flex-1 flex min-h-0">
        {/* Left panel: search/filter + account list */}
        <div className="w-80 shrink-0 border-r border-border flex flex-col min-h-0">
          <div className="p-4 space-y-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search store or address..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-9 bg-card border-border"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={statusFilter} onValueChange={v => setStatusFilter((v as MapStatus | null) ?? 'all')}>
                <SelectTrigger className="w-full h-9 bg-card border-border">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {STATUS_KEYS.map(key => (
                    <SelectItem key={key} value={key}>{STATUS_META[key].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={agentFilter} onValueChange={v => setAgentFilter(v ?? 'all')}>
                <SelectTrigger className="w-full h-9 bg-card border-border">
                  <SelectValue placeholder="All Agents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Agents</SelectItem>
                  {agentOptions.agents.map(agent => (
                    <SelectItem key={agent.id} value={agent.id}>{agent.full_name}</SelectItem>
                  ))}
                  {agentOptions.hasUnassigned && (
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
            {filtered.map(client => {
              const status = getMapStatus(client)
              const active = client.id === selectedId
              return (
                <button
                  key={client.id}
                  onClick={() => setSelectedId(client.id)}
                  className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: STATUS_META[status].color }}
                    />
                    <p className="text-sm font-medium text-foreground truncate">{client.company_name}</p>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate pl-4">
                    {client.office_address || [client.city, client.province].filter(Boolean).join(', ') || 'No address on file'}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 pl-4">
                    {client.agent && (
                      <Avatar className="size-4 after:border-0">
                        {client.agent.avatar_url && <AvatarImage src={client.agent.avatar_url} alt="" />}
                        <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                          {client.agent.full_name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Agent: {client.agent?.full_name ?? 'Unassigned'}
                    </p>
                    {isAvailableForReassignment(client) && (
                      <Badge variant="outline" className="text-[9px] px-1 h-3.5 bg-primary/10 text-primary border-primary/30">
                        Available
                      </Badge>
                    )}
                  </div>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className="text-center py-12 text-muted-foreground text-sm px-4">
                No accounts match your filters
              </div>
            )}
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 relative min-h-0">
          <ClientMap clients={filtered} selectedId={selectedId} onSelect={setSelectedId} mapType={mapType} />

          {/* Says why the map is bare, so an empty map doesn't read as a bug.
              Removed once clients carry coordinates. */}
          {plottedCount === 0 && (
            <Card className="absolute top-4 left-1/2 -translate-x-1/2 bg-card/95 border-border backdrop-blur-sm z-[1000] py-0 gap-0 max-w-md">
              <CardContent className="p-3 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground leading-relaxed">
                  <p className="font-medium text-foreground mb-0.5">No account locations yet</p>
                  Clients aren&apos;t pinned to a location when they&apos;re created, so there is
                  nothing to plot. Once the app captures a pin at client creation, accounts
                  will appear here automatically.
                </div>
              </CardContent>
            </Card>
          )}

          {/* Map type switcher */}
          <div ref={mapTypeMenuRef} className="absolute bottom-4 left-4 z-[1000]">
            <button
              type="button"
              onClick={() => setMapTypeMenuOpen(o => !o)}
              aria-expanded={mapTypeMenuOpen}
              className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-full bg-card/95 border border-border backdrop-blur-sm shadow-sm text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              <Layers className="w-3.5 h-3.5 text-muted-foreground" />
              {TILE_LAYERS[mapType].label}
              <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${mapTypeMenuOpen ? '' : 'rotate-180'}`} />
            </button>

            {mapTypeMenuOpen && (
              <Card className="absolute bottom-full left-0 mb-2 w-[15.5rem] bg-card/95 border-border backdrop-blur-sm py-0 gap-0">
                <CardContent className="p-2">
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
                          onClick={() => {
                            setMapType(key)
                            setMapTypeMenuOpen(false)
                          }}
                          className="flex flex-col items-stretch gap-1 p-1 rounded-lg hover:bg-muted/50 transition-colors"
                        >
                          <div
                            className={`relative w-full aspect-square rounded-md overflow-hidden ring-2 ${
                              active ? 'ring-primary' : 'ring-transparent'
                            }`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={TILE_LAYERS[key].preview}
                              alt=""
                              className="w-full h-full object-cover"
                            />
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
                </CardContent>
              </Card>
            )}
          </div>

          <Card className="absolute top-4 right-4 bg-card/95 border-border backdrop-blur-sm z-[1000] pt-0 gap-0">
            <CardContent className="p-3 space-y-1.5">
              <p className="text-[11px] font-semibold text-foreground mb-1">Legend</p>
              {STATUS_KEYS.map(key => (
                <div key={key} className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: STATUS_META[key].color }}
                  />
                  <span className="text-xs text-muted-foreground">{STATUS_META[key].label}</span>
                  <span className="text-xs text-foreground ml-auto font-medium pl-4">{counts[key]}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right detail panel */}
        <div className="w-80 shrink-0 border-l border-border overflow-y-auto min-h-0">
          {selected ? (
            <div className="p-5 space-y-5">
              <div>
                <Badge
                  variant="outline"
                  style={{
                    borderColor: `${STATUS_META[getMapStatus(selected)].color}55`,
                    color: STATUS_META[getMapStatus(selected)].color,
                  }}
                  className="text-[10px] px-1.5 h-5 mb-2"
                >
                  {STATUS_META[getMapStatus(selected)].label}
                </Badge>
                <h2 className="text-base font-semibold text-foreground">{selected.company_name}</h2>
                <div className="flex items-start gap-1.5 mt-1">
                  <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    {selected.office_address || [selected.city, selected.province].filter(Boolean).join(', ') || 'No address on file'}
                  </p>
                </div>
                {selected.agent && (
                  <div className="flex items-center gap-2.5 mt-3 p-2 rounded-lg bg-muted/30 border border-border">
                    <Avatar size="default">
                      {selected.agent.avatar_url && <AvatarImage src={selected.agent.avatar_url} alt={selected.agent.full_name} />}
                      <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
                        {selected.agent.full_name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{selected.agent.full_name}</p>
                      <p className="text-[10px] text-muted-foreground">Assigned Agent</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <User className="w-3.5 h-3.5 shrink-0" />
                  {selected.contact_person}
                  {selected.contact_position ? ` · ${selected.contact_position}` : ''}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Phone className="w-3.5 h-3.5 shrink-0" />
                  {selected.contact_number}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Building2 className="w-3.5 h-3.5 shrink-0" />
                  {selected.sales_channel.replace('_', ' ')}
                </div>
              </div>

              <div className="pt-3 border-t border-border">
                <div className="flex items-center gap-2 mb-2">
                  {isAvailableForReassignment(selected) ? (
                    <LockOpen className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                  )}
                  <p className="text-xs font-medium text-foreground">Account Reservation</p>
                </div>
                {isAvailableForReassignment(selected) ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Lost Opportunity, past its 14-day cooldown{selected.reassignable_at ? ` (since ${format(new Date(selected.reassignable_at), 'MMM d, yyyy')})` : ''}.
                    Last handled by <span className="text-foreground font-medium">{selected.agent?.full_name ?? 'Unassigned'}</span>, but this account is now{' '}
                    <span className="text-primary font-medium">available for reassignment</span> to another agent.
                  </p>
                ) : selected.status === 'lost' ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Lost Opportunity — still reserved to <span className="text-foreground font-medium">{selected.agent?.full_name ?? 'Unassigned'}</span> during
                    its 14-day cooldown{selected.reassignable_at ? `, reassignable starting ${format(new Date(selected.reassignable_at), 'MMM d, yyyy')}` : ''}.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Assigned to <span className="text-foreground font-medium">{selected.agent?.full_name ?? 'Unassigned'}</span>.
                    This account is reserved on the map so other agents know not to approach it.
                  </p>
                )}
              </div>

              <div className="pt-3 border-t border-border">
                <div className="flex items-center gap-2 mb-2">
                  <History className="w-3.5 h-3.5 text-primary" />
                  <p className="text-xs font-medium text-foreground">Activity History</p>
                </div>
                <div className="space-y-3">
                  {selectedHistory.length === 0 && (
                    <p className="text-xs text-muted-foreground">No meetings logged yet.</p>
                  )}
                  {selectedHistory.map(m => (
                    <div key={m.id} className="text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">
                          {format(new Date(m.meeting_date), 'MMM d, yyyy')}
                        </span>
                        <Badge variant="outline" className="text-[10px] px-1.5 h-4">
                          {OUTCOME_LABEL[m.outcome] ?? m.outcome}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-0.5">
                        {[m.agent?.full_name, m.contact_person].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Select a pin or account to view details
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
