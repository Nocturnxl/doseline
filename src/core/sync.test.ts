import { describe, expect, it } from 'vitest'
import { CalendarSync, backoffMs, refillTarget } from './sync'
import { MemoryRepository } from './memoryRepository'
import { AuthRequiredError, GatewayError } from './ports'
import { FakeCalendar, FakeClock, med, silentLogger, taken } from './testkit'
import { buildDoseEvent } from './calendar'

const NY = 'America/New_York'

function setup(connected = true) {
  const repo = new MemoryRepository()
  const clock = new FakeClock(new Date('2026-05-04T11:00:00Z'))
  const cal = new FakeCalendar()
  const sync = new CalendarSync({
    repo,
    gateway: cal,
    auth: {
      isConnected: async () => connected,
      getAccessToken: async () => 't',
    },
    clock,
    zone: () => NY,
    logger: silentLogger,
    random: () => 0.5,
  })
  return { repo, clock, cal, sync }
}

const daily = () => med({ type: 'fixed', times: ['08:00', '20:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { createdAt: '2026-05-04T10:00:00Z' })

describe('CalendarSync', () => {
  it('creates the Medications calendar once and an event per med', async () => {
    const { repo, cal, sync } = setup()
    const a = daily()
    const b = { ...daily(), id: 'b', name: 'Metformin' }
    await repo.saveMedication(a)
    await repo.saveMedication(b)
    await sync.enqueueAll()
    await sync.run()
    expect(cal.calendars.size).toBe(1)
    expect(cal.allEvents()).toHaveLength(2)
    expect(sync.getStatus()).toMatchObject({ state: 'idle', pending: 0 })
  })

  it('is idempotent: re-running does not duplicate or rewrite', async () => {
    const { repo, cal, sync } = setup()
    const a = daily()
    await repo.saveMedication(a)
    await sync.enqueueMeds([a.id])
    await sync.run()
    cal.calls = []
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(cal.allEvents()).toHaveLength(1)
    expect(cal.calls.filter((c) => c === 'insertEvent' || c === 'patchEvent')).toEqual([])
  })

  it('cleans up duplicates left behind by an earlier crash', async () => {
    const { repo, cal, sync } = setup()
    const a = daily()
    await repo.saveMedication(a)
    await sync.enqueueMeds([a.id])
    await sync.run()
    const calId = [...cal.calendars.keys()][0]!
    await cal.insertEvent(calId, buildDoseEvent(a, new Date('2026-05-03T12:00:00Z'), NY, [30]))
    expect(cal.allEvents()).toHaveLength(2)
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(cal.allEvents()).toHaveLength(1)
    expect(cal.allEvents()[0]!.start.dateTime).toBe('2026-05-04T12:00:00.000Z')
  })

  it('queues while offline and retries with backoff', async () => {
    const { repo, cal, clock, sync } = setup()
    const a = daily()
    await repo.saveMedication(a)
    cal.failNext.push(new GatewayError('offline', 'fetch failed'))
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(sync.getStatus().state).toBe('offline')
    expect(sync.getStatus().pending).toBeGreaterThan(0)
    expect(cal.allEvents()).toHaveLength(0)
    // Not yet due for retry.
    await sync.run()
    expect(cal.allEvents()).toHaveLength(0)
    clock.advance(31_000)
    await sync.run()
    expect(cal.allEvents()).toHaveLength(1)
    expect(sync.getStatus().state).toBe('idle')
  })

  it('collapses multiple changes made offline into the latest state', async () => {
    const { repo, cal, clock, sync } = setup()
    const a = daily()
    await repo.saveMedication(a)
    cal.failNext.push(new GatewayError('offline', 'fetch failed'))
    await sync.enqueueMeds([a.id])
    await sync.run()
    await repo.saveLog(taken(a.id, '2026-05-04T12:00:00Z', '2026-05-04T12:00:00Z'))
    clock.set('2026-05-04T12:01:00Z')
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(cal.allEvents()).toHaveLength(1)
    expect(cal.allEvents()[0]!.start.dateTime).toBe('2026-05-05T00:00:00.000Z')
  })

  it('enters the reconnect state on revoked grants instead of failing', async () => {
    const { repo, sync, cal } = setup()
    const a = daily()
    await repo.saveMedication(a)
    cal.failNext.push(new AuthRequiredError())
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(sync.getStatus().state).toBe('reconnect')
    expect(sync.getStatus().pending).toBeGreaterThan(0)
    // Further runs are paused until the user reconnects.
    await sync.run()
    expect(cal.allEvents()).toHaveLength(0)
    sync.authRestored()
    await sync.run()
    expect(cal.allEvents()).toHaveLength(1)
    expect(sync.getStatus().state).toBe('idle')
  })

  it('does nothing when Google is not connected', async () => {
    const { repo, cal, sync } = setup(false)
    const a = daily()
    await repo.saveMedication(a)
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(cal.calls).toEqual([])
    expect(sync.getStatus().state).toBe('disabled')
  })

  it('recreates the calendar if the user deleted it', async () => {
    const { repo, cal, sync } = setup()
    const a = daily()
    await repo.saveMedication(a)
    await sync.enqueueMeds([a.id])
    await sync.run()
    cal.calendars.clear()
    await sync.enqueueMeds([a.id])
    await sync.run()
    expect(cal.calendars.size).toBe(1)
    expect(cal.allEvents().filter((e) => cal.events.get([...cal.calendars.keys()][0]!)!.has(e.id))).toHaveLength(1)
  })

  it('drops a job after repeated client errors', async () => {
    const { repo, cal, clock, sync } = setup()
    const a = daily()
    await repo.saveMedication(a)
    await sync.enqueue([a.id])
    for (let i = 0; i < 5; i++) {
      cal.failNext.push(new GatewayError('client', 'bad request', 400))
      await sync.run()
      clock.advance(60 * 60_000)
    }
    expect(await repo.listSyncJobs()).toHaveLength(0)
  })

  it('PRN meds get an "available" event only when enabled', async () => {
    const { repo, cal, sync } = setup()
    const off = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: false }, { id: 'off' })
    const on = med({ type: 'prn', minIntervalHours: 4, notifyWhenAvailable: true }, { id: 'on' })
    await repo.saveMedication(off)
    await repo.saveMedication(on)
    await repo.saveLog(taken('off', '2026-05-04T10:00:00Z'))
    await repo.saveLog(taken('on', '2026-05-04T10:00:00Z'))
    await sync.enqueueAll()
    await sync.run()
    const evs = cal.allEvents()
    expect(evs).toHaveLength(1)
    expect(evs[0]!.extendedProperties.private.medicationId).toBe('on')
    expect(evs[0]!.summary).toContain('available')
  })

  it('creates a refill event when supply is low, and removes it after restocking', async () => {
    const { repo, cal, sync } = setup()
    const a = { ...daily(), inventory: { count: 3, unitsPerDose: 1, refillThreshold: 5, refillEvent: true } }
    await repo.saveMedication(a)
    await sync.enqueue([refillTarget(a.id)])
    await sync.run()
    const refill = cal.allEvents().filter((e) => e.extendedProperties.private.kind === 'refill')
    expect(refill).toHaveLength(1)
    expect(refill[0]!.start.date).toBe('2026-05-04')
    await repo.saveMedication({ ...a, inventory: { ...a.inventory, count: 60 } })
    await sync.enqueue([refillTarget(a.id)])
    await sync.run()
    expect(cal.allEvents().filter((e) => e.extendedProperties.private.kind === 'refill')).toHaveLength(0)
  })

  it('reset clears queue and links', async () => {
    const { repo, sync } = setup()
    await sync.enqueue(['x'])
    await sync.reset()
    expect(await repo.listSyncJobs()).toHaveLength(0)
  })

  it('backoff grows exponentially and caps at 30 minutes', () => {
    const r = () => 0.5
    expect(backoffMs(1, r)).toBe(30_000)
    expect(backoffMs(2, r)).toBe(60_000)
    expect(backoffMs(3, r)).toBe(120_000)
    expect(backoffMs(20, r)).toBe(30 * 60_000)
  })
})
