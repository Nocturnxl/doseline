import { DateTime } from 'luxon'
import type { ClockTime, LocalDate } from './types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export function toDate(iso: string): Date {
  return new Date(iso)
}

export function iso(d: Date): string {
  return d.toISOString()
}

export function parseClock(t: ClockTime): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  if (!m) throw new Error(`Invalid time "${t}"`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${t}"`)
  return { hour, minute }
}

export function isValidClock(t: string): boolean {
  try {
    parseClock(t)
    return true
  } catch {
    return false
  }
}

export function inZone(d: Date, zone: string): DateTime {
  return DateTime.fromJSDate(d, { zone })
}

/** YYYY-MM-DD of an instant in the given zone. */
export function localDateKey(d: Date, zone: string): LocalDate {
  return inZone(d, zone).toISODate()!
}

/** Start of the local day containing d (handles DST days that are 23h/25h long). */
export function startOfLocalDay(d: Date, zone: string): Date {
  return inZone(d, zone).startOf('day').toJSDate()
}

export function startOfLocalDate(date: LocalDate, zone: string): Date {
  return DateTime.fromISO(date, { zone }).startOf('day').toJSDate()
}

export function endOfLocalDate(date: LocalDate, zone: string): Date {
  return DateTime.fromISO(date, { zone }).endOf('day').toJSDate()
}

/** Add calendar days in local time (a "day" may be 23 or 25 hours across DST). */
export function addLocalDays(d: Date, days: number, zone: string): Date {
  return inZone(d, zone).plus({ days }).toJSDate()
}

/** Wall-clock time on a local date. Non-existent times (spring-forward gap) move forward. */
export function atLocalTime(date: LocalDate, time: ClockTime, zone: string): Date {
  const { hour, minute } = parseClock(time)
  const base = DateTime.fromISO(date, { zone })
  return DateTime.fromObject({ year: base.year, month: base.month, day: base.day, hour, minute }, { zone }).toJSDate()
}

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid
}

export function formatDuration(ms: number): string {
  const neg = ms < 0
  let s = Math.round(Math.abs(ms) / 1000)
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  let out: string
  if (d > 0) out = `${d}d ${h}h`
  else if (h > 0) out = `${h}h ${String(m).padStart(2, '0')}m`
  else if (m > 0) out = `${m}m ${String(s).padStart(2, '0')}s`
  else out = `${s}s`
  return neg ? `-${out}` : out
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}
