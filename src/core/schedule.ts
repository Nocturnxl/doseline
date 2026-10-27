import { DateTime } from 'luxon'
import type { DoseLog, FixedSchedule, Medication, NextDue, PrnSchedule } from './types'
import { DAY, HOUR, endOfLocalDate, inZone, maxDate, startOfLocalDate } from './time'
import { parseClock } from './time'

/**
 * Schedule math.
 *
 * Conventions (see DECISIONS.md):
 *  - Interval schedules measure absolute elapsed time from the last logged dose,
 *    so "every 8 hours" is always 8 real hours, even across DST changes.
 *  - Fixed schedules are wall-clock times in the user's *current* zone. On a
 *    spring-forward day a slot that falls in the gap (e.g. 02:30) moves forward
 *    to the first valid instant; on a fall-back day an ambiguous slot fires once,
 *    at its first occurrence.
 *  - An unlogged fixed slot stays "pending" (overdue) until the next slot arrives,
 *    capped at 24h, after which it counts as missed.
 */

const OVERDUE_CAP = DAY

function sortByTime<T>(arr: T[], key: (t: T) => number): T[] {
  return [...arr].sort((a, b) => key(a) - key(b))
}

export function logsFor(medicationId: string, logs: DoseLog[]): DoseLog[] {
  return logs.filter((l) => l.medicationId === medicationId)
}

/** True if the medication is scheduled (not paused, within its date range) at instant t. */
export function isActiveAt(med: Medication, t: Date, zone: string): boolean {
  if (med.startDate && t < startOfLocalDate(med.startDate, zone)) return false
  if (med.endDate && t > endOfLocalDate(med.endDate, zone)) return false
  for (const p of med.pauses ?? []) {
    const from = new Date(p.from)
    const to = p.to ? new Date(p.to) : null
    if (t >= from && (!to || t < to)) return false
  }
  return true
}

/** Earliest instant the schedule may produce a pending dose (creation, start date, last resume). */
export function scheduleLowerBound(med: Medication, zone: string): Date {
  let lb = new Date(med.createdAt)
  if (med.startDate) lb = maxDate(lb, startOfLocalDate(med.startDate, zone))
  for (const p of med.pauses ?? []) {
    if (p.to) lb = maxDate(lb, new Date(p.to))
  }
  return lb
}

/** Fixed-schedule slots in [from, to), in chronological order, de-duplicated. */
export function fixedSlotsBetween(schedule: FixedSchedule, from: Date, to: Date, zone: string): Date[] {
  if (to <= from || schedule.times.length === 0 || schedule.days.length === 0) return []
  const out = new Map<number, Date>()
  const times = schedule.times.map(parseClock)
  let day = inZone(from, zone).startOf('day').minus({ days: 1 })
  const end = inZone(to, zone).startOf('day').plus({ days: 1 })
  while (day <= end) {
    if (schedule.days.includes(day.weekday as FixedSchedule['days'][number])) {
      for (const { hour, minute } of times) {
        const slot = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone })
        const ms = slot.toMillis()
        if (ms >= from.getTime() && ms < to.getTime()) out.set(ms, slot.toJSDate())
      }
    }
    day = day.plus({ days: 1 })
  }
  return sortByTime([...out.values()], (d) => d.getTime())
}

/** The latest fixed slot at or before `at` (searching back up to `lookbackMs`). */
export function previousFixedSlot(schedule: FixedSchedule, at: Date, zone: string, lookbackMs = 8 * DAY): Date | null {
  const slots = fixedSlotsBetween(schedule, new Date(at.getTime() - lookbackMs), new Date(at.getTime() + 1), zone)
  return slots.length ? slots[slots.length - 1]! : null
}

/** The first fixed slot strictly after `after` (searching ahead up to `lookaheadMs`). */
export function nextFixedSlot(schedule: FixedSchedule, after: Date, zone: string, lookaheadMs = 15 * DAY): Date | null {
  const slots = fixedSlotsBetween(schedule, new Date(after.getTime() + 1), new Date(after.getTime() + lookaheadMs), zone)
  return slots[0] ?? null
}

