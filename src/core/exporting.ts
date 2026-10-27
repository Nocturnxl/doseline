import type { DoseLog, Medication, Settings } from './types'
import { mergeSettings } from './settings'
import type { BackupData } from './ports'
import { inZone, MINUTE } from './time'
import { doseLine } from './calendar'
import { outcomesForMed, summarize, type AdherenceStats } from './adherence'
import { validateMedication } from './validation'

export const BACKUP_VERSION = 1

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function logsToCsv(logs: DoseLog[], meds: Medication[], zone: string): string {
  const byId = new Map(meds.map((m) => [m.id, m]))
  const header = ['date', 'time', 'medication', 'strength', 'dose', 'status', 'scheduled_for', 'minutes_from_schedule', 'escalated_at', 'escalation_repeats', 'note']
  const rows = [...logs]
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
    .map((l) => {
      const m = byId.get(l.medicationId)
      const t = inZone(new Date(l.takenAt), zone)
      const sched = l.scheduledFor ? inZone(new Date(l.scheduledFor), zone) : null
      const diff = sched ? Math.round((new Date(l.takenAt).getTime() - new Date(l.scheduledFor!).getTime()) / MINUTE) : null
      return [
        t.toISODate(),
        t.toFormat('HH:mm'),
        m?.name ?? '(deleted medication)',
        m?.strength ?? '',
        m ? doseLine(m) : '',
        l.kind,
        sched ? sched.toFormat("yyyy-MM-dd HH:mm") : '',
        l.kind === 'taken' ? diff : '',
        l.escalatedAt ? inZone(new Date(l.escalatedAt), zone).toFormat('yyyy-MM-dd HH:mm') : '',
        l.escalatedAt ? (l.escalationRepeats ?? 0) : '',
        l.note ?? '',
      ]
    })
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function makeBackup(meds: Medication[], logs: DoseLog[], settings: Settings, now: Date, kv?: Record<string, string>): BackupData {
  return { app: 'doseline', version: BACKUP_VERSION, exportedAt: now.toISOString(), medications: meds, logs, settings, kv }
}

/** Validate and normalise an imported backup. Throws with a human-readable message. */
export function parseBackup(raw: unknown): BackupData {
  if (!raw || typeof raw !== 'object') throw new Error('This file is not a Doseline backup.')
  const d = raw as Partial<BackupData>
  if (d.app !== 'doseline') throw new Error('This file is not a Doseline backup.')
  if (typeof d.version !== 'number' || d.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Doseline.')
  if (!Array.isArray(d.medications) || !Array.isArray(d.logs)) throw new Error('The backup is missing medications or history.')
  const meds = d.medications.map((m) => ({ ...m, pauses: m.pauses ?? [], notes: m.notes ?? '', instructions: m.instructions ?? '' }) as Medication)
  for (const m of meds) {
    const errs = validateMedication(m)
    if (errs.length) throw new Error(`Medication "${m.name ?? m.id}" is invalid: ${errs[0]}`)
  }
  const ids = new Set(meds.map((m) => m.id))
  const logs = (d.logs as DoseLog[]).filter((l) => l && ids.has(l.medicationId) && !Number.isNaN(Date.parse(l.takenAt)) && (l.kind === 'taken' || l.kind === 'skipped'))
  const settings = mergeSettings(d.settings)
  return { app: 'doseline', version: d.version, exportedAt: d.exportedAt ?? '', medications: meds, logs: logs.map((l) => ({ ...l, inventoryDelta: l.inventoryDelta ?? 0 })), settings, kv: d.kv }
}

export interface ReportMedSection {
  med: Medication
  stats: AdherenceStats
  entries: { at: Date; kind: DoseLog['kind'] | 'missed'; scheduledFor: Date | null; minutesOff: number | null }[]
  prnCount: number
}

export interface DoctorReport {
  from: Date
  to: Date
  generatedAt: Date
  zone: string
  sections: ReportMedSection[]
}

/** Data model for the printable report; the UI renders it to HTML / PDF. */
export function buildReport(meds: Medication[], logs: DoseLog[], from: Date, to: Date, now: Date, zone: string, graceMinutes: number): DoctorReport {
  const sections: ReportMedSection[] = []
  for (const med of meds) {
    const outcomes = outcomesForMed(med, logs, from, to, now, zone, graceMinutes)
    const mine = logs.filter((l) => l.medicationId === med.id && new Date(l.takenAt) >= from && new Date(l.takenAt) < to)
    const entries: ReportMedSection['entries'] = mine.map((l) => ({
      at: new Date(l.takenAt),
      kind: l.kind,
      scheduledFor: l.scheduledFor ? new Date(l.scheduledFor) : null,
      minutesOff: l.scheduledFor && l.kind === 'taken' ? Math.round((new Date(l.takenAt).getTime() - new Date(l.scheduledFor).getTime()) / MINUTE) : null,
    }))
    for (const o of outcomes) if (o.status === 'missed') entries.push({ at: o.slot, kind: 'missed', scheduledFor: o.slot, minutesOff: null })
    entries.sort((a, b) => a.at.getTime() - b.at.getTime())
    if (!entries.length && !med.active) continue
    sections.push({ med, stats: summarize(outcomes), entries, prnCount: med.schedule.type === 'prn' ? mine.filter((l) => l.kind === 'taken').length : 0 })
  }
  return { from, to, generatedAt: now, zone, sections }
}

