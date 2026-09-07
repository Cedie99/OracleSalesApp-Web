'use client'

import { useMemo, useState } from 'react'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { ReportFilters, ReportGrid, downloadSheet, type ReportDefinition } from '@/components/reports/report-grid'
import { useDeliveryReportCounts } from '@/lib/hooks/use-report-counts'
import { fetchDeliveryReportRows } from '@/lib/reports/ops-rows'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { codVariance, dwellMinutes, hasMissingProof } from '@/lib/delivery'
import { peso } from '@/lib/money'
import {
  DELIVERY_STATUS_LABEL, REMITTANCE_STATUS_LABEL, paymentMethodLabel,
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

  const { byRole } = useProfiles()
  const drivers = useMemo(() => byRole(['delivery']), [byRole])

  // Cards are aggregates (migration 140); the exports fetch their rows on the
  // click — see lib/reports/ops-rows.ts.
  const reportFilters = useMemo(
    () => ({ personId: driverFilter, range: dateFilter.range }),
    [driverFilter, dateFilter.range],
  )
  const { counts } = useDeliveryReportCounts(reportFilters)

  const reports: ReportDefinition[] = [
    {
      title: 'Trip Report',
      description: 'Every stop with driver, plate, sequence, times, dwell, GPS, and proof flags',
      icon: Package,
      count: counts.orders.count,
      countLabel: 'stops',
      stats: [
        { label: 'Delivered', value: counts.orders.delivered },
        { label: 'Failed', value: counts.orders.failed },
        { label: 'COD', value: peso(counts.orders.codCollected) },
      ],
      onDownload: async () => {
        const { orders } = await fetchDeliveryReportRows(reportFilters)
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
            'COD Method': po.cod_method ? paymentMethodLabel(po.cod_method) : '',
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
        )
      },
    },
    {
      title: 'COD Remittances Report',
      description: 'COD handed over at the office, with variance against what was collected',
      icon: CircleDollarSign,
      count: counts.remittances.count,
      countLabel: 'remittances',
      stats: [
        { label: 'Reconciled', value: counts.remittances.reconciled },
        { label: 'Variance', value: counts.remittances.variance },
        { label: 'Remitted', value: peso(counts.remittances.remitted) },
      ],
      onDownload: async () => {
        const { remittances } = await fetchDeliveryReportRows(reportFilters)
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
        )
      },
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
