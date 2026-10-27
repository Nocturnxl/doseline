import { describe, expect, it } from 'vitest'
import { buildReport, logsToCsv, makeBackup, parseBackup } from './exporting'
import { inventoryStatus, consumeInventory, restoreInventory } from './inventory'
import { todayTimeline, upNext } from './today'
import { validateMedication } from './validation'
import { DEFAULT_SETTINGS } from './types'
import { med, skipped, taken } from './testkit'
import { formatDuration } from './time'

const NY = 'America/New_York'

describe('CSV export', () => {
  it('writes a header and escapes awkward values', () => {
    const m = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { id: 'a', name: 'Vit, D "3"' })
    const csv = logsToCsv(
      [
        taken('a', '2026-05-04T12:10:00Z', '2026-05-04T12:00:00Z', { note: '=SUM(A1)' }),
        skipped('a', '2026-05-05T12:00:00Z', '2026-05-05T12:00:00Z'),
        taken('a', '2026-05-06T13:05:00Z', '2026-05-06T12:00:00Z', { escalatedAt: '2026-05-06T12:30:00.000Z', escalationRepeats: 2 }),
      ],
      [m],
      NY,
    )
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('date,time,medication,strength,dose,status,scheduled_for,minutes_from_schedule,escalated_at,escalation_repeats,note')
    expect(lines[1]).toBe(`2026-05-04,08:10,"Vit, D ""3""",10 mg,1 tablet (10 mg),taken,2026-05-04 08:00,10,,,'=SUM(A1)`)
    expect(lines[2]).toContain(',skipped,')
    expect(lines[3]).toBe(`2026-05-06,09:05,"Vit, D ""3""",10 mg,1 tablet (10 mg),taken,2026-05-06 08:00,65,2026-05-06 08:30,2,`)
  })
})

describe('backup', () => {
  it('round-trips and validates', () => {
    const m = med({ type: 'interval', everyHours: 8 }, { id: 'a' })
    const b = makeBackup([m], [taken('a', '2026-05-04T12:00:00Z'), taken('ghost', '2026-05-04T12:00:00Z')], DEFAULT_SETTINGS, new Date('2026-05-04T00:00:00Z'))
    const parsed = parseBackup(JSON.parse(JSON.stringify(b)))
    expect(parsed.medications).toHaveLength(1)
    expect(parsed.logs).toHaveLength(1) // orphaned log dropped
  })

  it('rejects foreign or future files', () => {
    expect(() => parseBackup({ foo: 1 })).toThrow(/not a Doseline backup/)
    expect(() => parseBackup({ app: 'doseline', version: 99, medications: [], logs: [] })).toThrow(/newer version/)
    expect(() => parseBackup({ app: 'doseline', version: 1, medications: [{ ...med({ type: 'interval', everyHours: 0 }) }], logs: [] })).toThrow(/invalid/)
  })
})

describe('report', () => {
  it('includes per-med stats and missed doses', () => {
    const m = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { id: 'a', createdAt: '2026-05-01T04:00:00Z' })
    const r = buildReport([m], [taken('a', '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z')], new Date('2026-05-01T04:00:00Z'), new Date('2026-05-03T04:00:00Z'), new Date('2026-05-03T20:00:00Z'), NY, 60)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0]!.stats).toMatchObject({ expected: 2, onTime: 1, missed: 1 })
    expect(r.sections[0]!.entries.map((e) => e.kind)).toEqual(['taken', 'missed'])
  })
})

