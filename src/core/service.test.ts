import { beforeEach, describe, expect, it } from 'vitest'
import { DoseService } from './service'
import { CalendarSync } from './sync'
import { MemoryRepository } from './memoryRepository'
import { computeNextDue } from './schedule'
import { FakeCalendar, FakeClock, med, nextId, silentLogger } from './testkit'
import { MINUTE } from './time'
import type { Medication } from './types'

const NY = 'America/New_York'

function setup(start = '2026-05-04T11:00:00Z') {
  const repo = new MemoryRepository()
  const clock = new FakeClock(new Date(start))
  const cal = new FakeCalendar()
  const changed: string[][] = []
  const sync = new CalendarSync({
    repo,
    gateway: cal,
    auth: { isConnected: async () => true, getAccessToken: async () => 't' },
    clock,
    zone: () => NY,
    logger: silentLogger,
    random: () => 0.5,
  })
  const svc = new DoseService({
    repo,
    clock,
    zone: () => NY,
    newId: nextId,
    onChanged: async (ids) => {
      changed.push(ids)
      await sync.enqueueMeds(ids)
      await sync.run()
    },
  })
  return { repo, clock, cal, sync, svc, changed }
}

async function addDaily(svc: DoseService, over: Partial<Medication> = {}) {
  const base = med({ type: 'fixed', times: ['08:00', '20:00'], days: [1, 2, 3, 4, 5, 6, 7] })
  const { id: _id, createdAt: _c, updatedAt: _u, pauses: _p, ...rest } = base
  return svc.saveMedication({ ...rest, inventory: { count: 30, unitsPerDose: 1, refillThreshold: 5, refillEvent: false }, ...over })
}

