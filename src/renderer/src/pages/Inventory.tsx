import { useState, type CSSProperties } from 'react'
import { PackagePlus, TriangleAlert } from 'lucide-react'
import type { Medication } from '../../../core/types'
import { inventoryStatus } from '../../../core/inventory'
import { api, useNow, useSnapshot, useToasts } from '../lib/store'
import { fmtDate, unitLabel } from '../lib/format'
import { MedBadge } from '../components/MedIcon'
import { Field, Modal, Segmented } from '../components/ui'
import { EmptyArt } from '../components/EmptyArt'
import { MedEditor } from './MedEditor'

export function InventoryPage() {
  const snap = useSnapshot()
  const now = useNow(60_000)
  const [refilling, setRefilling] = useState<Medication | null>(null)
  const [editing, setEditing] = useState<Medication | null>(null)
  const tracked = snap.meds.filter((m) => m.inventory)
  const untracked = snap.meds.filter((m) => !m.inventory)
  const rows = tracked
    .map((m) => ({ m, s: inventoryStatus(m, snap.logs, now)! }))
    .sort((a, b) => Number(b.s.low) - Number(a.s.low) || (a.s.daysOfSupply ?? 1e9) - (b.s.daysOfSupply ?? 1e9))
  const low = rows.filter((r) => r.s.low && r.m.active)

  return (
    <div className="page">
      <div className="page-header">
        <div className="titles">
          <h1>Inventory</h1>
          <p>{tracked.length ? `${tracked.length} tracked · ${low.length} need${low.length === 1 ? 's' : ''} a refill` : 'Track how much you have left and get a heads-up before you run out.'}</p>
        </div>
      </div>

      {low.length > 0 && (
        <div className="missed-banner">
          <TriangleAlert />
          <div style={{ flex: 1 }}>
            <h3>Time to refill</h3>
            <p className="small muted" style={{ marginTop: 2 }}>
              {low.map((r) => r.m.name).join(', ')} {low.length === 1 ? 'is' : 'are'} at or below the refill level.
            </p>
          </div>
        </div>
      )}

      {tracked.length === 0 ? (
        <div className="card">
          <div className="empty">
            <EmptyArt variant="box" />
            <h2>No inventory tracked yet</h2>
            <p>Turn on "Track inventory" for a medication. Each dose you log counts down automatically, and Undo puts it back.</p>
          </div>
        </div>
      ) : (
        <div className="card">
          {rows.map(({ m, s }) => {
            const cap = Math.max(m.inventory!.refillThreshold * 4, s.count, 1)
            return (
              <div className="inv-row" key={m.id} style={{ '--med': s.low ? 'var(--warning)' : m.color } as CSSProperties}>
                <MedBadge icon={m.icon} color={m.color} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 580 }}>
                    {m.name} <span className="muted" style={{ fontWeight: 450 }}>{m.strength}</span>
                  </div>
                  <div className="small subtle">
                    {m.inventory!.unitsPerDose} {unitLabel(m.doseUnit, m.inventory!.unitsPerDose)} per dose · alert at {m.inventory!.refillThreshold}
                  </div>
                </div>
                <div>
                  <div className="progress">
                    <span style={{ width: `${Math.min(100, (s.count / cap) * 100)}%` }} />
                  </div>
                  <div className="tiny subtle num" style={{ marginTop: 6 }}>
                    {s.dosesRemaining} doses left
                  </div>
                </div>
                <div>
                  <div className="big">{s.count}</div>
                  <div className="tiny subtle">{unitLabel(m.doseUnit, s.count)} on hand</div>
                </div>
                <div>
                  <div className="big">{s.daysOfSupply != null ? Math.floor(s.daysOfSupply) : '—'}</div>
                  <div className="tiny subtle">{s.runOutDate ? `days · out ${fmtDate(s.runOutDate, snap.zone, { month: 'short', day: 'numeric' })}` : 'days of supply'}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {s.low && <span className="pill warn">Low</span>}
                  <button className="btn btn-sm" onClick={() => setRefilling(m)}>
                    <PackagePlus />
                    Refill
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {untracked.length > 0 && tracked.length > 0 && (
        <p className="small subtle" style={{ marginTop: 14 }}>
          Not tracked:{' '}
          {untracked.map((m, i) => (
            <span key={m.id}>
              {i > 0 ? ', ' : ''}
              <button className="link" onClick={() => setEditing(m)}>
                {m.name}
              </button>
            </span>
          ))}
        </p>
      )}
      {refilling && <RefillDialog med={refilling} onClose={() => setRefilling(null)} />}
      {editing && <MedEditor med={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RefillDialog({ med, onClose }: { med: Medication; onClose: () => void }) {
  const { push } = useToasts()
  const [mode, setMode] = useState<'add' | 'set'>('add')
  const [value, setValue] = useState('30')
  const current = med.inventory!.count
  const n = Number(value)
  const next = mode === 'add' ? current + n : n
  const valid = Number.isFinite(n) && n >= 0 && value !== ''
  const save = async () => {
    const r = await api.adjustInventory(med.id, next)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else {
      push({ kind: 'success', message: `${med.name}: ${next} ${unitLabel(med.doseUnit, next)} on hand` })
      onClose()
    }
  }
  return (
    <Modal
      title={`Refill ${med.name}`}
      icon={<MedBadge icon={med.icon} color={med.color} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => void save()}>
            Update count
          </button>
        </>
      }
    >
      <Segmented
        block
        label="Refill mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'add', label: 'Add units' },
          { value: 'set', label: 'Set count' },
        ]}
      />
      <Field label={mode === 'add' ? 'Units received' : 'Units on hand'} htmlFor="r-n" hint={valid ? `New count: ${next} (currently ${current})` : `Currently ${current}`}>
        <input id="r-n" type="number" min="0" className="input num" value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
      </Field>
    </Modal>
  )
}
