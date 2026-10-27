/**
 * Fictional demo dataset for screenshots and trying the app (Settings → developer tools →
 * "Load demo data"). Deterministic for a given `now`, so screenshots are reproducible.
 * Nothing here is anyone's real medication history.
 */
import type { DoseLog, Medication, Schedule } from './types'
import { DAY, HOUR, MINUTE, localDateKey } from './time'
import { fixedSlotsBetween } from './schedule'

export const DEMO_HISTORY_DAYS = 180

/** Small seeded PRNG (mulberry32), so the same day always produces the same history. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface DemoMed {
  key: string
  med: Omit<Medication, 'id' | 'createdAt' | 'updatedAt' | 'pauses'>
  /** Days of history before now. */
  since: number
}

function demoMeds(now: Date, zone: string): DemoMed[] {
  const fixed = (times: string[]): Schedule => ({ type: 'fixed', times, days: [1, 2, 3, 4, 5, 6, 7] })
  const course = new Date(now.getTime() - 3 * DAY + 2 * HOUR)
  return [
    {
      key: 'lisinopril',
      since: DEMO_HISTORY_DAYS,
      med: { name: 'Lisinopril', strength: '10 mg', form: 'tablet', doseAmount: 1, doseUnit: 'tablet', instructions: 'with food', notes: 'Blood pressure', color: '#7aa2ff', icon: 'pill', schedule: fixed(['08:00', '20:00']), active: true, inventory: { count: 24, unitsPerDose: 1, refillThreshold: 10, refillEvent: true } },
    },
    {
      key: 'metformin',
      since: DEMO_HISTORY_DAYS,
      med: { name: 'Metformin', strength: '500 mg', form: 'tablet', doseAmount: 1, doseUnit: 'tablet', instructions: 'with meals', notes: '', color: '#3cc5b0', icon: 'tablet', schedule: fixed(['07:30', '19:00']), active: true, inventory: { count: 9, unitsPerDose: 1, refillThreshold: 10, refillEvent: false } },
    },
    {
      key: 'vitd',
      since: 120,
      med: { name: 'Vitamin D3', strength: '2000 IU', form: 'capsule', doseAmount: 1, doseUnit: 'softgel', instructions: 'with breakfast', notes: '', color: '#d17ff0', icon: 'leaf', schedule: fixed(['09:00']), active: true, inventory: { count: 67, unitsPerDose: 1, refillThreshold: 14, refillEvent: false } },
    },
    {
      key: 'amoxicillin',
      since: 3,
      med: {
        name: 'Amoxicillin',
        strength: '500 mg',
        form: 'capsule',
        doseAmount: 1,
        doseUnit: 'capsule',
        instructions: 'finish the full course',
        notes: '7-day course',
        color: '#f2b84b',
        icon: 'capsule',
        schedule: { type: 'interval', everyHours: 8, firstDoseAt: course.toISOString() },
        active: true,
        endDate: localDateKey(new Date(course.getTime() + 7 * DAY), zone),
        inventory: { count: 12, unitsPerDose: 1, refillThreshold: 3, refillEvent: false },
      },
    },
    {
      key: 'ibuprofen',
      since: 30,
      med: { name: 'Ibuprofen', strength: '200 mg', form: 'tablet', doseAmount: 2, doseUnit: 'tablets', instructions: 'with water', notes: '', color: '#f26d8f', icon: 'tablet', schedule: { type: 'prn', minIntervalHours: 6, maxPer24h: 4, notifyWhenAvailable: true }, active: true, inventory: null },
    },
  ]
}

/** Medications and dose history, all fictional. Ids come from `newId`. */
export function buildDemoData(now: Date, zone: string, newId: () => string): { medications: Medication[]; logs: DoseLog[] } {
  const rand = rng(Math.floor(now.getTime() / DAY))
  const medications: Medication[] = []
  const logs: DoseLog[] = []
  const iso = (t: number) => new Date(t).toISOString()
  const log = (medicationId: string, kind: DoseLog['kind'], takenAt: number, scheduledFor: number | null, inventoryDelta: number) =>
    logs.push({ id: newId(), medicationId, kind, takenAt: iso(takenAt), scheduledFor: scheduledFor == null ? null : iso(scheduledFor), inventoryDelta, createdAt: iso(Math.min(takenAt + 2 * MINUTE, now.getTime())) })

  for (const d of demoMeds(now, zone)) {
    const created = now.getTime() - d.since * DAY
    const med: Medication = { ...d.med, id: newId(), pauses: [], createdAt: iso(created), updatedAt: iso(now.getTime()) }
    medications.push(med)
    const per = med.inventory?.unitsPerDose ?? 0
    const s = med.schedule
    if (s.type === 'fixed') {
      // Leave anything due in the last 90 minutes unlogged, so Today has something pending.
      for (const slot of fixedSlotsBetween(s, new Date(created), new Date(now.getTime() - 90 * MINUTE), zone)) {
        const t = slot.getTime()
        const r = rand()
        if (r < 0.84) log(med.id, 'taken', t + Math.round((rand() * 35 - 10) * MINUTE), t, per)
        else if (r < 0.9) log(med.id, 'taken', t + Math.round((70 + rand() * 90) * MINUTE), t, per)
        else if (r < 0.94) log(med.id, 'skipped', t + Math.round(rand() * 20 * MINUTE), t, 0)
        // else: missed (no log)
      }
    } else if (s.type === 'interval') {
      let due = new Date(s.firstDoseAt!).getTime()
      while (due < now.getTime() - 2 * HOUR) {
        const taken = due + Math.round((rand() * 40 - 5) * MINUTE)
        if (taken > now.getTime()) break
        log(med.id, 'taken', taken, due, per)
        due = taken + s.everyHours * HOUR
      }
    } else {
      for (let day = d.since; day >= 1; day--) {
        if (rand() > 0.3) continue
        const t = now.getTime() - day * DAY + Math.round((10 + rand() * 9) * HOUR)
        log(med.id, 'taken', t, null, per)
      }
    }
  }
  logs.sort((a, b) => a.takenAt.localeCompare(b.takenAt))
  return { medications, logs }
}