describe('inventory', () => {
  const m = med({ type: 'fixed', times: ['08:00', '20:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { inventory: { count: 10, unitsPerDose: 1, refillThreshold: 10, refillEvent: false } })
  it('estimates days of supply and flags low stock', () => {
    const s = inventoryStatus(m, [], new Date('2026-05-04T00:00:00Z'))!
    expect(s.dosesRemaining).toBe(10)
    expect(s.daysOfSupply).toBeCloseTo(5)
    expect(s.low).toBe(true)
    expect(s.runOutDate!.toISOString()).toBe('2026-05-09T00:00:00.000Z')
  })
  it('estimates PRN usage from history, or not at all', () => {
    const prn = { ...m, schedule: { type: 'prn' as const, minIntervalHours: 4, notifyWhenAvailable: false } }
    expect(inventoryStatus(prn, [], new Date())!.daysOfSupply).toBeNull()
    const logs = Array.from({ length: 7 }, (_, i) => taken(prn.id, `2026-05-0${i + 1}T12:00:00Z`))
    expect(inventoryStatus(prn, logs, new Date('2026-05-08T00:00:00Z'))!.daysOfSupply).toBeCloseTo(20)
  })
  it('consume and restore are inverse', () => {
    const c = consumeInventory(m)
    expect(c.delta).toBe(1)
    expect(restoreInventory(c.med, c.delta).inventory!.count).toBe(10)
    expect(inventoryStatus({ ...m, inventory: null }, [], new Date())).toBeNull()
  })
})

describe('today view', () => {
  const m = med({ type: 'fixed', times: ['08:00', '13:00', '20:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { id: 'a', createdAt: '2026-05-01T00:00:00Z' })
  const iv = med({ type: 'interval', everyHours: 6, firstDoseAt: '2026-05-04T14:00:00Z' }, { id: 'b', name: 'Amoxicillin' })
  const prn = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: false }, { id: 'c', name: 'Ibuprofen' })

  it('builds a timeline of taken, missed, due and upcoming doses', () => {
    const logs = [taken('a', '2026-05-04T12:05:00Z', '2026-05-04T12:00:00Z')]
    const now = new Date('2026-05-04T18:00:00Z') // 14:00 NY: 13:00 slot is pending (due)
    const t = todayTimeline([m], logs, now, NY, 60).map((i) => i.status)
    expect(t).toEqual(['taken', 'due', 'upcoming'])
  })

  it('projects interval doses for the rest of the day', () => {
    const t = todayTimeline([iv], [], new Date('2026-05-04T13:00:00Z'), NY, 60)
    expect(t.map((i) => [i.at.toISOString(), !!i.projected])).toEqual([
      ['2026-05-04T14:00:00.000Z', false],
      ['2026-05-04T20:00:00.000Z', true],
      ['2026-05-05T02:00:00.000Z', true],
    ])
  })

  it('orders up-next by due time and shows PRN availability', () => {
    const now = new Date('2026-05-04T13:00:00Z')
    const u = upNext([m, iv, prn], [taken('c', '2026-05-04T12:00:00Z')], now, NY, 60)
    expect(u.map((i) => [i.med.id, i.status])).toEqual([
      ['a', 'due'], // 08:00 slot, exactly 60 min ago: still within grace
      ['b', 'upcoming'],
      ['c', 'upcoming'],
    ])
    const u2 = upNext([prn], [], now, NY, 60)
    expect(u2[0]!.status).toBe('available')
  })
})

describe('misc', () => {
  it('formats durations', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(5 * 60_000 + 3000)).toBe('5m 03s')
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe('2h 05m')
    expect(formatDuration(-(26 * 3600_000))).toBe('-1d 2h')
  })
  it('validates medications', () => {
    const ok = med({ type: 'fixed', times: ['08:00'], days: [1] })
    expect(validateMedication(ok)).toEqual([])
    expect(validateMedication({ ...ok, name: ' ', color: 'red', schedule: { type: 'fixed', times: ['25:00'], days: [] } })).toHaveLength(4)
    expect(validateMedication({ ...ok, schedule: { type: 'prn', minIntervalHours: 4, maxPer24h: 0, notifyWhenAvailable: false } })).toHaveLength(1)
    expect(validateMedication({ ...ok, startDate: '2026-05-05', endDate: '2026-05-01' })).toHaveLength(1)
  })
})
