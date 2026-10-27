/**
 * Overdue escalation: a second alert level once a dose has been overdue for a threshold,
 * repeating on a fixed interval until the dose is resolved.
 *
 * Everything here is derived from persisted data (the pending dose from logs, plus one
 * EscalationRecord per escalated dose), so restarts, sleep and clock/zone changes recompute the
 * correct state instead of relying on timers. Escalation is purely local: no calendar changes.
 *
 * Rules (see DECISIONS.md):
 *  - Only scheduled doses escalate (fixed and interval). PRN never does.
 *  - Fixed: the escalation ends when the next slot comes due (the old slot becomes missed).
 *  - Interval: there is no next slot, so it escalates until the dose is logged.
 *  - One escalation per medication: only the medication's single pending dose can escalate.
 *  - Snooze defers only the next repeat; it never resets the overdue clock.
 */
import type { DoseLog, EscalationRecord, Medication, Settings } from './types'
import { MINUTE, inZone } from './time'
import { computeNextDue, logsFor, nextFixedSlot } from './schedule'
import { parseClock } from './time'

export const ESCALATION_MIN_THRESHOLD = 5
export const ESCALATION_MAX_THRESHOLD = 360
export const ESCALATION_MIN_REPEAT = 5
export const ESCALATION_MAX_REPEAT = 60
export const ESCALATION_PRESETS = [30, 60, 120]
export const ESCALATION_SNOOZE_OPTIONS = [15, 30, 60]
/** Repeat cycles landing within this window of each other share one window and one sound. */
export const CONSOLIDATE_MS = 60_000
/** A fire time this far in the past is "stale" (the app wasn't running or the PC slept). */
export const ESCALATION_STALE_MS = 2 * MINUTE

export function clampThreshold(n: number): number {
  return Math.min(ESCALATION_MAX_THRESHOLD, Math.max(ESCALATION_MIN_THRESHOLD, Math.round(n)))
}

export function clampRepeat(n: number): number {
  return Math.min(ESCALATION_MAX_REPEAT, Math.max(ESCALATION_MIN_REPEAT, Math.round(n)))
}

/** Escalation threshold in minutes for a medication, or null when it never escalates. */
export function escalationThreshold(med: Medication, settings: Settings): number | null {
  if (!med.active || med.schedule.type === 'prn') return null
  const o = med.escalationMinutes
  if (o === 0) return null
  if (o != null && Number.isFinite(o)) return clampThreshold(o)
  return clampThreshold(settings.escalation.thresholdMinutes)
}

export function recordKey(medicationId: string, dueAt: Date | string): string {
  return `${medicationId}|${new Date(dueAt).toISOString()}`
}

export interface PlannedEscalation {
  medicationId: string
  dueAt: Date
  /** dueAt + threshold: when the dose became (or becomes) escalated. */
  startAt: Date
  /** When the next escalation alarm should fire. */
  fireAt: Date
  kind: 'first' | 'repeat'
  record: EscalationRecord | null
  /** Fixed schedules: the escalation ends here, when the next slot comes due. */
  endsAt: Date | null
}

/**
 * The next escalation alarm for every medication with an overdue (or soon-to-be) scheduled dose.
 * Fire times at or after the end of the escalation (next fixed slot) are omitted.
 */
export function planEscalations(meds: Medication[], logs: DoseLog[], records: EscalationRecord[], settings: Settings, now: Date, zone: string): PlannedEscalation[] {
  const byKey = new Map(records.map((r) => [recordKey(r.medicationId, r.dueAt), r]))
  const repeat = clampRepeat(settings.escalation.repeatMinutes) * MINUTE
  const out: PlannedEscalation[] = []
  for (const med of meds) {
    const threshold = escalationThreshold(med, settings)
    if (threshold == null) continue
    const next = computeNextDue(med, logs, now, zone)
    if (!next || next.kind !== 'scheduled') continue
    const startAt = new Date(next.dueAt.getTime() + threshold * MINUTE)
    const endsAt = med.schedule.type === 'fixed' ? nextFixedSlot(med.schedule, next.dueAt, zone) : null
    const record = byKey.get(recordKey(med.id, next.dueAt)) ?? null
    let fireAt: Date
    if (!record) fireAt = startAt
    else {
      const cadence = new Date(record.lastFiredAt).getTime() + repeat
      const snooze = record.snoozedUntil ? new Date(record.snoozedUntil).getTime() : 0
      fireAt = new Date(Math.max(cadence, snooze))
    }
    if (endsAt && fireAt >= endsAt) continue
    out.push({ medicationId: med.id, dueAt: next.dueAt, startAt, fireAt, kind: record ? 'repeat' : 'first', record, endsAt })
  }
  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
}

/** Medications whose pending dose is currently escalated (for the dashboard and alarm window). */
export function activeEscalations(meds: Medication[], logs: DoseLog[], records: EscalationRecord[], settings: Settings, now: Date, zone: string): PlannedEscalation[] {
  return planEscalations(meds, logs, records, settings, now, zone).filter((p) => p.record || p.startAt <= now)
}

