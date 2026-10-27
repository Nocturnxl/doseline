import { describe, expect, it } from 'vitest'
import { buildDemoData } from './demo'
import { adherenceOverDays } from './adherence'
import { validateMedication } from './validation'
import { computeNextDue } from './schedule'

const NY = 'America/New_York'
const now = new Date('2026-10-27T15:00:00Z')
const ids = () => {
  let n = 0
  return () => `demo${++n}`
}

describe('demo data', () => {
  it('is valid, deterministic and entirely in the past', () => {
    const a = buildDemoData(now, NY, ids())
    const b = buildDemoData(now, NY, ids())
    expect(a).toEqual(b)
    expect(a.medications.map((m) => m.name)).toEqual(['Lisinopril', 'Metformin', 'Vitamin D3', 'Amoxicillin', 'Ibuprofen'])
    for (const m of a.medications) expect(validateMedication(m)).toEqual([])
    expect(a.logs.length).toBeGreaterThan(150)
    expect(a.logs.every((l) => new Date(l.takenAt) <= now)).toBe(true)
    expect(new Set(a.logs.map((l) => l.id)).size).toBe(a.logs.length)
  })

  it('looks like real use: mostly on time, some late, skipped and missed, and something pending', () => {
    const { medications, logs } = buildDemoData(now, NY, ids())
    const lis = medications[0]!
    const st = adherenceOverDays(lis, logs, 30, now, NY, 60)
    expect(st.onTimeRate!).toBeGreaterThan(0.7)
    expect(st.onTimeRate!).toBeLessThan(1)
    expect(st.late + st.skipped + st.missed).toBeGreaterThan(0)
    expect(medications.every((m) => m.schedule.type === 'prn' || computeNextDue(m, logs, now, NY))).toBe(true)
  })
})
