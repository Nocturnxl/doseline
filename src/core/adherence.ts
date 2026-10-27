import type { DoseLog, LocalDate, Medication } from './types'
import { DAY, MINUTE, addLocalDays, localDateKey, startOfLocalDay } from './time'
import { computeNextDue, fixedSlotsBetween, isActiveAt, logsFor, scheduleLowerBound } from './schedule'

export type OutcomeStatus = 'onTime' | 'late' | 'skipped' | 'missed'

export interface DoseOutcome {
  medicationId: string
  /** The scheduled time of the dose. */
  slot: Date
  status: OutcomeStatus
  log?: DoseLog
}

export interface AdherenceStats {
  expected: number
  onTime: number
  late: number
  skipped: number
  missed: number
  /** onTime / expected, or null when nothing was expected. */
  onTimeRate: number | null
}

/**
 * Outcomes of scheduled doses whose slot falls in [from, to) and is in the past.
 * - Fixed: every active slot is expected; an unlogged slot is missed once it is no longer pending.
 * - Interval: each logged dose is matched against the time it was due. Because interval
 *   schedules wait for you, a dose is never "missed", only late.
 * - PRN: not scheduled, never counted.
 */
export function outcomesForMed(
  med: Medication,
  allLogs: DoseLog[],
  from: Date,
  to: Date,
  now: Date,
  zone: string,
  graceMinutes: number,
): DoseOutcome[] {
  const logs = logsFor(med.id, allLogs)
  const grace = graceMinutes * MINUTE
  const judge = (slot: Date, log: DoseLog): OutcomeStatus => {
    if (log.kind === 'skipped') return 'skipped'
    // Taken after the overdue escalation fired: late, even if still inside the grace window.
    if (log.escalatedAt && new Date(log.takenAt) >= new Date(log.escalatedAt)) return 'late'
    return Math.abs(new Date(log.takenAt).getTime() - slot.getTime()) <= grace ? 'onTime' : 'late'
  }
  const s = med.schedule
  const out: DoseOutcome[] = []

  if (s.type === 'fixed') {
    // Slots before the med existed (or before its start date / last resume) are not expected,
    // unless the user logged them anyway.
    const lb = scheduleLowerBound(med, zone)
    const end = to < now ? to : now
    const bySlot = new Map<number, DoseLog>()
    for (const l of logs) if (l.scheduledFor) bySlot.set(new Date(l.scheduledFor).getTime(), l)
    const pending = med.active ? computeNextDue(med, allLogs, now, zone) : null
    for (const slot of fixedSlotsBetween(s, from, end, zone)) {
      const log = bySlot.get(slot.getTime())
      if (log) {
        out.push({ medicationId: med.id, slot, status: judge(slot, log), log })
        continue
      }
      if (slot < lb || !isActiveAt(med, slot, zone)) continue
      if (pending && pending.dueAt.getTime() === slot.getTime()) continue // still pending
      out.push({ medicationId: med.id, slot, status: 'missed' })
    }
  } else if (s.type === 'interval') {
    for (const l of logs) {
      if (!l.scheduledFor) continue
      const slot = new Date(l.scheduledFor)
      if (slot < from || slot >= to || slot > now) continue
      out.push({ medicationId: med.id, slot, status: judge(slot, l), log: l })
    }
  }
  return out.sort((a, b) => a.slot.getTime() - b.slot.getTime())
}

export function summarize(outcomes: DoseOutcome[]): AdherenceStats {
  const st: AdherenceStats = { expected: outcomes.length, onTime: 0, late: 0, skipped: 0, missed: 0, onTimeRate: null }
  for (const o of outcomes) st[o.status]++
  st.onTimeRate = st.expected ? st.onTime / st.expected : null
  return st
}

/** Stats over the last `days` local days, including today. */
export function adherenceOverDays(
  med: Medication,
  logs: DoseLog[],
  days: number,
  now: Date,
  zone: string,
  graceMinutes: number,
): AdherenceStats {
  const from = addLocalDays(startOfLocalDay(now, zone), -(days - 1), zone)
  return summarize(outcomesForMed(med, logs, from, now, now, zone, graceMinutes))
}

export interface HeatmapDay {
  date: LocalDate
  expected: number
  onTime: number
  /** onTime/expected, or null if nothing was expected that day. */
  rate: number | null
}

/** Per-day adherence for the last `days` days (oldest first) across the given meds. */
export function heatmap(
  meds: Medication[],
  logs: DoseLog[],
  days: number,
  now: Date,
  zone: string,
  graceMinutes: number,
): HeatmapDay[] {
  const todayStart = startOfLocalDay(now, zone)
  const from = addLocalDays(todayStart, -(days - 1), zone)
  const buckets = new Map<LocalDate, HeatmapDay>()
  let cursor = from
  for (let i = 0; i < days; i++) {
    const key = localDateKey(cursor, zone)
    buckets.set(key, { date: key, expected: 0, onTime: 0, rate: null })
    cursor = addLocalDays(cursor, 1, zone)
  }
  for (const med of meds) {
    for (const o of outcomesForMed(med, logs, from, now, now, zone, graceMinutes)) {
      const b = buckets.get(localDateKey(o.slot, zone))
      if (!b) continue
      b.expected++
      if (o.status === 'onTime') b.onTime++
    }
  }
  for (const b of buckets.values()) b.rate = b.expected ? b.onTime / b.expected : null
  return [...buckets.values()]
}

/**
 * Current streak: consecutive days (ending today) on which every scheduled dose was taken on
 * time. Days with nothing scheduled are neutral. Today only breaks the streak once a dose
 * today is late, skipped or missed; doses still pending today don't count against it.
 */
export function currentStreak(
  meds: Medication[],
  logs: DoseLog[],
  now: Date,
  zone: string,
  graceMinutes: number,
  maxDays = 366,
): number {
  const from = addLocalDays(startOfLocalDay(now, zone), -(maxDays - 1), zone)
  const byDay = new Map<LocalDate, { good: number; bad: number }>()
  for (const med of meds) {
    for (const o of outcomesForMed(med, logs, from, now, now, zone, graceMinutes)) {
      const key = localDateKey(o.slot, zone)
      const b = byDay.get(key) ?? { good: 0, bad: 0 }
      if (o.status === 'onTime') b.good++
      else b.bad++
      byDay.set(key, b)
    }
  }
  const earliest = meds.reduce<Date | null>((acc, m) => {
    const c = new Date(m.createdAt)
    return !acc || c < acc ? c : acc
  }, null)
  let streak = 0
  let day = startOfLocalDay(now, zone)
  for (let i = 0; i < maxDays; i++) {
    if (earliest && day.getTime() + DAY < earliest.getTime()) break
    const b = byDay.get(localDateKey(day, zone))
    if (b) {
      if (b.bad > 0) break
      if (b.good > 0) streak++
    }
    day = addLocalDays(day, -1, zone)
  }
  return streak
}
