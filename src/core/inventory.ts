import type { DoseLog, Medication } from './types'
import { DAY } from './time'
import { logsFor, scheduledDosesPerDay } from './schedule'

export interface InventoryStatus {
  count: number
  dosesRemaining: number
  /** Estimated days until empty, or null when usage can't be estimated (e.g. PRN with no history). */
  daysOfSupply: number | null
  runOutDate: Date | null
  low: boolean
}

/** Units consumed by one logged dose. */
export function unitsPerDose(med: Medication): number {
  return med.inventory ? Math.max(0, med.inventory.unitsPerDose) : 0
}

/** Average doses/day for PRN meds over the last 14 days, from history. */
function prnDosesPerDay(med: Medication, logs: DoseLog[], now: Date): number | null {
  const since = now.getTime() - 14 * DAY
  const taken = logsFor(med.id, logs).filter((l) => l.kind === 'taken' && new Date(l.takenAt).getTime() >= since)
  if (taken.length === 0) return null
  return taken.length / 14
}

export function inventoryStatus(med: Medication, logs: DoseLog[], now: Date): InventoryStatus | null {
  const inv = med.inventory
  if (!inv) return null
  const perDose = Math.max(inv.unitsPerDose, 0)
  const dosesRemaining = perDose > 0 ? Math.floor(inv.count / perDose) : 0
  const perDay = med.schedule.type === 'prn' ? prnDosesPerDay(med, logs, now) : scheduledDosesPerDay(med)
  const unitsPerDay = perDay != null ? perDay * perDose : null
  const daysOfSupply = unitsPerDay && unitsPerDay > 0 ? inv.count / unitsPerDay : null
  return {
    count: inv.count,
    dosesRemaining,
    daysOfSupply,
    runOutDate: daysOfSupply != null ? new Date(now.getTime() + daysOfSupply * DAY) : null,
    low: inv.count <= inv.refillThreshold,
  }
}

/** Apply a dose to inventory, never going below zero. Returns the new med and units actually removed. */
export function consumeInventory(med: Medication): { med: Medication; delta: number } {
  if (!med.inventory) return { med, delta: 0 }
  const delta = Math.min(med.inventory.count, unitsPerDose(med))
  return { med: { ...med, inventory: { ...med.inventory, count: med.inventory.count - delta } }, delta }
}

export function restoreInventory(med: Medication, delta: number): Medication {
  if (!med.inventory || delta <= 0) return med
  return { ...med, inventory: { ...med.inventory, count: med.inventory.count + delta } }
}
