'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/ui/pagination'
import { usePagination } from '@/lib/hooks/use-pagination'
import { useCurrentProfile } from '@/lib/hooks/use-current-profile'
import { useProfiles } from '@/lib/hooks/use-profiles'
import { fetchAllPages } from '@/lib/supabase/paginate'
import { createClient as createSupabaseClient } from '@/lib/supabase/client'
import { recordAuditLog } from '@/lib/audit/actions'
import { canImportClients } from '@/lib/permissions'
import { TONE_CLASS, TONE_TEXT } from '@/lib/status-styles'
import { cn } from '@/lib/utils'
import {
  IMPORT_BATCH_SIZE, IMPORTABLE_AGENT_ROLES, parseWorkbook, validateRows,
  type ImportReport, type ImportRow, type RowVerdict,
} from '@/lib/client-import'
import type { BadgeTone } from '@/lib/status-styles'
import type { Profile } from '@/types'
import {
  ArrowLeft, Upload, FileSpreadsheet, Download, Loader2, CheckCircle2, AlertTriangle,
  XCircle, CopyX, Undo2, ShieldAlert, ClipboardCopy, Check,
} from 'lucide-react'
import { toast } from 'sonner'

/**
 * Bulk client import (superadmin).
 *
 * THE SHAPE OF THIS PAGE IS THE SAFETY MECHANISM. Nothing is written until a
 * person has seen a verdict for every row and pressed a second button. The file
 * is parsed and judged entirely in the browser (`lib/client-import.ts`), which
 * is also why there is no API route: an 11,000-row workbook is several megabytes
 * and a Server Action's default body limit is 1MB, so shipping the file to the
 * server would have to be solved before anything else could work. Reading it
 * here and sending only batches of finished column values sidesteps that
 * entirely — and the writes still go through the signed-in admin's own Supabase
 * client, so RLS applies exactly as it does on the Clients page. No service-role
 * key is involved at any point.
 *
 * WHAT IT WILL NOT DO. It only ever INSERTs. There is no update path, so an
 * import cannot overwrite, merge into, or edit a client that already exists —
 * a row that collides with a live client is skipped and reported. That is the
 * property that makes this safe to run against a database with real field data
 * in it, and it should not be relaxed without a much louder confirmation step.
 */

const VERDICT_TONE: Record<RowVerdict, BadgeTone> = {
  ready: 'brand',
  warning: 'amber',
  duplicate: 'neutral',
  error: 'red',
}

const VERDICT_LABEL: Record<RowVerdict, string> = {
  ready: 'Ready',
  warning: 'Imports with notes',
  duplicate: 'Skipped — already exists',
  error: 'Cannot import',
}

const VERDICT_ICON: Record<RowVerdict, React.ElementType> = {
  ready: CheckCircle2,
  warning: AlertTriangle,
  duplicate: CopyX,
  error: XCircle,
}

type Phase = 'idle' | 'reading' | 'reviewing' | 'importing' | 'done'

interface ImportOutcome {
  createdIds: string[]
  failed: { rowNumber: number; companyName: string; message: string }[]
}

