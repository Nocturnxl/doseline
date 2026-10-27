import type { DoseLog, DoseStatus, Medication, NextDue } from './types'
import { addLocalDays, startOfLocalDay, HOUR } from './time'
import { computeNextDue, fixedSlotsBetween, isActiveAt, logAnchor, logsFor, pendingStatus, periodProgress, scheduleLowerBound } from './schedule'

export interface TimelineItem {
  key: string
  medicationId: string
  at: Date
  status: DoseStatus
  log?: DoseLog
  /** True for interval doses projected beyond the next one (they move when you log). */
  projected?: boolean
}

export interface UpNextItem {
  med: Medication
  /** null for an as-needed med that is available right now. */
  next: NextDue | null
  status: DoseStatus | 'available'
  progress: number
}

/** Each active medication's next dose (or PRN availability), soonest first. */
export function upNext(meds: Medication[], logs: DoseLog[], now: Date, zone: string, graceMinutes: number): UpNextItem[] {
  const items: UpNextItem[] = []
  for (const med of meds) {
    if (!med.active) continue
    const next = computeNextDue(med, logs, now, zone)
    if (med.schedule.type === 'prn') {
      const available = !next || next.dueAt <= now
      items.push({ med, next: available ? null : next, status: available ? 'available' : 'upcoming', progress: available || !next ? 1 : periodProgress(next, now) })
      continue
    }
    if (!next) continue
    items.push({ med, next, status: pendingStatus(next.dueAt, now, graceMinutes), progress: periodProgress(next, now) })
  }
  const rank = (i: UpNextItem) => (i.next ? i.next.dueAt.getTime() : Number.MAX_SAFE_INTEGER)
  return items.sort((a, b) => rank(a) - rank(b) || a.med.name.localeCompare(b.med.name))
}

/** Today's taken, skipped, missed and upcoming doses in time order. */
export function todayTimeline(meds: Medication[], logs: DoseLog[], now: Date, zone: string, graceMinutes: number): TimelineItem[] {
  const dayStart = startOfLocalDay(now, zone)
  const dayEnd = addLocalDays(dayStart, 1, zone)
  const items: TimelineItem[] = []
  const medIds = new Set(meds.map((m) => m.id))
  for (const l of logs) {
    if (!medIds.has(l.medicationId)) continue
    const at = l.kind === 'taken' ? new Date(l.takenAt) : logAnchor(l)
    if (at >= dayStart && at < dayEnd) items.push({ key: `log:${l.id}`, medicationId: l.medicationId, at, status: l.kind, log: l })
  }
  for (const med of meds) {
    if (!med.active) continue
    const mine = logsFor(med.id, logs)
    const next = computeNextDue(med, logs, now, zone)
    const s = med.schedule
    if (s.type === 'fixed') {
      const handled = new Set(mine.map((l) => logAnchor(l).getTime()))
      const lb = scheduleLowerBound(med, zone)
      for (const slot of fixedSlotsBetween(s, dayStart, dayEnd, zone)) {
        if (handled.has(slot.getTime()) || slot < lb || !isActiveAt(med, slot, zone)) continue
        let status: DoseStatus
        if (next && slot.getTime() === next.dueAt.getTime()) status = pendingStatus(slot, now, graceMinutes)
        else if (slot < now) status = 'missed'
        else status = 'upcoming'
        items.push({ key: `slot:${med.id}:${slot.getTime()}`, medicationId: med.id, at: slot, status })
      }
    } else if (next && (s.type === 'interval' || s.notifyWhenAvailable)) {
      if (next.dueAt < dayEnd && (next.dueAt >= dayStart || s.type === 'interval')) {
        const at = next.dueAt < dayStart ? now : next.dueAt
        items.push({ key: `next:${med.id}`, medicationId: med.id, at, status: s.type === 'prn' ? 'upcoming' : pendingStatus(next.dueAt, now, graceMinutes) })
      }
      if (s.type === 'interval') {
        let t = Math.max(next.dueAt.getTime(), now.getTime()) + s.everyHours * HOUR
        for (let i = 0; i < 48 && t < dayEnd.getTime(); i++, t += s.everyHours * HOUR) {
          items.push({ key: `proj:${med.id}:${t}`, medicationId: med.id, at: new Date(t), status: 'upcoming', projected: true })
        }
      }
    }
  }
  return items.sort((a, b) => a.at.getTime() - b.at.getTime())
}