describe('DoseService', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('creating a med schedules exactly one calendar event', async () => {
    const m = await addDaily(ctx.svc)
    const evs = ctx.cal.allEvents()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.extendedProperties.private).toMatchObject({ app: 'doseline', medicationId: m.id, kind: 'dose' })
    expect(evs[0]!.start.dateTime).toBe('2026-05-04T12:00:00.000Z')
  })

  it('logging decrements inventory, advances the schedule and replaces the event', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:05:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    expect(r.log.scheduledFor).toBe('2026-05-04T12:00:00.000Z')
    expect(r.log.inventoryDelta).toBe(1)
    expect((await ctx.repo.getMedication(m.id))!.inventory!.count).toBe(29)
    const evs = ctx.cal.allEvents()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.start.dateTime).toBe('2026-05-05T00:00:00.000Z')
  })

  it('undo fully reverses inventory, schedule and calendar', async () => {
    const m = await addDaily(ctx.svc)
    const eventIdBefore = ctx.cal.allEvents()[0]!.id
    ctx.clock.set('2026-05-04T12:05:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    ctx.clock.advance(5_000)
    expect(await ctx.svc.undo(r.undoToken)).toBe(true)
    const after = (await ctx.repo.getMedication(m.id))!
    expect(after.inventory!.count).toBe(30)
    expect(await ctx.repo.listLogs()).toHaveLength(0)
    expect(computeNextDue(after, [], ctx.clock.now(), NY)!.dueAt.toISOString()).toBe('2026-05-04T12:00:00.000Z')
    const evs = ctx.cal.allEvents()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.id).toBe(eventIdBefore) // patched in place, never duplicated
    expect(evs[0]!.start.dateTime).toBe('2026-05-04T12:00:00.000Z')
  })

  it('undo only works for the last action and within the window', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:05:00Z')
    const first = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    ctx.clock.set('2026-05-05T00:05:00Z')
    const second = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    expect(await ctx.svc.undo(first.undoToken)).toBe(false)
    ctx.clock.advance(60_000)
    expect(ctx.svc.canUndo(second.undoToken)).toBe(false)
    expect(await ctx.svc.undo(second.undoToken)).toBe(false)
    expect(await ctx.repo.listLogs()).toHaveLength(2)
  })

  it('skip advances the schedule without touching inventory', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:30:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'skipped' })
    expect(r.log.kind).toBe('skipped')
    expect(r.log.scheduledFor).toBe('2026-05-04T12:00:00.000Z')
    expect((await ctx.repo.getMedication(m.id))!.inventory!.count).toBe(30)
    expect(ctx.cal.allEvents()[0]!.start.dateTime).toBe('2026-05-05T00:00:00.000Z')
  })

  it('undo of a skip restores the pending dose', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:30:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'skipped' })
    await ctx.svc.undo(r.undoToken)
    expect(ctx.cal.allEvents()[0]!.start.dateTime).toBe('2026-05-04T12:00:00.000Z')
  })

  it('backdated "took it at" logs fulfil the right slot', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T15:00:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken', at: new Date('2026-05-04T12:10:00Z') })
    expect(r.log.takenAt).toBe('2026-05-04T12:10:00.000Z')
    expect(r.log.scheduledFor).toBe('2026-05-04T12:00:00.000Z')
  })

  it('future times are clamped to now', async () => {
    const m = await addDaily(ctx.svc)
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken', at: new Date('2026-05-09T00:00:00Z') })
    expect(r.log.takenAt).toBe(ctx.clock.now().toISOString())
  })

  it('returns safety warnings but still logs (never blocks)', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:00:00Z')
    await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    ctx.clock.advance(5 * MINUTE)
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    expect(r.warnings.map((w) => w.code)).toContain('duplicate')
    expect(await ctx.repo.listLogs()).toHaveLength(2)
  })

  it('inventory never goes below zero', async () => {
    const m = await addDaily(ctx.svc, { inventory: { count: 0, unitsPerDose: 1, refillThreshold: 5, refillEvent: false } })
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    expect(r.log.inventoryDelta).toBe(0)
    expect((await ctx.repo.getMedication(m.id))!.inventory!.count).toBe(0)
  })

  it('editing the latest log reschedules', async () => {
    const iv = med({ type: 'interval', everyHours: 6 })
    const { id: _i, createdAt: _c, updatedAt: _u, pauses: _p, ...rest } = iv
    const m = await ctx.svc.saveMedication(rest)
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    expect(ctx.cal.allEvents()[0]!.start.dateTime).toBe('2026-05-04T17:00:00.000Z')
    await ctx.svc.updateLog(r.log.id, { takenAt: '2026-05-04T10:00:00Z' })
    expect(ctx.cal.allEvents()).toHaveLength(1)
    expect(ctx.cal.allEvents()[0]!.start.dateTime).toBe('2026-05-04T16:00:00.000Z')
  })

  it('changing a log from taken to skipped restores inventory, and back again consumes it', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:05:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    await ctx.svc.updateLog(r.log.id, { kind: 'skipped' })
    expect((await ctx.repo.getMedication(m.id))!.inventory!.count).toBe(30)
    await ctx.svc.updateLog(r.log.id, { kind: 'taken' })
    expect((await ctx.repo.getMedication(m.id))!.inventory!.count).toBe(29)
  })

  it('deleting a log restores inventory and reschedules', async () => {
    const m = await addDaily(ctx.svc)
    ctx.clock.set('2026-05-04T12:05:00Z')
    const r = await ctx.svc.logDose({ medicationId: m.id, kind: 'taken' })
    await ctx.svc.deleteLog(r.log.id)
    expect((await ctx.repo.getMedication(m.id))!.inventory!.count).toBe(30)
    expect(ctx.cal.allEvents()[0]!.start.dateTime).toBe('2026-05-04T12:00:00.000Z')
  })

  it('pausing removes the event; resuming records the pause range', async () => {
    const m = await addDaily(ctx.svc)
    await ctx.svc.setActive(m.id, false)
    expect(ctx.cal.allEvents()).toHaveLength(0)
    ctx.clock.set('2026-05-06T11:00:00Z')
    const resumed = await ctx.svc.setActive(m.id, true)
    expect(resumed.pauses).toEqual([{ from: '2026-05-04T11:00:00.000Z', to: '2026-05-06T11:00:00.000Z' }])
    expect(ctx.cal.allEvents()[0]!.start.dateTime).toBe('2026-05-06T12:00:00.000Z')
  })

  it('deleting a med deletes its event', async () => {
    const m = await addDaily(ctx.svc)
    await ctx.svc.deleteMedication(m.id)
    expect(ctx.cal.allEvents()).toHaveLength(0)
  })

  it('PRN cannot be skipped', async () => {
    const p = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: false })
    const { id: _i, createdAt: _c, updatedAt: _u, pauses: _p, ...rest } = p
    const m = await ctx.svc.saveMedication(rest)
    await expect(ctx.svc.logDose({ medicationId: m.id, kind: 'skipped' })).rejects.toThrow()
  })

  it('rejects invalid medications', async () => {
    const p = med({ type: 'fixed', times: [], days: [1] })
    const { id: _i, createdAt: _c, updatedAt: _u, pauses: _p, ...rest } = p
    await expect(ctx.svc.saveMedication(rest)).rejects.toThrow(/dose time/)
  })

  it('settings updates normalise reminder offsets and grace window', async () => {
    const s = await ctx.svc.updateSettings({ reminderOffsets: [15, 30, 15, -5, 0], graceMinutes: 0 })
    expect(s.reminderOffsets).toEqual([30, 15])
    expect(s.graceMinutes).toBe(1)
  })
})