export default function ClientImportPage() {
  const router = useRouter()
  const { profile, loading: profileLoading } = useCurrentProfile()
  const { profiles, loading: profilesLoading } = useProfiles()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [fileName, setFileName] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [filter, setFilter] = useState<RowVerdict | 'all'>('all')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)

  const allowed = canImportClients(profile?.role)

  const agents = useMemo(
    () => profiles.filter(p => p.is_active !== false && IMPORTABLE_AGENT_ROLES.includes(p.role)),
    [profiles],
  )

  /**
   * Read the live half of the unique index.
   *
   * `get_company_directory()` (migration 030) is the right source: it is
   * SECURITY DEFINER and exposes exactly `normalized_company_name` and `city`
   * for every non-deleted client, so a caller does not have to re-derive the
   * normalisation.
   *
   * It still has to be paged. PostgREST's `max-rows` ceiling applies to a
   * set-returning function just as it does to a table read, so a single call
   * silently stops at 1,000 rows — and a short directory reports real
   * duplicates as importable, then fails them one at a time against
   * `unique_company_name_city` at insert. The RPC has no ORDER BY of its own,
   * so paging it needs one imposed here or a page boundary can drop a row.
   */
  const loadExistingKeys = useCallback(async (): Promise<Set<string>> => {
    const supabase = createSupabaseClient()
    type DirectoryRow = { id: string; normalized_company_name: string | null; city: string | null }
    let rows: DirectoryRow[]
    try {
      rows = await fetchAllPages<DirectoryRow>((from, to) =>
        supabase.rpc('get_company_directory').order('id', { ascending: true }).range(from, to),
      )
    } catch (readError) {
      throw new Error(`Could not read existing clients: ${
        readError instanceof Error ? readError.message : String(readError)}`)
    }
    const keys = new Set<string>()
    for (const row of rows) {
      keys.add(`${row.normalized_company_name ?? ''}||${row.city ?? ''}`)
    }
    return keys
  }, [])

  async function handleFile(file: File) {
    // Every row is judged against the agent roster, so a file dropped before
    // useProfiles() has answered would report "unknown agent" on all 11,000
    // rows — a wrong verdict that looks exactly like a wrong file. Refuse to
    // start instead.
    if (!agents.length) {
      toast.error(
        profilesLoading
          ? 'Still loading the agent list — try again in a moment.'
          : 'No agents are available to own clients, so nothing can be imported.',
      )
      return
    }

    setPhase('reading')
    setReport(null)
    setOutcome(null)
    setUndone(false)
    setFileName(file.name)

    try {
      const [buffer, existingKeys] = await Promise.all([file.arrayBuffer(), loadExistingKeys()])
      const parsed = parseWorkbook(buffer)
      const result = validateRows(parsed, { agents, existingKeys })
      setReport(result)
      setFilter(result.counts.error > 0 ? 'error' : 'all')
      setPhase('reviewing')
    } catch (err) {
      setPhase('idle')
      toast.error(err instanceof Error ? err.message : 'Could not read that file.')
    }
  }

  /**
   * Write the importable rows.
   *
   * Batched, with a row-by-row fallback: PostgREST sends one INSERT statement
   * per request, so a single row that trips a constraint takes its whole batch
   * down with it. Re-running the failed batch one row at a time turns "200 rows
   * failed" into "199 imported, this one row failed because X", which is the
   * difference between a usable result and a dead end. The retry only runs on
   * the batches that actually failed, so the normal path stays at one request
   * per 200 rows.
   */
  async function runImport() {
    if (!report) return
    const rows = report.importable
    setPhase('importing')
    setProgress({ done: 0, total: rows.length })

    const supabase = createSupabaseClient()
    const createdIds: string[] = []
    const failed: ImportOutcome['failed'] = []

    for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
      const batch = rows.slice(i, i + IMPORT_BATCH_SIZE)
      const { data, error } = await supabase
        .from('clients')
        .insert(batch.map(r => r.values!))
        .select('id')

      if (!error) {
        createdIds.push(...((data ?? []) as { id: string }[]).map(d => d.id))
      } else {
        for (const row of batch) {
          const { data: one, error: rowError } = await supabase
            .from('clients')
            .insert(row.values!)
            .select('id')
            .single()
          if (rowError) {
            failed.push({ rowNumber: row.rowNumber, companyName: row.companyName, message: rowError.message })
          } else if (one) {
            createdIds.push((one as { id: string }).id)
          }
        }
      }

      setProgress({ done: Math.min(i + batch.length, rows.length), total: rows.length })
    }

    setOutcome({ createdIds, failed })
    setPhase('done')

    // Logged after the write and never awaited into the failure path — see
    // lib/audit/actions.ts. One summary entry rather than one per client: an
    // 11,000-row import would otherwise bury every other action in the log.
    void recordAuditLog({
      action: 'clients.import_completed',
      entityTable: 'clients',
      entityLabel: fileName,
      summary: `Imported ${createdIds.length} client${createdIds.length === 1 ? '' : 's'} from ${fileName}`,
      metadata: {
        file: fileName,
        created: createdIds.length,
        failed: failed.length,
        skipped_duplicates: report.counts.duplicate,
        rejected: report.counts.error,
      },
    })

    if (failed.length) toast.warning(`${createdIds.length} imported, ${failed.length} failed.`)
    else toast.success(`${createdIds.length} clients imported.`)
  }

  /**
   * Reverse the import just performed, by soft-deleting exactly the rows it
   * created.
   *
   * Soft delete rather than a row DELETE for the same reasons the prospect
   * cleanup job uses it: `status = 'deleted'` is a value the column already
   * carries, it cannot orphan anything that has since been written against the
   * client, and — the part that matters here — the unique index is partial
   * (`WHERE status <> 'deleted'`), so undoing an import frees every company name
   * it claimed and the corrected file can simply be re-uploaded.
   *
   * Deliberately session-scoped: the list of ids lives in this page's state and
   * is gone once you navigate away. Persisting it would mean either 11,000 ids
   * in an audit log's metadata or a new column on `clients`, and neither is
   * worth it for a safety net whose whole job is to catch a mistake you have
   * just this moment noticed.
   */
  async function undoImport() {
    if (!outcome?.createdIds.length) return
    setUndoing(true)
    const supabase = createSupabaseClient()
    let reverted = 0

    for (let i = 0; i < outcome.createdIds.length; i += IMPORT_BATCH_SIZE) {
      const ids = outcome.createdIds.slice(i, i + IMPORT_BATCH_SIZE)
      const { error } = await supabase
        .from('clients')
        .update({
          status: 'deleted',
          inactive_reason: `Undone bulk import from ${fileName}`,
          updated_at: new Date().toISOString(),
        })
        .in('id', ids)
      if (error) {
        setUndoing(false)
        toast.error(`Undo stopped after ${reverted} clients: ${error.message}`)
        return
      }
      reverted += ids.length
    }

    setUndoing(false)
    setUndone(true)
    void recordAuditLog({
      action: 'clients.import_undone',
      entityTable: 'clients',
      entityLabel: fileName,
      summary: `Undid the import of ${reverted} client${reverted === 1 ? '' : 's'} from ${fileName}`,
      metadata: { file: fileName, reverted },
    })
    toast.success(`${reverted} imported clients removed.`)
  }

  function reset() {
    setPhase('idle')
    setReport(null)
    setOutcome(null)
    setFileName('')
    setUndone(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // --- render ---------------------------------------------------------------

  if (!profileLoading && !allowed) {
    return (
      <>
        <Header title="Import Clients" subtitle="Bulk upload" />
        <div className="p-6">
          <Alert variant="destructive">
            <ShieldAlert className="size-4" />
            <AlertDescription>
              Only a superadmin can bulk-import clients. You can still add clients one at a time
              from the Clients page.
            </AlertDescription>
          </Alert>
          <Button variant="outline" className="mt-4" onClick={() => router.push('/clients')}>
            <ArrowLeft className="size-4" /> Back to Clients
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <Header title="Import Clients" subtitle="Bulk upload from a spreadsheet" />

      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push('/clients')}>
            <ArrowLeft className="size-4" /> Clients
          </Button>
          <a
            href="/templates/client-import-template.xlsx"
            download
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Download className="size-4" /> Download the template
          </a>
        </div>

        {phase === 'idle' || phase === 'reading' ? (
          <UploadPanel
            phase={phase}
            inputRef={fileInputRef}
            onPick={handleFile}
            agentCount={agents.length}
            ready={agents.length > 0}
          />
        ) : null}

        {phase === 'idle' ? <RosterPanel agents={agents} /> : null}

        {report && (phase === 'reviewing' || phase === 'importing' || phase === 'done') ? (
          <>
            <FileSummary fileName={fileName} report={report} onReset={reset} phase={phase} />

            {report.fileErrors.length > 0 ? (
              <Alert variant="destructive">
                <XCircle className="size-4" />
                <AlertDescription>
                  <p className="font-semibold">This file cannot be used.</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    {report.fileErrors.map(e => <li key={e}>{e}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <CountCards counts={report.counts} active={filter} onSelect={setFilter} />

                {phase === 'reviewing' ? (
                  <ReviewActions report={report} onImport={runImport} />
                ) : null}

                {phase === 'importing' ? <ProgressPanel progress={progress} /> : null}

                {phase === 'done' && outcome ? (
                  <OutcomePanel
                    outcome={outcome}
                    undoing={undoing}
                    undone={undone}
                    onUndo={undoImport}
                    onReset={reset}
                    onViewClients={() => router.push('/clients')}
                  />
                ) : null}

                <RowTable rows={report.rows} filter={filter} />
              </>
            )}
          </>
        ) : null}
      </div>
    </>
  )
}

// --- pieces -----------------------------------------------------------------

function UploadPanel({
  phase, inputRef, onPick, agentCount, ready,
}: {
  phase: Phase
  inputRef: React.RefObject<HTMLInputElement | null>
  onPick: (file: File) => void
  agentCount: number
  /** False until the agent roster has loaded — see handleFile. */
  ready: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const busy = phase === 'reading'

  return (
    <Card>
      <CardContent className="p-0">
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            const file = e.dataTransfer.files?.[0]
            if (file && ready) onPick(file)
          }}
          className={cn(
            'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 text-center transition-colors',
            dragging ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          {busy ? (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Reading and checking the file…</p>
            </>
          ) : (
            <>
              <div className="rounded-full bg-primary/10 p-3">
                <FileSpreadsheet className="size-7 text-primary" />
              </div>
              <div>
                <p className="font-semibold">Drop the filled-in template here</p>
                <p className="text-sm text-muted-foreground">
                  .xlsx or .xls — nothing is saved until you review what it found.
                </p>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) onPick(file)
                }}
              />
              <Button onClick={() => inputRef.current?.click()} disabled={!ready}>
                <Upload className="size-4" /> Choose a file
              </Button>
              <p className="text-xs text-muted-foreground">
                {ready
                  ? `${agentCount} agents can currently be assigned clients.`
                  : 'Loading the agent list…'}
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The live agent roster, with a one-click copy for pasting into the template's
 * "Agents" sheet.
 *
 * The template ships with that sheet EMPTY, and this panel is why. The workbook
 * lives in `public/`, which is committed to a public repository — putting the
 * roster in the file would publish every agent's name and work address to
 * anyone who happens on the repo, permanently, because git keeps history. So
 * the file carries the structure and the app carries the people: the list is
 * only ever handed out to someone already signed in as a superadmin, and it
 * cannot go stale the way a generated snapshot would.
 *
 * Copied as TSV because that is what a spreadsheet pastes cleanly — three
 * columns landing in A/B/C, matching the sheet's own headers.
 */
function RosterPanel({ agents }: { agents: Profile[] }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const tsv = agents
      .map(a => [a.full_name, a.email ?? '', a.role].join('\t'))
      .join('\n')
    try {
      await navigator.clipboard.writeText(tsv)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success(`${agents.length} agents copied — paste into the Agents sheet at cell A2.`)
    } catch {
      toast.error('Could not reach the clipboard. Select the list below and copy it manually.')
    }
  }

  if (!agents.length) return null

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">Agent list</p>
            <p className="text-sm text-muted-foreground">
              The template&apos;s Agents sheet starts empty. Paste this into it at cell A2 and the
              agent_email dropdown starts working.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />}
            Copy agent list
          </Button>
        </div>
        <div className="max-h-56 overflow-y-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>agent_email</TableHead>
                <TableHead className="w-40">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map(a => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.full_name}</TableCell>
                  <TableCell className="font-mono text-xs">{a.email ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{a.role}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function FileSummary({
  fileName, report, onReset, phase,
}: { fileName: string; report: ImportReport; onReset: () => void; phase: Phase }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-semibold truncate">{fileName}</p>
          <p className="text-sm text-muted-foreground">{report.rows.length} data rows</p>
        </div>
      </div>
      {phase !== 'importing' ? (
        <Button variant="outline" size="sm" onClick={onReset}>Choose another file</Button>
      ) : null}
    </div>
  )
}

function CountCards({
  counts, active, onSelect,
}: {
  counts: Record<RowVerdict, number>
  active: RowVerdict | 'all'
  onSelect: (v: RowVerdict | 'all') => void
}) {
  const order: RowVerdict[] = ['ready', 'warning', 'duplicate', 'error']
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {order.map(verdict => {
        const Icon = VERDICT_ICON[verdict]
        const isActive = active === verdict
        return (
          <Card
            key={verdict}
            onClick={() => onSelect(isActive ? 'all' : verdict)}
            className={cn(
              'cursor-pointer transition-colors',
              isActive ? 'ring-2 ring-primary' : 'hover:bg-muted/40',
            )}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <Icon className={cn('size-5', TONE_TEXT[VERDICT_TONE[verdict]])} />
              <div>
                <p className={cn('text-2xl font-bold leading-none', TONE_TEXT[VERDICT_TONE[verdict]])}>
                  {counts[verdict]}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{VERDICT_LABEL[verdict]}</p>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function ReviewActions({ report, onImport }: { report: ImportReport; onImport: () => void }) {
  const willImport = report.importable.length
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="text-sm">
          <p className="font-semibold">
            {willImport === 0
              ? 'Nothing here can be imported yet.'
              : `${willImport} client${willImport === 1 ? '' : 's'} will be added.`}
          </p>
          <p className="text-muted-foreground">
            Existing clients are never changed — this only adds new records.
            {report.counts.error > 0
              ? ` ${report.counts.error} row${report.counts.error === 1 ? '' : 's'} will be left out; fix them in the file and upload again.`
              : ''}
          </p>
        </div>
        <Button onClick={onImport} disabled={willImport === 0}>
          <Upload className="size-4" /> Import {willImport > 0 ? willImport : ''} client{willImport === 1 ? '' : 's'}
        </Button>
      </CardContent>
    </Card>
  )
}

function ProgressPanel({ progress }: { progress: { done: number; total: number } }) {
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin" />
          Importing {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          Keep this tab open until it finishes.
        </p>
      </CardContent>
    </Card>
  )
}

function OutcomePanel({
  outcome, undoing, undone, onUndo, onReset, onViewClients,
}: {
  outcome: ImportOutcome
  undoing: boolean
  undone: boolean
  onUndo: () => void
  onReset: () => void
  onViewClients: () => void
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className={cn('size-5 mt-0.5', TONE_TEXT.brand)} />
          <div>
            <p className="font-semibold">
              {undone
                ? 'Import undone.'
                : `${outcome.createdIds.length.toLocaleString()} client${outcome.createdIds.length === 1 ? '' : 's'} imported.`}
            </p>
            {outcome.failed.length > 0 && !undone ? (
              <p className="text-sm text-muted-foreground">
                {outcome.failed.length} row{outcome.failed.length === 1 ? '' : 's'} were rejected by
                the database — listed below.
              </p>
            ) : null}
          </div>
        </div>

        {outcome.failed.length > 0 && !undone ? (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Row</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outcome.failed.slice(0, 50).map(f => (
                  <TableRow key={f.rowNumber}>
                    <TableCell className="text-muted-foreground">{f.rowNumber}</TableCell>
                    <TableCell className="font-medium">{f.companyName}</TableCell>
                    <TableCell className="text-sm">{f.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onViewClients}>View Clients</Button>
          <Button variant="outline" onClick={onReset}>Import another file</Button>
          {!undone && outcome.createdIds.length > 0 ? (
            <Button variant="outline" onClick={onUndo} disabled={undoing}>
              {undoing ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
              Undo this import
            </Button>
          ) : null}
        </div>

        {!undone && outcome.createdIds.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Undo removes exactly the {outcome.createdIds.length.toLocaleString()} clients this import
            created, and frees their names for re-upload. It is only available while you stay on this
            page.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RowTable({ rows, filter }: { rows: ImportRow[]; filter: RowVerdict | 'all' }) {
  const filtered = useMemo(
    () => (filter === 'all' ? rows.filter(r => r.issues.length > 0) : rows.filter(r => r.verdict === filter)),
    [rows, filter],
  )
  const { pageItems, page, pageCount, from, to, total, setPage } = usePagination(filtered, 25, filter)

  if (!filtered.length) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          {filter === 'all'
            ? 'Every row checked out cleanly — nothing needs your attention.'
            : `No rows in this category.`}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Row</TableHead>
              <TableHead className="w-44">Status</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>What we found</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.map(row => (
              <TableRow key={row.rowNumber}>
                <TableCell className="text-muted-foreground align-top">{row.rowNumber}</TableCell>
                <TableCell className="align-top">
                  <Badge variant="tone" className={TONE_CLASS[VERDICT_TONE[row.verdict]]}>
                    {VERDICT_LABEL[row.verdict]}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium align-top">
                  {row.companyName || <span className="text-muted-foreground">(blank)</span>}
                </TableCell>
                <TableCell className="align-top">
                  <ul className="space-y-1">
                    {row.issues.map((issue, i) => (
                      <li key={i} className="text-sm">
                        {issue.field ? (
                          <span className="font-mono text-xs text-muted-foreground">{issue.field}: </span>
                        ) : null}
                        <span className={issue.severity === 'error' ? TONE_TEXT.red : undefined}>
                          {issue.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {pageCount > 1 ? (
          <div className="border-t border-border p-3">
            <Pagination
              page={page} pageCount={pageCount} from={from} to={to} total={total} onPageChange={setPage}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