/** The instant a log "covers": the slot for scheduled logs, otherwise when it was taken. */
export function logAnchor(log: DoseLog): Date {
  return new Date(log.scheduledFor ?? log.takenAt)
}

function latestLog(logs: DoseLog[], pick: (l: DoseLog) => Date): DoseLog | null {
  let best: DoseLog | null = null
  for (const l of logs) if (!best || pick(l) > pick(best)) best = l
  return best
}

function lastTaken(logs: DoseLog[], before?: Date): DoseLog | null {
  return latestLog(
    logs.filter((l) => l.kind === 'taken' && (!before || new Date(l.takenAt) <= before)),
    (l) => new Date(l.takenAt),
  )
}

/**
 * When a PRN medication may next be taken, honouring both the minimum interval and
 * the rolling 24h cap. Returns null if nothing restricts it (never taken).
 */
export function prnAvailableAt(schedule: PrnSchedule, logs: DoseLog[]): Date | null {
  const taken = sortByTime(
    logs.filter((l) => l.kind === 'taken'),
    (l) => -new Date(l.takenAt).getTime(),
  ) // newest first
  if (taken.length === 0) return null
  let available = new Date(new Date(taken[0]!.takenAt).getTime() + schedule.minIntervalHours * HOUR)
  const max = schedule.maxPer24h
  if (max && max > 0 && taken.length >= max) {
    // To take another dose at t, at most max-1 doses may sit in (t-24h, t].
    const blocker = taken[max - 1]!
    available = maxDate(available, new Date(new Date(blocker.takenAt).getTime() + DAY))
  }
  return available
}

/** Doses taken in the rolling 24h window ending at `at` (inclusive). */
export function takenInLast24h(logs: DoseLog[], at: Date): number {
  const from = at.getTime() - DAY
  return logs.filter((l) => {
    if (l.kind !== 'taken') return false
    const t = new Date(l.takenAt).getTime()
    return t > from && t <= at.getTime()
  }).length
}

/**
 * Compute the next due dose for a medication.
 * `logs` may contain logs for other medications; they are filtered out.
 */
export function computeNextDue(med: Medication, allLogs: DoseLog[], now: Date, zone: string): NextDue | null {
  if (!med.active) return null
  const logs = logsFor(med.id, allLogs)
  const endBound = med.endDate ? endOfLocalDate(med.endDate, zone) : null
  const lowerBound = scheduleLowerBound(med, zone)
  const s = med.schedule

  let result: NextDue | null = null

  if (s.type === 'interval') {
    const step = s.everyHours * HOUR
    const last = latestLog(logs, (l) => (l.kind === 'taken' ? new Date(l.takenAt) : logAnchor(l)))
    let due: Date
    let periodStart: Date
    if (last) {
      const anchor = last.kind === 'taken' ? new Date(last.takenAt) : logAnchor(last)
      due = new Date(anchor.getTime() + step)
      periodStart = anchor
    } else {
      due = new Date(s.firstDoseAt ?? med.createdAt)
      periodStart = new Date(due.getTime() - step)
    }
    if (due < lowerBound && med.startDate) due = lowerBound
    result = { dueAt: due, kind: 'scheduled', periodStart }
  } else if (s.type === 'fixed') {
    const handled = logs.map(logAnchor)
    const lastHandled = handled.length ? new Date(Math.max(...handled.map((d) => d.getTime()))) : null
    const floor = lastHandled ? maxDate(lowerBound, new Date(lastHandled.getTime() + 1)) : lowerBound
    // Pending (possibly overdue) slot: the latest slot <= now that is unhandled and not too old.
    const prev = previousFixedSlot(s, now, zone)
    if (prev && prev >= floor && now.getTime() - prev.getTime() < OVERDUE_CAP && isActiveAt(med, prev, zone)) {
      const before = previousFixedSlot(s, new Date(prev.getTime() - 1), zone)
      result = { dueAt: prev, kind: 'scheduled', periodStart: before ?? new Date(prev.getTime() - DAY) }
    } else {
      // Next slot after max(now, floor), skipping inactive (paused / out of range) slots.
      let cursor = maxDate(now, new Date(floor.getTime() - 1))
      for (let i = 0; i < 400; i++) {
        const next = nextFixedSlot(s, cursor, zone)
        if (!next) break
        if (endBound && next > endBound) break
        if (isActiveAt(med, next, zone)) {
          const before = previousFixedSlot(s, new Date(next.getTime() - 1), zone)
          result = { dueAt: next, kind: 'scheduled', periodStart: before ?? new Date(next.getTime() - DAY) }
          break
        }
        cursor = next
      }
    }
  } else {
    const available = prnAvailableAt(s, logs)
    if (!available) return null
    const lt = lastTaken(logs)
    result = { dueAt: available, kind: 'available', periodStart: lt ? new Date(lt.takenAt) : now }
  }

  if (!result) return null
  if (endBound && result.dueAt > endBound) return null
  return result
}

