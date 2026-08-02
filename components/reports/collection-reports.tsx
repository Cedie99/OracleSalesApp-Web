'use client'

import { useMemo, useState } from 'react'
import { useDateRangeFilter } from '@/lib/hooks/use-date-range-filter'
import { ReportFilters, ReportGrid, downloadSheet, type ReportDefinition } from '@/components/reports/report-grid'
import { useCollectionVisits, useRemittances } from '@/lib/hooks/use-collection'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { hasMissingProof, remittanceVariance } from '@/lib/collection'
import { peso } from '@/lib/money'
import {
  REMITTANCE_DESTINATION_LABEL, paymentMethodLabel,
  REMITTANCE_STATUS_LABEL, VISIT_STATUS_LABEL,
} from '@/lib/status-styles'
import { Store, Wallet } from 'lucide-react'
import { format } from 'date-fns'

/**
 * The Collection lens on Reports.
 *
 * Two exports, matching the two halves of the module: what was collected in the
 * field, and what was handed over at the office. They are separate sheets rather
 * than one joined export because they reconcile against each other — the point
 * of a remittance report is comparing its totals to the visit totals, which a
 * single flattened sheet would obscure.
 *
 * Backed by mock data — no collection tables exist as of migration 024.
 */
export function CollectionReports() {
  const [collectorFilter, setCollectorFilter] = useState<string>('all')
  const dateFilter = useDateRangeFilter({ defaultPreset: 'all' })
  const { inRange } = dateFilter

  const { visits: allVisits } = useCollectionVisits()
  const { remittances: allRemittances } = useRemittances()
  const { byRole } = useProfiles()

  const collectors = useMemo(() => byRole(['collector']), [byRole])

  const visits = useMemo(
    () =>
      allVisits
        .filter(v => collectorFilter === 'all' || v.collector_id === collectorFilter)
        .filter(v => inRange(v.scheduled_for)),
    [allVisits, collectorFilter, inRange]
  )

  const remittances = useMemo(
    () =>
      allRemittances
        .filter(r => collectorFilter === 'all' || r.collector_id === collectorFilter)
        .filter(r => inRange(r.submitted_at)),
    [allRemittances, collectorFilter, inRange]
  )

  const totalCollected = visits.reduce((sum, v) => sum + (v.amount_collected ?? 0), 0)

  const reports: ReportDefinition[] = [
    {
      title: 'Collection Report',
      description: 'Every listed store with amount due, collected, method, GPS, and proof flags',
      icon: Store,
      count: visits.length,
      countLabel: 'stores',
      stats: [
        { label: 'Collected', value: visits.filter(v => v.status === 'collected').length },
        { label: 'Rescheduled', value: visits.filter(v => v.status === 'rescheduled').length },
        { label: 'Total', value: peso(totalCollected) },
      ],
      onDownload: () =>
        downloadSheet(
          visits.map(v => ({
            'Collection Day': format(new Date(v.scheduled_for), 'MMM d, yyyy'),
            'Store': v.client?.company_name ?? '',
            'Address': v.client?.office_address ?? '',
            'Status': VISIT_STATUS_LABEL[v.status],
            // Admin-only figure: the collector's app deliberately hides this to
            // stop them anchoring to it. It belongs in an admin export.
            'Amount Due': v.amount_due,
            'Amount Collected': v.amount_collected ?? '',
            'Payment Method': v.payment_method ? paymentMethodLabel(v.payment_method) : '',
            'Collector': v.collector?.full_name ?? '',
            'Visited At': v.visited_at ? format(new Date(v.visited_at), 'MMM d, yyyy h:mm a') : '',
            'GPS': v.gps_lat != null ? `${v.gps_lat}, ${v.gps_lng}` : '',
            'Payment Photo': v.payment_photo_url ? 'Yes' : 'No',
            // "Photo" is in the header because 'Delivery Receipt' is now also a
            // payment method, and a column that could mean either is a column
            // someone will misread.
            'Delivery Receipt Photo': v.delivery_receipt_photo_url ? 'Yes' : 'No',
            'Customer Signature': v.customer_signature_url ? 'Yes' : 'No',
            'Missing Proof': hasMissingProof(v) ? 'Yes' : 'No',
            'Rescheduled To': v.rescheduled_to ? format(new Date(v.rescheduled_to), 'MMM d, yyyy') : '',
            'Remarks': v.remarks ?? '',
          })),
          'Collection',
          'collection-report'
        ),
    },
    {
      title: 'Remittances Report',
      description: 'Money handed over, where it went, and any variance against what was collected',
      icon: Wallet,
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
            'Collector': r.collector?.full_name ?? '',
            'Destination': REMITTANCE_DESTINATION_LABEL[r.destination],
            'Amount Collected': r.amount_collected,
            'Amount Remitted': r.amount_remitted,
            'Variance': remittanceVariance(r),
            'Status': REMITTANCE_STATUS_LABEL[r.status],
            'Stores Covered': r.visit_ids.length,
            'Receiver': r.receiver_name ?? '',
            'Signature': r.receiver_signature_url ? 'Yes' : 'No',
            'Signed Proof': r.signed_proof_url ? 'Yes' : 'No',
          })),
          'Remittances',
          'remittances-report'
        ),
    },
  ]

  return (
    <>
      <ReportFilters
        label="Filter by collector"
        allLabel="All Collectors"
        options={collectors.map(c => ({ id: c.id, name: c.full_name }))}
        value={collectorFilter}
        onChange={setCollectorFilter}
        dateFilter={dateFilter}
      />

      <ReportGrid reports={reports} />

      <p className="text-xs text-muted-foreground text-center">
        Reports are exported as .xlsx files. Collection runs on mock data until its tables exist.
      </p>
    </>
  )
}
