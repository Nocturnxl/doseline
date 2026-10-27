import { useMemo, useState } from 'react'
import { BellRing, Ellipsis, FileDown, FileText, Pencil, Trash } from 'lucide-react'
import type { DoseKind, DoseLog } from '../../../core/types'
import { MINUTE, addLocalDays, endOfLocalDate, localDateKey, startOfLocalDate, startOfLocalDay } from '../../../core/time'
import { api, useSnapshot, useToasts } from '../lib/store'
import { fmtDate, fmtTime, fromLocalInput, plural, toLocalInput } from '../lib/format'
import { MedChip } from '../components/MedIcon'
import { ConfirmDialog, Field, MenuButton, Modal, Segmented } from '../components/ui'
import { EmptyArt } from '../components/EmptyArt'

function offsetLabel(l: DoseLog): { text: string; tone: 'ok' | 'late' | 'early' } | null {
  if (!l.scheduledFor || l.kind !== 'taken') return null
  const diff = Math.round((new Date(l.takenAt).getTime() - new Date(l.scheduledFor).getTime()) / MINUTE)
  if (Math.abs(diff) < 2) return { text: 'On time', tone: 'ok' }
  const abs = Math.abs(diff)
  const t = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60 ? `${abs % 60} m` : ''}`.trim() : `${abs} min`
  return { text: diff > 0 ? `${t} late` : `${t} early`, tone: diff > 0 ? 'late' : 'early' }
}

export function HistoryPage() {
  const snap = useSnapshot()
  const { push } = useToasts()
  const { zone } = snap
  const today = localDateKey(new Date(), zone)
  const [medId, setMedId] = useState('')
  const [from, setFrom] = useState(localDateKey(addLocalDays(startOfLocalDay(new Date(), zone), -29, zone), zone))
  const [to, setTo] = useState(today)
  const [kind, setKind] = useState<'all' | DoseKind>('all')
  const [editing, setEditing] = useState<DoseLog | null>(null)
  const [deleting, setDeleting] = useState<DoseLog | null>(null)
  const meds = useMemo(() => new Map(snap.meds.map((m) => [m.id, m])), [snap.meds])

  const range = useMemo(() => ({ from: from ? startOfLocalDate(from, zone) : undefined, to: to ? new Date(endOfLocalDate(to, zone).getTime() + 1) : undefined }), [from, to, zone])
  const filtered = useMemo(
    () =>
      snap.logs
        .filter((l) => (!medId || l.medicationId === medId) && (kind === 'all' || l.kind === kind))
        .filter((l) => {
          const t = new Date(l.takenAt)
          return (!range.from || t >= range.from) && (!range.to || t < range.to)
        })
        .sort((a, b) => b.takenAt.localeCompare(a.takenAt)),
    [snap.logs, medId, kind, range],
  )
  const groups = useMemo(() => {
    const g = new Map<string, DoseLog[]>()
    for (const l of filtered) {
      const k = localDateKey(new Date(l.takenAt), zone)
      g.set(k, [...(g.get(k) ?? []), l])
    }
    return [...g.entries()]
  }, [filtered, zone])

  const exportRange = { from: range.from?.toISOString(), to: range.to?.toISOString(), medicationId: medId || undefined }
  const doCsv = async () => {
    const r = await api.exportCsv(exportRange)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else if (r.value) push({ kind: 'success', message: 'History exported as CSV' })
  }
  const doPdf = async () => {
    const r = await api.exportPdf(exportRange)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else if (r.value) push({ kind: 'success', message: 'Report saved as PDF' })
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="titles">
          <h1>History</h1>
          <p>{plural(filtered.length, 'entry', 'entries')} in range</p>
        </div>
        <button className="btn" onClick={() => void doCsv()} disabled={!snap.logs.length}>
          <FileDown />
          Export CSV
        </button>
        <button className="btn" onClick={() => void doPdf()} disabled={!snap.meds.length}>
          <FileText />
          Doctor report (PDF)
        </button>
      </div>

      <div className="filters">
        <Field label="Medication" htmlFor="h-med">
          <select id="h-med" className="select" value={medId} onChange={(e) => setMedId(e.target.value)}>
            <option value="">All medications</option>
            {snap.meds.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From" htmlFor="h-from">
          <input id="h-from" type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="h-to">
          <input id="h-to" type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="field" style={{ width: 'auto' }}>
          <span className="field-label">Show</span>
          <Segmented
            label="Entry type"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'All' },
              { value: 'taken', label: 'Taken' },
              { value: 'skipped', label: 'Skipped' },
            ]}
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="card">
          <div className="empty">
            <EmptyArt variant="history" />
            <h2>{snap.logs.length ? 'Nothing in this range' : 'No doses logged yet'}</h2>
            <p>{snap.logs.length ? 'Try widening the dates or clearing the filters.' : 'Every dose you take or skip will show up here, ready to export for your doctor.'}</p>
          </div>
        </div>
      ) : (
        groups.map(([day, logs]) => (
          <section className="day-group" key={day}>
            <div className="day-head">
              <h3>{day === today ? 'Today' : fmtDate(startOfLocalDate(day, zone), zone)}</h3>
              <span className="subtle small">{logs.filter((l) => l.kind === 'taken').length} taken</span>
            </div>
            <div className="card">
              {logs.map((l) => {
                const m = meds.get(l.medicationId)
                const off = offsetLabel(l)
                return (
                  <div className="log-row" key={l.id}>
                    <time className="num">{fmtTime(l.takenAt, zone)}</time>
                    {m ? <MedChip name={m.name} color={m.color} strength={m.strength} /> : <span className="muted">Deleted medication</span>}
                    <span className="log-status">
                      <span className={`pill ${l.kind}`}>{l.kind === 'taken' ? 'Taken' : 'Skipped'}</span>
                      {l.escalatedAt && (
                        <span
                          className="pill overdue"
                          title={`Overdue alert started ${fmtTime(l.escalatedAt, zone)}${l.escalationRepeats ? ` and repeated ${plural(l.escalationRepeats, 'time')}` : ''}`}
                        >
                          <BellRing />
                          {l.escalationRepeats ? `Escalated ×${l.escalationRepeats + 1}` : 'Escalated'}
                        </span>
                      )}
                    </span>
                    <span className="small" style={{ color: off?.tone === 'late' ? 'var(--warning)' : 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {off ? `${off.text} · due ${fmtTime(l.scheduledFor!, zone)}` : l.kind === 'skipped' && l.scheduledFor ? `Dose due ${fmtTime(l.scheduledFor, zone)}` : m?.schedule.type === 'prn' ? 'As needed' : ''}
                      {l.note ? ` · ${l.note}` : ''}
                    </span>
                    <MenuButton
                      label="Entry actions"
                      items={[
                        { label: 'Edit entry', icon: <Pencil />, onSelect: () => setEditing(l) },
                        { label: 'Delete entry', icon: <Trash />, danger: true, onSelect: () => setDeleting(l) },
                      ]}
                    >
                      <Ellipsis />
                    </MenuButton>
                  </div>
                )
              })}
            </div>
          </section>
        ))
      )}

      {editing && <EditLogDialog log={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete this entry?"
          body={`The ${deleting.kind === 'taken' ? 'dose' : 'skip'} at ${fmtTime(deleting.takenAt, zone)} will be removed${deleting.inventoryDelta > 0 ? ' and its units returned to inventory' : ''}. Reminders recalculate if this was the latest dose.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting
            setDeleting(null)
            void api.deleteLog(d.id).then((r) => (r.ok ? push({ kind: 'info', message: 'Entry deleted' }) : push({ kind: 'error', message: r.error })))
          }}
        />
      )}
    </div>
  )
}

