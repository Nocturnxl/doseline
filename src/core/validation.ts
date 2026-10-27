import type { Medication } from './types'
import { MED_ICONS } from './types'
import { isValidClock } from './time'

const HEX = /^#[0-9a-f]{6}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateMedication(m: Medication): string[] {
  const e: string[] = []
  if (!m.name || !m.name.trim()) e.push('Name is required.')
  if (m.name && m.name.length > 80) e.push('Name is too long.')
  if (!(m.doseAmount > 0)) e.push('Dose amount must be greater than zero.')
  if (!HEX.test(m.color)) e.push('Color must be a hex value like #4f8cff.')
  if (!MED_ICONS.includes(m.icon)) e.push('Unknown icon.')
  if (m.startDate && !DATE.test(m.startDate)) e.push('Start date is invalid.')
  if (m.endDate && !DATE.test(m.endDate)) e.push('End date is invalid.')
  if (m.startDate && m.endDate && m.endDate < m.startDate) e.push('End date is before start date.')
  const s = m.schedule
  if (s.type === 'interval') {
    if (!(s.everyHours >= 0.25 && s.everyHours <= 24 * 14)) e.push('Interval must be between 15 minutes and 14 days.')
    if (s.firstDoseAt && Number.isNaN(Date.parse(s.firstDoseAt))) e.push('First dose time is invalid.')
  } else if (s.type === 'fixed') {
    if (s.times.length === 0) e.push('Add at least one dose time.')
    if (s.times.some((t) => !isValidClock(t))) e.push('Dose times must be HH:mm.')
    if (s.days.length === 0) e.push('Choose at least one day.')
    if (s.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) e.push('Invalid weekday.')
  } else if (s.type === 'prn') {
    if (!(s.minIntervalHours >= 0 && s.minIntervalHours <= 24 * 7)) e.push('Minimum interval must be between 0 and 168 hours.')
    if (s.maxPer24h != null && !(Number.isInteger(s.maxPer24h) && s.maxPer24h >= 1)) e.push('Max doses per 24h must be a whole number ≥ 1.')
  } else {
    e.push('Unknown schedule type.')
  }
  if (m.inventory) {
    const i = m.inventory
    if (!(i.count >= 0)) e.push('Inventory count cannot be negative.')
    if (!(i.unitsPerDose > 0)) e.push('Units per dose must be greater than zero.')
    if (!(i.refillThreshold >= 0)) e.push('Refill threshold cannot be negative.')
  }
  if (m.reminderOffsets && m.reminderOffsets.some((n) => !(n > 0 && n <= 10080))) e.push('Reminder offsets must be between 1 minute and 7 days.')
  const esc = m.escalationMinutes
  if (esc != null && esc !== 0 && !(Number.isInteger(esc) && esc >= 5 && esc <= 360)) e.push('Overdue alert must be between 5 minutes and 6 hours, or off.')
  return e
}
