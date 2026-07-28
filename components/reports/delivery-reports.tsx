'use client'

import { useMemo, useState } from 'react'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { ReportFilters, ReportGrid, downloadSheet, type ReportDefinition } from '@/components/reports/report-grid'
import { usePurchaseOrders, useCodRemittances } from '@/lib/hooks/use-delivery'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { codVariance, dwellMinutes, hasMissingProof } from '@/lib/delivery'
import { peso } from '@/lib/money'
import {
  DELIVERY_STATUS_LABEL, PAYMENT_METHOD_LABEL, REMITTANCE_STATUS_LABEL,
} from '@/lib/status-styles'
import { Package, CircleDollarSign } from 'lucide-react'
import { format } from 'date-fns'

/**
 * The Delivery lens on Reports — the Collection twin.
 *
 * The trip-report export mirrors the paper "TRIP REPORT" the office runs today
 * (SEQ / COMPANY NAME / LOCATION / TIME-IN / TIME-OUT / signature) so the
 * exported sheet can be read side by side with the sheets already in the filing
 * cabinet. Dwell is included as a derived column because it is the number the
 * paper form makes people compute by hand.
 *
 * Backed by mock data — no delivery tables exist as of migration 024.
 */
export function DeliveryReports() {
  const [driverFilter, setDriverFilter] = useState<string>('all')
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })
  const { inRange } = dateFilter

  const { orders: allOrders } = usePurchaseOrders()
  const { codRemittances } = useCodRemittances()
  const { byRole } = useProfiles()

  const drivers = useMemo(() => byRole(['delivery']), [byRole])

  const orders = useMemo(
    () =>
      allOrders
        .filter(po => driverFilter === 'all' || po.driver_id === driverFilter)
        .filter(po => inRange(po.scheduled_for)),
    [allOrders, driverFilter, inRange]
  )

  const remittances = useMemo(
    () =>
      codRemittances
        .filter(r => driverFilter === 'all' || r.driver_id === driverFilter)
        .filter(r => inRange(r.submitted_at)),
    [codRemittances, driverFilter, inRange]
  )

  const codCollected = orders.reduce((sum, po) => sum + (po.cod_amount ?? 0), 0)

  const reports: ReportDefinition[] = [
    {
      title: 'Trip Report',
      description: 'Every stop with driver, plate, sequence, times, dwell, GPS, and proof flags',
      icon: Package,
      count: orders.length,
      countLabel: 'stops',
      stats: [
        { label: 'Delivered', value: orders.filter(po => po.status === 'delivered').length },
        { label: 'Failed', value: orders.filter(po => po.status === 'failed').length },
        { label: 'COD', value: peso(codCollected) },
      ],
      onDownload: () =>
        downloadSheet(
          orders.map(po => ({
            'Delivery Day': format(new Date(po.scheduled_for), 'MMM d, yyyy'),
            'Seq': po.sequence_no ?? '',
            'PO Number': po.po_number,
            'Company Name': po.client?.company_name ?? '',
            'Location': po.area,
            'Status': DELIVERY_STATUS_LABEL[po.status],
            'Driver': po.driver?.full_name ?? '',
            'Truck Plate': po.truck_plate ?? '',
            'Time In': po.time_in ? format(new Date(po.time_in), 'h:mm a') : '',
            'Time Out': po.time_out ? format(new Date(po.time_out), 'h:mm a') : '',
            'Dwell (mins)': dwellMinutes(po) ?? '',
            'COD': po.cod ? 'Yes' : 'No',
            'COD Due': po.cod_due ?? '',
            'COD Collected': po.cod_amount ?? '',
            'COD Method': po.cod_method ? PAYMENT_METHOD_LABEL[po.cod_method] : '',
            'COD Remitted': po.cod ? (po.cod_remitted ? 'Yes' : 'No') : '',
            'Received By': po.receiver_name ?? '',
            'Signature': po.receiver_signature_url ? 'Yes' : 'No',
            'GPS': po.gps_lat != null ? `${po.gps_lat}, ${po.gps_lng}` : '',
            'Proof Photo': po.proof_url ? 'Yes' : 'No',
            'Backload Photo': po.backload_photo_url ? 'Yes' : 'No',
            'Missing Proof': hasMissingProof(po) ? 'Yes' : 'No',
            'Remarks': po.remarks ?? '',
          })),
          'Trip Report',
          'delivery-trip-report'
        ),
    },
    {
      title: 'COD Remittances Report',
      description: 'COD handed over at the office, with variance against what was collected',
      icon: CircleDollarSign,
      count: remittances.length,
      countLabel: 'remittances',
      stats: [
        { label: 'Reconciled', value: remittances.filter(r => r.status === 'reconciled').length },
        { label: 'Variance', value: remittances.filter(r => r.status === 'variance').length },
        {
          label: 'Remitted',
          value: peso(remittances.reduce((sum, r) => sum + r.amount_remitted, 0)),
        },
      ],
      onDownload: () =>
        downloadSheet(
          remittances.map(r => ({
            'Submitted': format(new Date(r.submitted_at), 'MMM d, yyyy h:mm a'),
            'Driver': r.driver?.full_name ?? '',
            'Amount Collected': r.amount_collected,
            'Amount Remitted': r.amount_remitted,
            'Variance': codVariance(r),
            'Status': REMITTANCE_STATUS_LABEL[r.status],
            'Stops Covered': r.po_ids.length,
            'Receiver': r.receiver_name,
            // Office is the only destination for COD, so the signature is always
            // required — a blank here is a genuine gap, not an allowed variant.
            'Signature': r.receiver_signature_url ? 'Yes' : 'No',
          })),
          'COD Remittances',
          'cod-remittances-report'
        ),
    },
  ]

  return (
    <>
      <ReportFilters
        label="Filter by driver"
        allLabel="All Drivers"
        options={drivers.map(d => ({ id: d.id, name: d.full_name }))}
        value={driverFilter}
        onChange={setDriverFilter}
        dateFilter={dateFilter}
      />

      <ReportGrid reports={reports} />

      <p className="text-xs text-muted-foreground text-center">
        Reports are exported as .xlsx files. Delivery runs on mock data until its tables exist.
      </p>
    </>
  )
}