/**
 * Splits the plan at `now`:
 *  - `fire`: due now, plus anything landing within CONSOLIDATE_MS, so near-simultaneous cycles
 *    share one window and one sound;
 *  - `stale`: should have fired more than ESCALATION_STALE_MS ago (app closed / PC asleep).
 * Callers fold `stale` into the away summary when a gap was detected, and fire them otherwise.
 */
export function dueEscalations(plan: PlannedEscalation[], now: Date): { fire: PlannedEscalation[]; stale: PlannedEscalation[] } {
  const fire: PlannedEscalation[] = []
  const stale: PlannedEscalation[] = []
  const t = now.getTime()
  const anyDue = plan.some((p) => p.fireAt.getTime() <= t)
  for (const p of plan) {
    const at = p.fireAt.getTime()
    if (at < t - ESCALATION_STALE_MS) stale.push(p)
    else if (at <= t || (anyDue && at <= t + CONSOLIDATE_MS)) fire.push(p)
  }
  return { fire, stale }
}

/** Record after an escalation alarm fires. */
export function recordFired(p: PlannedEscalation, now: Date): EscalationRecord {
  const at = now.toISOString()
  if (!p.record) return { medicationId: p.medicationId, dueAt: p.dueAt.toISOString(), escalatedAt: at, lastFiredAt: at, repeats: 0, snoozedUntil: null, resolution: null }
  return { ...p.record, lastFiredAt: at, repeats: p.record.repeats + 1, snoozedUntil: null }
}

/**
 * Record after a stale escalation is folded into "Missed while you were away": no alarm fires,
 * no repeat is counted, and the repeat cadence restarts from now (no backlog burst).
 */
export function recordFolded(p: PlannedEscalation, now: Date): EscalationRecord {
  const at = now.toISOString()
  if (!p.record) return { medicationId: p.medicationId, dueAt: p.dueAt.toISOString(), escalatedAt: p.startAt.toISOString(), lastFiredAt: at, repeats: 0, snoozedUntil: null, resolution: null }
  return { ...p.record, lastFiredAt: at, snoozedUntil: null }
}

/** Snooze an escalation: only the next repeat waits; the overdue clock and repeat count are unchanged. */
export function recordSnoozed(r: EscalationRecord, now: Date, minutes: number): EscalationRecord {
  const m = ESCALATION_SNOOZE_OPTIONS.includes(minutes) ? minutes : ESCALATION_SNOOZE_OPTIONS[0]!
  return { ...r, snoozedUntil: new Date(now.getTime() + m * MINUTE).toISOString() }
}

/**
 * Bookkeeping: how each record's dose ended. Pending → null; a log covering the slot → its kind;
 * otherwise (a fixed slot superseded by the next one) → 'missed'. Returns only changed records.
 */
export function resolveRecords(records: EscalationRecord[], meds: Medication[], logs: DoseLog[], now: Date, zone: string): EscalationRecord[] {
  const medById = new Map(meds.map((m) => [m.id, m]))
  const changed: EscalationRecord[] = []
  for (const r of records) {
    const med = medById.get(r.medicationId)
    const due = new Date(r.dueAt).getTime()
    let resolution: EscalationRecord['resolution']
    const log = logsFor(r.medicationId, logs).find((l) => l.scheduledFor && new Date(l.scheduledFor).getTime() === due)
    if (log) resolution = log.kind
    else {
      const pending = med ? computeNextDue(med, logs, now, zone) : null
      resolution = pending && pending.dueAt.getTime() === due ? null : 'missed'
    }
    if (resolution !== r.resolution) changed.push({ ...r, resolution })
  }
  return changed
}

/** Copies escalation history onto a log being created for the escalated dose. */
export function stampLog(log: DoseLog, records: EscalationRecord[]): DoseLog {
  if (!log.scheduledFor) return log
  const r = records.find((x) => x.medicationId === log.medicationId && new Date(x.dueAt).getTime() === new Date(log.scheduledFor!).getTime())
  return r ? { ...log, escalatedAt: r.escalatedAt, escalationRepeats: r.repeats } : log
}

/** True when `at` falls inside the configured quiet hours (wall clock, crossing midnight allowed). */
export function isQuietHours(settings: Settings, at: Date, zone: string): boolean {
  const q = settings.escalation.quietHours
  if (!q.enabled) return false
  const s = parseClock(q.start)
  const e = parseClock(q.end)
  const startMin = s.hour * 60 + s.minute
  const endMin = e.hour * 60 + e.minute
  if (startMin === endMin) return false
  const local = inZone(at, zone)
  const m = local.hour * 60 + local.minute
  return startMin < endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin
}

/** "1 h 15 m", "45 m", "2 h" */
export function overdueLabel(dueAt: Date, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / MINUTE))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m} m`
  return m ? `${h} h ${m} m` : `${h} h`
}
