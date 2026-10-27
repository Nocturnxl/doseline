import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { ClockArrowLeft, TriangleAlert } from 'lucide-react'
import type { Medication, SafetyWarning } from '../../../core/types'
import { api, useSnapshot, useToasts } from '../lib/store'
import { fmtTime, fromLocalInput, toLocalInput } from '../lib/format'
import { Modal } from './ui'
import { MedBadge } from './MedIcon'

interface DoseActionsApi {
  take: (med: Medication, at?: Date) => Promise<void>
  skip: (med: Medication) => Promise<void>
  backdate: (med: Medication, suggested?: Date) => void
}

const Ctx = createContext<DoseActionsApi | null>(null)

export function useDoseActions(): DoseActionsApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('DoseActionsProvider missing')
  return c
}

/** Owns the logging UX: safety-warning confirmation, backdating, and the 10-second Undo toast. */
export function DoseActionsProvider({ children }: { children: ReactNode }) {
  const snap = useSnapshot()
  const { push } = useToasts()
  const [confirm, setConfirm] = useState<{ med: Medication; at?: Date; warnings: SafetyWarning[] } | null>(null)
  const [backdating, setBackdating] = useState<{ med: Medication; suggested?: Date } | null>(null)

  const commit = useCallback(
    async (med: Medication, kind: 'taken' | 'skipped', at?: Date) => {
      const r = await api.logDose({ medicationId: med.id, kind, at: at?.toISOString() })
      if (!r.ok) {
        push({ kind: 'error', message: r.error })
        return
      }
      const verb = kind === 'taken' ? 'Logged' : 'Skipped'
      const when = kind === 'taken' ? ` at ${fmtTime(r.value.log.takenAt, snap.zone)}` : ''
      push({
        kind: 'success',
        message: `${verb} ${med.name}${when}`,
        duration: 10_000,
        action: {
          label: 'Undo',
          run: () =>
            void api.undo(r.value.undoToken).then((u) => {
              if (!u.ok) push({ kind: 'error', message: u.error })
              else if (!u.value) push({ kind: 'info', message: 'Too late to undo. Edit it in History instead.' })
              else push({ kind: 'info', message: `Undid ${med.name}` })
            }),
        },
      })
    },
    [push, snap.zone],
  )

  const take = useCallback(
    async (med: Medication, at?: Date) => {
      const warnings = await api.previewWarnings(med.id, at?.toISOString())
      if (warnings.length) setConfirm({ med, at, warnings })
      else await commit(med, 'taken', at)
    },
    [commit],
  )

  const skip = useCallback((med: Medication) => commit(med, 'skipped'), [commit])
  const backdate = useCallback((med: Medication, suggested?: Date) => setBackdating({ med, suggested }), [])
  const value = useMemo(() => ({ take, skip, backdate }), [take, skip, backdate])

  return (
    <Ctx.Provider value={value}>
      {children}
      {confirm && (
        <Modal
          title="Log this dose anyway?"
          icon={
            <span className="med-badge" style={{ '--med': 'var(--warning)', '--size': '36px' } as React.CSSProperties}>
              <TriangleAlert />
            </span>
          }
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)} data-autofocus>
                Don't log
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const c = confirm
                  setConfirm(null)
                  void commit(c.med, 'taken', c.at)
                }}
              >
                Log anyway
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            {confirm.warnings.map((w) => (
              <div key={w.code} className="callout warn">
                <TriangleAlert />
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {backdating && (
        <BackdateDialog
          med={backdating.med}
          suggested={backdating.suggested}
          zone={snap.zone}
          onClose={() => setBackdating(null)}
          onSubmit={(at) => {
            const m = backdating.med
            setBackdating(null)
            void take(m, at)
          }}
        />
      )}
    </Ctx.Provider>
  )
}

function BackdateDialog({ med, suggested, zone, onClose, onSubmit }: { med: Medication; suggested?: Date; zone: string; onClose: () => void; onSubmit: (at: Date) => void }) {
  const now = new Date()
  const initial = suggested && suggested < now ? suggested : new Date(now.getTime() - 15 * 60_000)
  const [value, setValue] = useState(toLocalInput(initial, zone))
  const parsed = fromLocalInput(value)
  const invalid = Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now() + 60_000
  const quick: { label: string; at: Date }[] = [
    ...(suggested && suggested < now ? [{ label: 'At due time', at: suggested }] : []),
    { label: '15 min ago', at: new Date(now.getTime() - 15 * 60_000) },
    { label: '30 min ago', at: new Date(now.getTime() - 30 * 60_000) },
    { label: '1 hour ago', at: new Date(now.getTime() - 60 * 60_000) },
    { label: '2 hours ago', at: new Date(now.getTime() - 120 * 60_000) },
  ]
  return (
    <Modal
      title={`When did you take ${med.name}?`}
      icon={<MedBadge icon={med.icon} color={med.color} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={invalid} onClick={() => onSubmit(parsed)}>
            <ClockArrowLeft />
            Log dose
          </button>
        </>
      }
    >
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {quick.map((q) => (
          <button key={q.label} className="btn btn-sm" onClick={() => setValue(toLocalInput(q.at, zone))}>
            {q.label}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="backdate">Date and time</label>
        <input id="backdate" type="datetime-local" className={`input${invalid ? ' invalid' : ''}`} value={value} max={toLocalInput(new Date(), zone)} onChange={(e) => setValue(e.target.value)} data-autofocus />
        {invalid ? <span className="field-error">Pick a time in the past.</span> : <span className="field-hint">The schedule recalculates from this time.</span>}
      </div>
    </Modal>
  )
}