function EditLogDialog({ log, onClose }: { log: DoseLog; onClose: () => void }) {
  const { zone, meds } = useSnapshot()
  const { push } = useToasts()
  const med = meds.find((m) => m.id === log.medicationId)
  const [when, setWhen] = useState(toLocalInput(new Date(log.takenAt), zone))
  const [kind, setKind] = useState<DoseKind>(log.kind)
  const [note, setNote] = useState(log.note ?? '')
  const parsed = fromLocalInput(when)
  const invalid = Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now() + 60_000
  const save = async () => {
    const r = await api.updateLog(log.id, { takenAt: parsed.toISOString(), kind, note })
    if (!r.ok) push({ kind: 'error', message: r.error })
    else {
      push({ kind: 'success', message: 'Entry updated' })
      onClose()
    }
  }
  return (
    <Modal
      title={`Edit ${med?.name ?? 'entry'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={invalid} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <Field label="Status">
        <Segmented
          block
          label="Status"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'taken', label: 'Taken' },
            ...(med?.schedule.type === 'prn' && log.kind === 'taken' ? [] : [{ value: 'skipped' as const, label: 'Skipped' }]),
          ]}
        />
      </Field>
      <Field label={kind === 'taken' ? 'Taken at' : 'Recorded at'} htmlFor="e-when" error={invalid ? 'Pick a time in the past.' : null}>
        <input id="e-when" type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} data-autofocus />
      </Field>
      <Field label="Note" htmlFor="e-note">
        <input id="e-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </Field>
    </Modal>
  )
}
