import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, CornerDownLeft, Search, TriangleAlert } from 'lucide-react'
import type { SafetyWarning } from '../../../core/types'
import { upNext } from '../../../core/today'
import { doseLine } from '../../../core/calendar'
import { api, useNow, useSnapshot } from '../lib/store'
import { fmtWhen } from '../lib/format'
import { MedBadge } from '../components/MedIcon'

/** Global quick-log palette (Ctrl+Alt+M by default): type to filter, Enter to log. */
export function PaletteApp() {
  const snap = useSnapshot()
  const now = useNow(15_000)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [pending, setPending] = useState<{ id: string; warnings: SafetyWarning[] } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      api.onPaletteOpen(() => {
        setQ('')
        setSel(0)
        setPending(null)
        setDone(null)
        setError(null)
        setTimeout(() => input.current?.focus(), 10)
      }),
    [],
  )
  useEffect(() => input.current?.focus(), [])

  const items = useMemo(() => {
    const all = upNext(snap.meds, snap.logs, now, snap.zone, snap.settings.graceMinutes)
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all
      .map((i) => {
        const name = i.med.name.toLowerCase()
        const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : `${i.med.strength} ${i.med.notes}`.toLowerCase().includes(needle) ? 2 : -1
        return { i, score }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.i)
  }, [snap, now, q])

  const close = () => api.paletteClose()

  const log = async (force = false) => {
    const item = items[sel]
    if (!item) return
    setError(null)
    if (!force) {
      const w = await api.previewWarnings(item.med.id)
      if (w.length) {
        setPending({ id: item.med.id, warnings: w })
        return
      }
    }
    const r = await api.logDose({ medicationId: item.med.id, kind: 'taken' })
    if (!r.ok) {
      setError(r.error)
      return
    }
    setPending(null)
    setDone(item.med.name)
    setTimeout(close, 900)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (pending) setPending(null)
      else close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setPending(null)
      setSel((s) => Math.min(items.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setPending(null)
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void log(!!pending && pending.id === items[sel]?.med.id)
    }
  }

  return (
    <div className="palette-wrap" onKeyDown={onKey}>
      <div className="palette" role="dialog" aria-label="Quick log">
        {done ? (
          <div className="palette-done">
            <span className="ok">
              <Check size={28} />
            </span>
            <div style={{ fontWeight: 600, fontSize: 16 }}>Logged {done}</div>
            <div className="small muted">You can edit or remove it in History.</div>
          </div>
        ) : (
          <>
            <div className="palette-search">
              <Search size={18} />
              <input
                ref={input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setSel(0)
                  setPending(null)
                }}
                placeholder="Log a dose…"
                aria-label="Search medications"
                aria-controls="palette-list"
                aria-activedescendant={items[sel] ? `pi-${items[sel]!.med.id}` : undefined}
                spellCheck={false}
              />
              <span className="kbd">Esc</span>
            </div>
            <div className="palette-list" id="palette-list" role="listbox">
              {items.length === 0 && <div className="palette-empty small muted">{snap.meds.length ? 'No matching medication' : 'No medications yet. Add one in Doseline.'}</div>}
              {items.map((i, idx) => (
                <div
                  key={i.med.id}
                  id={`pi-${i.med.id}`}
                  role="option"
                  aria-selected={idx === sel}
                  className="palette-item"
                  onMouseEnter={() => setSel(idx)}
                  onClick={() => {
                    setSel(idx)
                    void log(!!pending && pending.id === i.med.id)
                  }}
                  style={{ '--med': i.med.color } as CSSProperties}
                >
                  <MedBadge icon={i.med.icon} color={i.med.color} size={32} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 580 }}>
                      {i.med.name} <span className="muted" style={{ fontWeight: 450 }}>{i.med.strength}</span>
                    </div>
                    <div className="tiny subtle">{doseLine(i.med)}</div>
                  </div>
                  <div className="tiny num" style={{ textAlign: 'right', color: i.status === 'overdue' ? 'var(--danger)' : 'var(--text-2)' }}>
                    {i.status === 'available' ? 'Available now' : i.next ? (i.next.dueAt <= now ? (i.status === 'overdue' ? 'Overdue' : 'Due now') : fmtWhen(i.next.dueAt, snap.zone, now)) : ''}
                  </div>
                  {idx === sel && <CornerDownLeft size={15} className="subtle" />}
                </div>
              ))}
            </div>
            {pending && (
              <div className="palette-warn">
                <TriangleAlert size={16} />
                <div style={{ flex: 1 }}>
                  {pending.warnings.map((w) => (
                    <div key={w.code}>{w.message}</div>
                  ))}
                  <div className="tiny" style={{ marginTop: 4, opacity: 0.8 }}>
                    Press Enter again to log anyway, or Esc to cancel.
                  </div>
                </div>
              </div>
            )}
            {error && <div className="palette-warn">{error}</div>}
            <div className="palette-foot tiny subtle">
              <span>
                <span className="kbd">↑</span> <span className="kbd">↓</span> to choose
              </span>
              <span>
                <span className="kbd">Enter</span> to log as taken now
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