/**
 * Which scheduled slot a newly logged dose (taken or skipped at `at`) fulfils.
 * Interval: the dose that was due given the history before `at`.
 * Fixed: the nearest not-yet-handled slot within 12h of `at`.
 * PRN: none.
 */
export function assignScheduledFor(med: Medication, allLogs: DoseLog[], at: Date, zone: string): Date | null {
  const logs = logsFor(med.id, allLogs)
  const s = med.schedule
  if (s.type === 'prn') return null
  if (s.type === 'interval') {
    const before = logs.filter((l) => new Date(l.takenAt) <= at)
    const next = computeNextDue({ ...med, active: true }, before, at, zone)
    return next ? next.dueAt : null
  }
  const handled = new Set(logs.filter((l) => l.scheduledFor).map((l) => new Date(l.scheduledFor!).getTime()))
  const window = 12 * HOUR
  const candidates = fixedSlotsBetween(s, new Date(at.getTime() - window), new Date(at.getTime() + window + 1), zone)
    .filter((slot) => !handled.has(slot.getTime()))
    .filter((slot) => isActiveAt(med, slot, zone))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => Math.abs(a.getTime() - at.getTime()) - Math.abs(b.getTime() - at.getTime()))
  return candidates[0]!
}

/** Status of a pending dose relative to now. */
export function pendingStatus(dueAt: Date, now: Date, graceMinutes: number): 'upcoming' | 'due' | 'overdue' {
  if (now < dueAt) return 'upcoming'
  if (now.getTime() - dueAt.getTime() <= graceMinutes * 60_000) return 'due'
  return 'overdue'
}

/** Ring progress from periodStart to dueAt in [0, 1]. */
export function periodProgress(next: NextDue, now: Date): number {
  const total = next.dueAt.getTime() - next.periodStart.getTime()
  if (total <= 0) return 1
  return Math.min(1, Math.max(0, (now.getTime() - next.periodStart.getTime()) / total))
}

/** Average scheduled doses per day, used for days-of-supply. Null for PRN without history. */
export function scheduledDosesPerDay(med: Medication): number | null {
  const s = med.schedule
  if (s.type === 'interval') return 24 / s.everyHours
  if (s.type === 'fixed') return (s.times.length * s.days.length) / 7
  return null
}

export function describeSchedule(med: Medication): string {
  const s = med.schedule
  if (s.type === 'interval') return `Every ${trimNum(s.everyHours)} h`
  if (s.type === 'prn') {
    const cap = s.maxPer24h ? ` · max ${s.maxPer24h}/24h` : ''
    return `As needed · ≥${trimNum(s.minIntervalHours)} h apart${cap}`
  }
  const days = s.days.length === 7 ? 'Daily' : s.days.length === 5 && !s.days.includes(6) && !s.days.includes(7) ? 'Weekdays' : [...s.days].sort().map((d) => WEEKDAY_SHORT[d - 1]).join(' ')
  return `${days} · ${[...s.times].sort().join(', ')}`
}

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
