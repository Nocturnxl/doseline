import type { Medication } from './types'
import { MINUTE } from './time'

/** Marker stored in extendedProperties.private.app on every event Doseline owns. */
export const APP_MARKER = 'doseline'
export const CALENDAR_NAME = 'Medications'
export const CALENDAR_DESCRIPTION = 'Upcoming doses managed by Doseline. Log doses in the app; edits made here are overwritten.'

export type EventKind = 'dose' | 'refill' | 'test'

/** Subset of the Google Calendar v3 Event resource that Doseline writes. */
export interface CalendarEventBody {
  summary: string
  description: string
  start: { dateTime?: string; date?: string; timeZone?: string }
  end: { dateTime?: string; date?: string; timeZone?: string }
  reminders: { useDefault: boolean; overrides: { method: 'popup'; minutes: number }[] }
  colorId?: string
  transparency: 'transparent' | 'opaque'
  extendedProperties: { private: Record<string, string> }
}

export interface CalendarEvent extends CalendarEventBody {
  id: string
}

/** Google Calendar's fixed event palette (colors.get → event). */
export const GOOGLE_EVENT_COLORS: Record<string, { name: string; hex: string }> = {
  '1': { name: 'Lavender', hex: '#7986cb' },
  '2': { name: 'Sage', hex: '#33b679' },
  '3': { name: 'Grape', hex: '#8e24aa' },
  '4': { name: 'Flamingo', hex: '#e67c73' },
  '5': { name: 'Banana', hex: '#f6bf26' },
  '6': { name: 'Tangerine', hex: '#f4511e' },
  '7': { name: 'Peacock', hex: '#039be5' },
  '8': { name: 'Graphite', hex: '#616161' },
  '9': { name: 'Blueberry', hex: '#3f51b5' },
  '10': { name: 'Basil', hex: '#0b8043' },
  '11': { name: 'Tomato', hex: '#d50000' },
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [128, 128, 128]
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/** Nearest Google event colorId to an arbitrary hex color (CIE76 distance in Lab). */
export function nearestGoogleColorId(hex: string): string {
  const target = rgbToLab(hexToRgb(hex))
  let best = '7'
  let bestD = Infinity
  for (const [id, { hex: h }] of Object.entries(GOOGLE_EVENT_COLORS)) {
    const [l, a, b] = rgbToLab(hexToRgb(h))
    const d = (l - target[0]) ** 2 + (a - target[1]) ** 2 + (b - target[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = id
    }
  }
  return best
}

export function eventTitle(med: Medication): string {
  return `💊 ${[med.name, med.strength].filter(Boolean).join(' ')}`.trim()
}

export function doseLine(med: Medication): string {
  const amt = `${trim(med.doseAmount)} ${med.doseUnit || med.form}`.trim()
  return med.strength ? `${amt} (${med.strength})` : amt
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

export function doseKey(medicationId: string, dueAt: Date): string {
  return `${medicationId}@${dueAt.toISOString()}`
}

/** Google allows at most 5 reminder overrides, each 0..40320 minutes. */
export function reminderOverrides(offsets: number[]): { method: 'popup'; minutes: number }[] {
  const all = [...new Set([...offsets, 0])].filter((m) => m >= 0 && m <= 40320).sort((a, b) => b - a)
  // Keep the due-time reminder plus the closest offsets if we must drop some.
  const keep = all.length > 5 ? [...all.slice(-5)] : all
  return keep.map((minutes) => ({ method: 'popup' as const, minutes }))
}

export function buildDoseEvent(med: Medication, dueAt: Date, zone: string, offsets: number[], kind: 'scheduled' | 'available' = 'scheduled'): CalendarEventBody {
  const lines = [`Dose: ${doseLine(med)}`]
  if (med.instructions) lines.push(`Instructions: ${med.instructions}`)
  if (med.notes) lines.push(`Notes: ${med.notes}`)
  if (kind === 'available') lines.push('', 'As-needed medication: this is when the next dose becomes available.')
  lines.push('', 'Managed by Doseline. Log doses in the app; changes made here are overwritten.')
  const end = new Date(dueAt.getTime() + 15 * MINUTE)
  return {
    summary: kind === 'available' ? `${eventTitle(med)} · available` : eventTitle(med),
    description: lines.join('\n'),
    start: { dateTime: dueAt.toISOString(), timeZone: zone },
    end: { dateTime: end.toISOString(), timeZone: zone },
    reminders: { useDefault: false, overrides: reminderOverrides(offsets) },
    colorId: nearestGoogleColorId(med.color),
    transparency: 'transparent',
    extendedProperties: {
      private: { app: APP_MARKER, kind: 'dose', medicationId: med.id, doseId: doseKey(med.id, dueAt) },
    },
  }
}

export function buildRefillEvent(med: Medication, date: string, unitsLeft: number): CalendarEventBody {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
  return {
    summary: `🔁 Refill ${[med.name, med.strength].filter(Boolean).join(' ')}`,
    description: `About ${unitsLeft} ${med.doseUnit || med.form || 'units'} left.\n\nManaged by Doseline.`,
    start: { date },
    end: { date: next },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    colorId: nearestGoogleColorId(med.color),
    transparency: 'transparent',
    extendedProperties: { private: { app: APP_MARKER, kind: 'refill', medicationId: med.id, doseId: `${med.id}@refill` } },
  }
}

/** Fields we compare to decide whether an existing event needs a patch. */
export function eventNeedsUpdate(existing: CalendarEventBody, desired: CalendarEventBody): boolean {
  const norm = (e: CalendarEventBody) =>
    JSON.stringify({
      s: e.summary,
      d: e.description,
      st: e.start.dateTime ? new Date(e.start.dateTime).getTime() : e.start.date,
      en: e.end.dateTime ? new Date(e.end.dateTime).getTime() : e.end.date,
      r: (e.reminders?.overrides ?? []).map((o) => o.minutes).sort((a, b) => a - b),
      c: e.colorId,
      k: e.extendedProperties?.private?.doseId,
    })
  return norm(existing) !== norm(desired)
}
