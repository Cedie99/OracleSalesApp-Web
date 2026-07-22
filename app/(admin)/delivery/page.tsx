'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mockPurchaseOrders, mockProfiles } from '@/lib/mock/data'
import { DELIVERY_STATUS_LABEL, DELIVERY_STATUS_TONE, TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import type { PurchaseOrder } from '@/types'
import { Search, Truck, Camera, Clock, AlertTriangle, PackageCheck, PackageX } from 'lucide-react'
import { format } from 'date-fns'

/**
 * Delivery oversight (F-007).
 *
 * Read-only, matching the stance on Collection: delivery personnel mark POs
 * delivered on the phone, web is where admin watches the queue. Modelled on the
 * delivery screens in Wireframe-Collection-Delivery-BizLink.html.
 *
 * Two rules from that wireframe drive this page:
 *  1. NO GPS. "Walang GPS sa delivery module (per confirmed scope) — timestamp +
 *     proof photo lang." Delivery proof is timestamp + photo + receiver name only.
 *     Do not add a map or coordinates here; that is a deliberate scope decision,
 *     not a gap.
 *  2. A failed attempt starts a 3-day follow-up countdown, and an undelivered PO
 *     is auto-deleted when it expires. Day 3 is therefore the last chance to act,
 *     which is why those rows sort first and render red rather than amber.
 *
 * Mock-backed: no delivery tables exist in the database yet.
 */

/** The follow-up window before an undelivered PO is auto-deleted. */
const FOLLOWUP_WINDOW_DAYS = 3

function isLastChance(po: PurchaseOrder): boolean {
  return po.status === 'followup' && po.followup_day === FOLLOWUP_WINDOW_DAYS
}

export default function DeliveryPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all')
  const [selected, setSelected] = useState<PurchaseOrder | null>(null)

  // Filtered by role now that `delivery` exists (migration 023), so personnel
  // with an empty queue still appear in the filter instead of vanishing.
  const assignees = useMemo(() => mockProfiles.filter(p => p.role === 'delivery'), [])

  const orders = useMemo(() => {
    const filtered = mockPurchaseOrders.filter(po => {
      const q = search.toLowerCase()
      const matchSearch =
        po.po_number.toLowerCase().includes(q) ||
        (po.client?.company_name ?? '').toLowerCase().includes(q) ||
        po.area.toLowerCase().includes(q)
      const matchStatus = statusFilter === 'all' || po.status === statusFilter
      const matchAssignee = assigneeFilter === 'all' || po.assigned_to === assigneeFilter
      return matchSearch && matchStatus && matchAssignee
    })

    // Expiring follow-ups first, then the rest of the open queue, then delivered.
    const rank = (po: PurchaseOrder) =>
      isLastChance(po) ? 0 : po.status === 'followup' ? 1 : po.status === 'pending' ? 2 : 3
    return [...filtered].sort((a, b) => rank(a) - rank(b) || a.po_number.localeCompare(b.po_number))
  }, [search, statusFilter, assigneeFilter])

  const stats = useMemo(() => {
    const today = new Date().toDateString()
    return {
      toDeliver: orders.filter(po => po.status === 'pending').length,
      followup: orders.filter(po => po.status === 'followup').length,
      expiring: orders.filter(isLastChance).length,
      deliveredToday: orders.filter(
        po => po.status === 'delivered' && po.delivered_at && new Date(po.delivered_at).toDateString() === today
      ).length,
    }
  }, [orders])

  return (
    <div className="flex flex-col flex-1">
      <Header title="Delivery" subtitle={`${orders.length} purchase orders`} />

      <div className="flex-1 p-6 space-y-4">
        {/* Queue summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">To deliver</p>
                <Truck className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{stats.toDeliver}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Assigned, not yet attempted</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">In follow-up</p>
                <Clock className={`w-4 h-4 ${stats.followup > 0 ? TONE_TEXT.amber : 'text-muted-foreground'}`} />
              </div>
              <p className={`text-2xl font-semibold tabular-nums ${stats.followup > 0 ? TONE_TEXT.amber : ''}`}>
                {stats.followup}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Failed at least one attempt</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Expiring today</p>
                <AlertTriangle className={`w-4 h-4 ${stats.expiring > 0 ? TONE_TEXT.red : 'text-muted-foreground'}`} />
              </div>
              <p className={`text-2xl font-semibold tabular-nums ${stats.expiring > 0 ? TONE_TEXT.red : ''}`}>
                {stats.expiring}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Day {FOLLOWUP_WINDOW_DAYS} — auto-deletes if undelivered
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="px-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Delivered today</p>
                <PackageCheck className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-semibold tabular-nums">{stats.deliveredToday}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Signed for and photographed</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search PO number, client, or area..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
            <SelectTrigger className="w-40 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="followup">Follow-up</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
            </SelectContent>
          </Select>
          <Select value={assigneeFilter} onValueChange={v => setAssigneeFilter(v ?? 'all')}>
            <SelectTrigger className="w-48 h-9">
              <SelectValue placeholder="Assigned to" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Personnel</SelectItem>
              {assignees.map(a => (
                <SelectItem key={a.id} value={a.id}>{a.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">PO</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Client</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Area</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Items</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Assigned</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Received by</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map(po => {
                  const lastChance = isLastChance(po)
                  return (
                    <tr
                      key={po.id}
                      onClick={() => setSelected(po)}
                      className="hover:bg-muted/20 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
                        {po.po_number}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-foreground truncate max-w-[160px]">{po.client?.company_name}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{po.area}</td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">{po.items}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="tone" className={TONE_CLASS[DELIVERY_STATUS_TONE[po.status]]}>
                            {DELIVERY_STATUS_LABEL[po.status]}
                          </Badge>
                          {po.status === 'followup' && (
                            <span
                              className={`text-[11px] font-medium whitespace-nowrap ${lastChance ? TONE_TEXT.red : TONE_TEXT.amber}`}
                            >
                              day {po.followup_day} of {FOLLOWUP_WINDOW_DAYS}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {po.assignee?.full_name}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {po.receiver_name ? (
                          <>
                            <span className="text-foreground">{po.receiver_name}</span>
                            {po.delivered_at && (
                              <span className="block text-muted-foreground">
                                {format(new Date(po.delivered_at), 'MMM d, h:mm a')}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {po.proof_url ? (
                          <Camera className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {orders.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Truck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No purchase orders found</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* PO detail */}
      <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)}>
        <DialogContent className="max-w-md">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{selected.po_number}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="tone" className={TONE_CLASS[DELIVERY_STATUS_TONE[selected.status]]}>
                    {DELIVERY_STATUS_LABEL[selected.status]}
                  </Badge>
                  {selected.status === 'followup' && (
                    <span
                      className={`text-xs font-medium ${isLastChance(selected) ? TONE_TEXT.red : TONE_TEXT.amber}`}
                    >
                      Day {selected.followup_day} of {FOLLOWUP_WINDOW_DAYS}
                    </span>
                  )}
                </div>

                <div>
                  <p className="font-medium text-foreground">{selected.client?.company_name}</p>
                  <p className="text-xs text-muted-foreground">{selected.area}</p>
                </div>

                <div className="rounded-xl bg-muted/50 p-3">
                  <p className="text-[11px] text-muted-foreground mb-1">Items</p>
                  <p className="text-xs">{selected.items}</p>
                </div>

                {isLastChance(selected) && (
                  <div className="rounded-xl bg-[var(--badge-red-bg)] p-3">
                    <p className={`text-xs font-semibold ${TONE_TEXT.red} flex items-center gap-1.5`}>
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      Last day of the follow-up window
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      This PO is auto-deleted if it is still undelivered when the {FOLLOWUP_WINDOW_DAYS}-day
                      window closes.
                    </p>
                  </div>
                )}

                <div className="space-y-1.5 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Auto-captured</p>
                  <p className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    {selected.delivered_at
                      ? format(new Date(selected.delivered_at), 'MMM d, yyyy · h:mm a')
                      : 'Not yet delivered'}
                  </p>
                  {/* Stated explicitly so nobody reads the absence as a bug. */}
                  <p className="flex items-center gap-1.5">
                    <PackageX className="w-3.5 h-3.5 shrink-0" />
                    No GPS — not part of the delivery scope
                  </p>
                </div>

                {selected.receiver_name && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Received by: </span>
                    <span className="font-medium">{selected.receiver_name}</span>
                  </p>
                )}

                {selected.remarks && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Remarks: </span>
                    {selected.remarks}
                  </p>
                )}

                {selected.proof_url && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={selected.proof_url}
                    alt="Proof of delivery"
                    className="w-full rounded-xl border border-border"
                  />
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
