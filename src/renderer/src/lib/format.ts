import { formatDuration } from '../../../core/time'

export function fmtTime(d: Date | string, zone: string): string {
  return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: zone })
}

export function isSameLocalDay(a: Date, b: Date, zone: string): boolean {
  const k = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: zone })
  return k(a) === k(b)
}

/** "8:00 PM", "Tomorrow 8:00 AM", "Thu 8:00 AM", "Nov 3, 8:00 AM" */
export function fmtWhen(d: Date | string, zone: string, now = new Date()): string {
  const date = new Date(d)
  const t = fmtTime(date, zone)
  if (isSameLocalDay(date, now, zone)) return t
  const tomorrow = new Date(now.getTime() + 86_400_000)
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (isSameLocalDay(date, tomorrow, zone)) return `Tomorrow ${t}`
  if (isSameLocalDay(date, yesterday, zone)) return `Yesterday ${t}`
  const diff = Math.abs(date.getTime() - now.getTime())
  if (diff < 6 * 86_400_000) return `${date.toLocaleDateString([], { weekday: 'short', timeZone: zone })} ${t}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: zone })}, ${t}`
}

export function fmtDate(d: Date | string, zone: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }): string {
  return new Date(d).toLocaleDateString([], { ...opts, timeZone: zone })
}

/** Compact countdown: "in 1h 05m", "5m 12s overdue". */
export function countdown(due: Date, now: Date): string {
  const ms = due.getTime() - now.getTime()
  if (Math.abs(ms) < 30_000) return 'now'
  return ms > 0 ? `in ${formatDuration(ms)}` : `${formatDuration(-ms)} ago`
}

/** Short ring label: "1:05", "12m", "45s". */
export function ringLabel(due: Date, now: Date): { value: string; unit: string } {
  const ms = Math.max(0, due.getTime() - now.getTime())
  const mins = Math.floor(ms / 60_000)
  if (ms <= 0) return { value: 'Now', unit: '' }
  if (mins >= 24 * 60) return { value: String(Math.floor(mins / 1440)), unit: Math.floor(mins / 1440) === 1 ? 'day' : 'days' }
  if (mins >= 60) return { value: `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`, unit: 'hrs' }
  if (mins >= 1) return { value: String(mins), unit: 'min' }
  return { value: String(Math.ceil(ms / 1000)), unit: 'sec' }
}

export function minutesLabel(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} d`
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`
  if (m > 60) return `${Math.floor(m / 60)} h ${m % 60} m`
  return `${m} min`
}

export function pct(r: number | null | undefined): string {
  return r == null ? '—' : `${Math.round(r * 100)}%`
}

/** Value for <input type="datetime-local"> in the given zone. */
export function toLocalInput(d: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** Parse a datetime-local value. The renderer runs in the system zone, which is the app zone. */
export function fromLocalInput(v: string): Date {
  return new Date(v)
}

export function greeting(now: Date): string {
  const h = now.getHours()
  if (h < 5) return 'Good evening'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`
}

/** "tablet" -> "tablets" when count != 1 (leaves units like "ml" or "softgels" alone). */
export function unitLabel(unit: string, count: number): string {
  const u = unit || 'units'
  if (count === 1 || /s$/i.test(u) || /^(ml|mg|g|mcg|iu|units?)$/i.test(u)) return u
  return `${u}s`
}
