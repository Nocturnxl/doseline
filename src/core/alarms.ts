import type { DoseLog, Medication, NextDue, Settings, Snooze } from './types'
import { MINUTE } from './time'
import { computeNextDue, fixedSlotsBetween, logAnchor, logsFor, isActiveAt, scheduleLowerBound } from './schedule'

export interface PlannedAlarm {
  /** Stable id: medication + due instant + offset, so a fired alarm is never re-fired. */
  id: string
  medicationId: string
  dueAt: Date
  fireAt: Date
  /** Minutes before due; 0 = at due time. -1 for snoozes. */
  offsetMin: number
  kind: 'reminder' | 'due' | 'snooze'
}

/** An alarm whose fire time passed less than this long ago still fires (e.g. a slow wake). */
export const LATE_FIRE_TOLERANCE_MS = 2 * MINUTE

export function effectiveOffsets(med: Medication, settings: Settings): number[] {
  const raw = med.reminderOffsets && med.reminderOffsets.length ? med.reminderOffsets : settings.reminderOffsets
  const clean = raw.filter((n) => Number.isFinite(n) && n > 0 && n <= 7 * 24 * 60).map((n) => Math.round(n))
  return [...new Set(clean)].sort((a, b) => b - a)
}

/** Does this med get alarms/events for its next due time? */
export function wantsAlarms(med: Medication): boolean {
  if (!med.active) return false
  if (med.schedule.type === 'prn') return med.schedule.notifyWhenAvailable
  return true
}

export function alarmId(medicationId: string, dueAt: Date, offsetMin: number): string {
  return `${medicationId}|${dueAt.toISOString()}|${offsetMin}`
}

/**
 * Plan every future alarm: reminders at each offset before due, one at due time, and snoozes.
 * Alarms already in the past (beyond the tolerance) are omitted; the caller handles "missed".
 */
export function planAlarms(
  meds: Medication[],
  logs: DoseLog[],
  snoozes: Snooze[],
  settings: Settings,
  now: Date,
  zone: string,
): PlannedAlarm[] {
  const out: PlannedAlarm[] = []
  const cutoff = now.getTime() - LATE_FIRE_TOLERANCE_MS
  for (const med of meds) {
    if (!wantsAlarms(med)) continue
    const next = computeNextDue(med, logs, now, zone)
    if (!next) continue
    for (const off of [...effectiveOffsets(med, settings), 0]) {
      const fireAt = new Date(next.dueAt.getTime() - off * MINUTE)
      if (fireAt.getTime() < cutoff) continue
      out.push({ id: alarmId(med.id, next.dueAt, off), medicationId: med.id, dueAt: next.dueAt, fireAt, offsetMin: off, kind: off === 0 ? 'due' : 'reminder' })
    }
    for (const sn of snoozes) {
      if (sn.medicationId !== med.id || new Date(sn.dueAt).getTime() !== next.dueAt.getTime()) continue
      const fireAt = new Date(sn.fireAt)
      if (fireAt.getTime() < cutoff) continue
      out.push({ id: `snooze|${sn.id}`, medicationId: med.id, dueAt: next.dueAt, fireAt, offsetMin: -1, kind: 'snooze' })
    }
  }
  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
}

/** Snoozes that no longer match the med's pending dose (dose was logged) can be dropped. */
export function staleSnoozes(meds: Medication[], logs: DoseLog[], snoozes: Snooze[], now: Date, zone: string): Snooze[] {
  const dueByMed = new Map<string, NextDue | null>()
  for (const m of meds) dueByMed.set(m.id, computeNextDue(m, logs, now, zone))
  return snoozes.filter((s) => {
    const due = dueByMed.get(s.medicationId)
    return !due || due.dueAt.getTime() !== new Date(s.dueAt).getTime() || new Date(s.fireAt).getTime() < now.getTime() - LATE_FIRE_TOLERANCE_MS
  })
}

export interface MissedDose {
  medicationId: string
  dueAt: Date
  /** The dose also crossed its overdue-escalation threshold while the app was away. */
  escalated?: boolean
}

/**
 * Doses that came due while the app wasn't watching (asleep / off), i.e. in (lastSeen, now - tolerance],
 * and that are still unlogged. Shown as a single "Missed while you were away" summary instead of
 * a burst of stale alarms.
 */
export function findMissedWhileAway(meds: Medication[], logs: DoseLog[], lastSeen: Date, now: Date, zone: string): MissedDose[] {
  const until = new Date(now.getTime() - LATE_FIRE_TOLERANCE_MS)
  if (until <= lastSeen) return []
  const out: MissedDose[] = []
  for (const med of meds) {
    if (!wantsAlarms(med)) continue
    const s = med.schedule
    if (s.type === 'fixed') {
      const mine = logsFor(med.id, logs)
      const handled = new Set(mine.map((l) => logAnchor(l).getTime()))
      const lb = scheduleLowerBound(med, zone)
      for (const slot of fixedSlotsBetween(s, new Date(lastSeen.getTime() + 1), new Date(until.getTime() + 1), zone)) {
        if (slot < lb || handled.has(slot.getTime()) || !isActiveAt(med, slot, zone)) continue
        out.push({ medicationId: med.id, dueAt: slot })
      }
    } else {
      const next = computeNextDue(med, logs, now, zone)
      if (next && next.dueAt > lastSeen && next.dueAt <= until) out.push({ medicationId: med.id, dueAt: next.dueAt })
    }
  }
  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
}
