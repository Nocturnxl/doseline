import { describe, expect, it } from 'vitest'
import { adherenceOverDays, currentStreak, heatmap, outcomesForMed, summarize } from './adherence'
import { med, skipped, taken } from './testkit'

const NY = 'America/New_York'
const daily8 = () => med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { createdAt: '2026-05-01T04:00:00Z' }) // created May 1, 00:00 NY

describe('adherence', () => {
  it('classifies on-time, late, skipped and missed doses with the grace window', () => {
    const m = daily8()
    const logs = [
      taken(m.id, '2026-05-01T12:20:00Z', '2026-05-01T12:00:00Z'), // +20m on time
      taken(m.id, '2026-05-02T14:30:00Z', '2026-05-02T12:00:00Z'), // +2.5h late
      skipped(m.id, '2026-05-03T12:00:00Z', '2026-05-03T12:00:00Z'),
      // May 4 missed
      taken(m.id, '2026-05-05T11:05:00Z', '2026-05-05T12:00:00Z'), // 55m early, within 60
    ]
    const now = new Date('2026-05-05T20:00:00Z')
    const out = outcomesForMed(m, logs, new Date('2026-05-01T04:00:00Z'), now, now, NY, 60)
    expect(out.map((o) => o.status)).toEqual(['onTime', 'late', 'skipped', 'missed', 'onTime'])
    const s = summarize(out)
    expect(s).toMatchObject({ expected: 5, onTime: 2, late: 1, skipped: 1, missed: 1 })
    expect(s.onTimeRate).toBeCloseTo(0.4)
  })

  it('a narrower grace window turns on-time into late', () => {
    const m = daily8()
    const logs = [taken(m.id, '2026-05-01T12:20:00Z', '2026-05-01T12:00:00Z')]
    const now = new Date('2026-05-01T20:00:00Z')
    expect(outcomesForMed(m, logs, new Date('2026-05-01T04:00:00Z'), now, now, NY, 15)[0]!.status).toBe('late')
  })

  it('the currently pending slot is not counted as missed', () => {
    const m = daily8()
    const now = new Date('2026-05-01T12:30:00Z') // 08:30 NY, 08:00 slot pending
    expect(outcomesForMed(m, [], new Date('2026-05-01T04:00:00Z'), now, now, NY, 60)).toEqual([])
  })

  it('7/30/90-day windows only count days since the med was created', () => {
    const m = daily8()
    const logs = [taken(m.id, '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z'), taken(m.id, '2026-05-02T12:00:00Z', '2026-05-02T12:00:00Z')]
    const now = new Date('2026-05-02T20:00:00Z')
    expect(adherenceOverDays(m, logs, 7, now, NY, 60)).toMatchObject({ expected: 2, onTime: 2, onTimeRate: 1 })
    expect(adherenceOverDays(m, logs, 90, now, NY, 60).expected).toBe(2)
  })

  it('PRN meds have no adherence', () => {
    const prn = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: false })
    const now = new Date('2026-05-02T20:00:00Z')
    expect(adherenceOverDays(prn, [taken(prn.id, '2026-05-02T10:00:00Z')], 7, now, NY, 60).onTimeRate).toBeNull()
  })

  it('interval doses are judged against when they were due', () => {
    const m = med({ type: 'interval', everyHours: 12, firstDoseAt: '2026-05-01T12:00:00Z' }, { createdAt: '2026-05-01T04:00:00Z' })
    const logs = [taken(m.id, '2026-05-01T12:10:00Z', '2026-05-01T12:00:00Z'), taken(m.id, '2026-05-02T03:00:00Z', '2026-05-02T00:10:00Z')]
    const now = new Date('2026-05-02T05:00:00Z')
    expect(outcomesForMed(m, logs, new Date('2026-05-01T00:00:00Z'), now, now, NY, 60).map((o) => o.status)).toEqual(['onTime', 'late'])
  })

  it('streak counts consecutive perfect days and stops at a bad day', () => {
    const m = daily8()
    const logs = [
      taken(m.id, '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z'),
      // May 2 missed
      taken(m.id, '2026-05-03T12:00:00Z', '2026-05-03T12:00:00Z'),
      taken(m.id, '2026-05-04T12:00:00Z', '2026-05-04T12:00:00Z'),
      taken(m.id, '2026-05-05T12:00:00Z', '2026-05-05T12:00:00Z'),
    ]
    expect(currentStreak([m], logs, new Date('2026-05-05T20:00:00Z'), NY, 60)).toBe(3)
  })

  it("today's pending dose doesn't break the streak", () => {
    const m = daily8()
    const logs = [taken(m.id, '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z'), taken(m.id, '2026-05-02T12:00:00Z', '2026-05-02T12:00:00Z')]
    expect(currentStreak([m], logs, new Date('2026-05-03T11:00:00Z'), NY, 60)).toBe(2)
  })

  it('heatmap buckets by local day, across a DST change', () => {
    const m = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { createdAt: '2026-03-06T05:00:00Z' })
    const logs = [
      taken(m.id, '2026-03-07T13:00:00Z', '2026-03-07T13:00:00Z'),
      taken(m.id, '2026-03-08T12:00:00Z', '2026-03-08T12:00:00Z'), // DST day: 08:00 EDT
    ]
    const days = heatmap([m], logs, 4, new Date('2026-03-09T20:00:00Z'), NY, 60)
    expect(days.map((d) => d.date)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'])
    // Mar 6 missed; Mar 9 still pending (not counted yet).
    expect(days.map((d) => d.rate)).toEqual([0, 1, 1, null])
  })
})
