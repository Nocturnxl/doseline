import type { DoseKind, DoseLog, Medication, SafetyWarning, Settings } from './types'
import type { Clock, Repository } from './ports'
import { assignScheduledFor, computeNextDue } from './schedule'
import { checkSafety } from './safety'
import { consumeInventory, restoreInventory } from './inventory'
import { validateMedication } from './validation'
import { stampLog } from './escalation'
import { mergeSettings, type SettingsPatch } from './settings'

export interface ServiceDeps {
  repo: Repository
  clock: Clock
  zone: () => string
  newId: () => string
  /** Called after any change that affects schedules: callers resync calendar + reschedule alarms. */
  onChanged: (medicationIds: string[]) => void | Promise<void>
}

export interface LogRequest {
  medicationId: string
  kind: DoseKind
  /** When the dose was taken; defaults to now. Ignored for skips (a skip is recorded now). */
  at?: Date
  note?: string
}

export interface LogResult {
  log: DoseLog
  warnings: SafetyWarning[]
  undoToken: string
}

interface UndoEntry {
  token: string
  logId: string
  medicationId: string
  inventoryDelta: number
  expiresAt: number
}

export const UNDO_WINDOW_MS = 10_000
/** Extra slack so a click on the toast's last second still works. */
const UNDO_GRACE_MS = 5_000

export class DoseService {
  private lastAction: UndoEntry | null = null

  constructor(private deps: ServiceDeps) {}

  private now(): Date {
    return this.deps.clock.now()
  }

  private async requireMed(id: string): Promise<Medication> {
    const med = await this.deps.repo.getMedication(id)
    if (!med) throw new Error('Medication not found')
    return med
  }

  /** Warnings that logging now (or at `at`) would trigger, without logging. */
  async previewWarnings(medicationId: string, at?: Date): Promise<SafetyWarning[]> {
    const med = await this.requireMed(medicationId)
    const logs = await this.deps.repo.listLogs({ medicationId })
    return checkSafety(med, logs, at ?? this.now(), this.deps.zone())
  }

  async logDose(req: LogRequest): Promise<LogResult> {
    const { repo, zone } = this.deps
    const med = await this.requireMed(req.medicationId)
    const now = this.now()
    const tz = zone()
    const logs = await repo.listLogs({ medicationId: med.id })
    let at = req.kind === 'skipped' ? now : (req.at ?? now)
    if (at > now) at = now // can't take a dose in the future

    let scheduledFor: Date | null
    if (req.kind === 'skipped') {
      if (med.schedule.type === 'prn') throw new Error('As-needed medications cannot be skipped')
      const next = computeNextDue(med, logs, now, tz)
      if (!next) throw new Error('Nothing is scheduled to skip')
      scheduledFor = next.dueAt
    } else {
      scheduledFor = assignScheduledFor(med, logs, at, tz)
    }

    const warnings = req.kind === 'taken' ? checkSafety(med, logs, at, tz) : []
    let delta = 0
    if (req.kind === 'taken') {
      const consumed = consumeInventory(med)
      delta = consumed.delta
      if (delta > 0) await repo.saveMedication({ ...consumed.med, updatedAt: now.toISOString() })
    }
    const draft: DoseLog = {
      id: this.deps.newId(),
      medicationId: med.id,
      kind: req.kind,
      takenAt: at.toISOString(),
      scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
      inventoryDelta: delta,
      note: req.note,
      createdAt: now.toISOString(),
    }
    // If this dose had escalated, keep that in its history (adherence then counts it as late).
    const log = stampLog(draft, await repo.listEscalations())
    await repo.saveLog(log)
    const token = this.deps.newId()
    this.lastAction = { token, logId: log.id, medicationId: med.id, inventoryDelta: delta, expiresAt: now.getTime() + UNDO_WINDOW_MS }
    await this.deps.onChanged([med.id])
    return { log, warnings, undoToken: token }
  }

  /** Undo the most recent log action: removes the log and restores inventory, then resyncs. */
  async undo(token: string): Promise<boolean> {
    const a = this.lastAction
    if (!a || a.token !== token) return false
    if (this.now().getTime() > a.expiresAt + UNDO_GRACE_MS) {
      this.lastAction = null
      return false
    }
    this.lastAction = null
    const { repo } = this.deps
    const log = await repo.getLog(a.logId)
    if (log) await repo.deleteLog(log.id)
    const med = await repo.getMedication(a.medicationId)
    if (med && a.inventoryDelta > 0) await repo.saveMedication({ ...restoreInventory(med, a.inventoryDelta), updatedAt: this.now().toISOString() })
    await this.deps.onChanged([a.medicationId])
    return true
  }

  canUndo(token: string): boolean {
    return !!this.lastAction && this.lastAction.token === token && this.now().getTime() <= this.lastAction.expiresAt + UNDO_GRACE_MS
  }

