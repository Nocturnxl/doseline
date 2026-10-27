import { useMemo, useState, type CSSProperties } from 'react'
import { Plus } from 'lucide-react'
import type { Medication } from '../../../core/types'
import { computeNextDue, describeSchedule } from '../../../core/schedule'
import { doseLine } from '../../../core/calendar'
import { inventoryStatus } from '../../../core/inventory'
import { useNow, useSnapshot } from '../lib/store'
import { fmtWhen } from '../lib/format'
import { MedBadge } from '../components/MedIcon'
import { EmptyArt } from '../components/EmptyArt'
import { MedEditor } from './MedEditor'

export function MedsPage() {
  const snap = useSnapshot()
  const now = useNow(30_000)
  const [editing, setEditing] = useState<Medication | null | 'new'>(null)
  const sorted = useMemo(() => [...snap.meds].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)), [snap.meds])
  const editingMed = editing === 'new' ? null : editing ? (snap.meds.find((m) => m.id === editing.id) ?? null) : null

  return (
    <div className="page">
      <div className="page-header">
        <div className="titles">
          <h1>Medications</h1>
          <p>
            {snap.meds.filter((m) => m.active).length} active
            {snap.meds.some((m) => !m.active) ? ` · ${snap.meds.filter((m) => !m.active).length} paused` : ''}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus />
          Add medication
        </button>
      </div>
      {snap.meds.length === 0 ? (
        <div className="card">
          <div className="empty">
            <EmptyArt />
            <h2>No medications yet</h2>
            <p>Add what you take, how much, and when. Doseline handles the reminders.</p>
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setEditing('new')}>
              <Plus />
              Add medication
            </button>
          </div>
        </div>
      ) : (
        <div className="med-grid">
          {sorted.map((m) => {
            const next = computeNextDue(m, snap.logs, now, snap.zone)
            const inv = inventoryStatus(m, snap.logs, now)
            return (
              <button key={m.id} className={`card med-card${m.active ? '' : ' paused'}`} onClick={() => setEditing(m)} style={{ '--med': m.color } as CSSProperties}>
                <div className="top">
                  <MedBadge icon={m.icon} color={m.color} size={42} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="title">{m.name}</div>
                    <div className="small muted">{doseLine(m)}</div>
                  </div>
                  {!m.active && <span className="pill paused">Paused</span>}
                  {m.active && inv?.low && <span className="pill warn">Refill</span>}
                </div>
                <div className="small muted">
                  {describeSchedule(m)}
                  {m.instructions ? ` · ${m.instructions}` : ''}
                </div>
                <div className="facts">
                  <div>
                    <div className="k">{m.schedule.type === 'prn' ? 'Available' : 'Next dose'}</div>
                    <div className="v num">{!m.active ? '—' : next ? (next.dueAt <= now ? 'Now' : fmtWhen(next.dueAt, snap.zone, now)) : m.schedule.type === 'prn' ? 'Now' : 'Course ended'}</div>
                  </div>
                  <div>
                    <div className="k">Supply</div>
                    <div className="v num">{inv ? (inv.daysOfSupply != null ? `${inv.count} left · ${Math.floor(inv.daysOfSupply)} days` : `${inv.count} left`) : 'Not tracked'}</div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
      {editing && <MedEditor med={editingMed} onClose={() => setEditing(null)} />}
    </div>
  )
}