  /** Edit a history entry. Re-derives the slot it fulfils; inventory is unaffected unless the kind changes. */
  async updateLog(id: string, patch: { takenAt?: string; kind?: DoseKind; note?: string }): Promise<DoseLog> {
    const { repo, zone } = this.deps
    const existing = await repo.getLog(id)
    if (!existing) throw new Error('Log entry not found')
    let med = await this.requireMed(existing.medicationId)
    const others = (await repo.listLogs({ medicationId: med.id })).filter((l) => l.id !== id)
    const kind = patch.kind ?? existing.kind
    let takenAt = patch.takenAt ? new Date(patch.takenAt) : new Date(existing.takenAt)
    if (takenAt > this.now()) takenAt = this.now()
    let delta = existing.inventoryDelta
    if (kind !== existing.kind) {
      if (kind === 'skipped' && delta > 0) {
        med = restoreInventory(med, delta)
        delta = 0
      } else if (kind === 'taken') {
        const c = consumeInventory(med)
        med = c.med
        delta = c.delta
      }
      await repo.saveMedication({ ...med, updatedAt: this.now().toISOString() })
    }
    const timeChanged = takenAt.getTime() !== new Date(existing.takenAt).getTime()
    let scheduledFor = existing.scheduledFor ?? null
    if (timeChanged && med.schedule.type !== 'prn') {
      const s = assignScheduledFor(med, others, takenAt, zone())
      scheduledFor = s ? s.toISOString() : null
    }
    const updated: DoseLog = { ...existing, kind, takenAt: takenAt.toISOString(), scheduledFor, inventoryDelta: delta, note: patch.note ?? existing.note }
    await repo.saveLog(updated)
    await this.deps.onChanged([med.id])
    return updated
  }

  async deleteLog(id: string): Promise<void> {
    const { repo } = this.deps
    const log = await repo.getLog(id)
    if (!log) return
    await repo.deleteLog(id)
    const med = await repo.getMedication(log.medicationId)
    if (med && log.inventoryDelta > 0) await repo.saveMedication({ ...restoreInventory(med, log.inventoryDelta), updatedAt: this.now().toISOString() })
    if (this.lastAction?.logId === id) this.lastAction = null
    await this.deps.onChanged([log.medicationId])
  }

  async saveMedication(input: Omit<Medication, 'id' | 'createdAt' | 'updatedAt' | 'pauses'> & Partial<Pick<Medication, 'id' | 'createdAt' | 'pauses'>>): Promise<Medication> {
    const { repo } = this.deps
    const now = this.now().toISOString()
    const prev = input.id ? await repo.getMedication(input.id) : null
    const med: Medication = {
      ...input,
      id: prev?.id ?? input.id ?? this.deps.newId(),
      createdAt: prev?.createdAt ?? input.createdAt ?? now,
      pauses: prev?.pauses ?? input.pauses ?? [],
      updatedAt: now,
    }
    // Interval meds with no history: the first dose defaults to "now" at creation.
    if (!prev && med.schedule.type === 'interval' && !med.schedule.firstDoseAt) {
      med.schedule = { ...med.schedule, firstDoseAt: now }
    }
    if (prev && prev.active !== med.active) med.pauses = togglePause(med.pauses, med.active, now)
    const errors = validateMedication(med)
    if (errors.length) throw new Error(errors.join(' '))
    await repo.saveMedication(med)
    await this.deps.onChanged([med.id])
    return med
  }

  async setActive(id: string, active: boolean): Promise<Medication> {
    const med = await this.requireMed(id)
    if (med.active === active) return med
    const now = this.now().toISOString()
    const updated = { ...med, active, pauses: togglePause(med.pauses, active, now), updatedAt: now }
    await this.deps.repo.saveMedication(updated)
    await this.deps.onChanged([id])
    return updated
  }

  async deleteMedication(id: string): Promise<void> {
    await this.deps.repo.deleteMedication(id)
    await this.deps.onChanged([id])
  }

  async adjustInventory(id: string, count: number): Promise<Medication> {
    const med = await this.requireMed(id)
    if (!med.inventory) throw new Error('Inventory tracking is off for this medication')
    const updated = { ...med, inventory: { ...med.inventory, count: Math.max(0, count) }, updatedAt: this.now().toISOString() }
    await this.deps.repo.saveMedication(updated)
    await this.deps.onChanged([id])
    return updated
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const cur = await this.deps.repo.getSettings()
    const next: Settings = mergeSettings(patch, cur)
    next.reminderOffsets = [...new Set(next.reminderOffsets.filter((n) => Number.isFinite(n) && n > 0).map(Math.round))].sort((a, b) => b - a)
    next.graceMinutes = Math.min(24 * 60, Math.max(1, Math.round(next.graceMinutes)))
    await this.deps.repo.saveSettings(next)
    const meds = await this.deps.repo.listMedications()
    await this.deps.onChanged(meds.map((m) => m.id))
    return next
  }
}

function togglePause(pauses: Medication['pauses'], active: boolean, now: string): Medication['pauses'] {
  const list = [...(pauses ?? [])]
  if (!active) list.push({ from: now, to: null })
  else {
    const open = list.findIndex((p) => !p.to)
    if (open >= 0) list[open] = { ...list[open]!, to: now }
  }
  return list
}

