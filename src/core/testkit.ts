/* Test helpers (not exported from the package index). */
import type { DoseLog, Medication, Schedule } from './types'
import type { AlarmPresenter, CalendarGateway, CalendarInfo, Clock, EscalationAlert, Logger, TimerScheduler } from './ports'
import { GatewayError } from './ports'
import type { CalendarEvent, CalendarEventBody } from './calendar'
import type { MissedDose, PlannedAlarm } from './alarms'

let seq = 0
export const nextId = () => `id${++seq}`

export function med(schedule: Schedule, over: Partial<Medication> = {}): Medication {
  return {
    id: over.id ?? nextId(),
    name: 'Lisinopril',
    strength: '10 mg',
    form: 'tablet',
    doseAmount: 1,
    doseUnit: 'tablet',
    instructions: 'with food',
    color: '#4f8cff',
    icon: 'pill',
    notes: '',
    schedule,
    active: true,
    pauses: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

export function taken(medicationId: string, at: string, scheduledFor?: string | null, over: Partial<DoseLog> = {}): DoseLog {
  return { id: nextId(), medicationId, kind: 'taken', takenAt: new Date(at).toISOString(), scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null, inventoryDelta: 0, createdAt: at, ...over }
}

export function skipped(medicationId: string, at: string, scheduledFor: string): DoseLog {
  return { id: nextId(), medicationId, kind: 'skipped', takenAt: new Date(at).toISOString(), scheduledFor: new Date(scheduledFor).toISOString(), inventoryDelta: 0, createdAt: at }
}

export class FakeClock implements Clock {
  constructor(public t: Date) {}
  now() {
    return new Date(this.t)
  }
  set(iso: string) {
    this.t = new Date(iso)
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms)
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

export class FakeTimers implements TimerScheduler {
  timers: { at: Date; cb: () => void; id: number }[] = []
  private n = 0
  setTimer(at: Date, cb: () => void) {
    const id = ++this.n
    this.timers.push({ at, cb, id })
    return id
  }
  clearTimer(h: unknown) {
    this.timers = this.timers.filter((t) => t.id !== h)
  }
  /** Fire every timer due at or before `now`. */
  fireDue(now: Date) {
    const due = this.timers.filter((t) => t.at <= now)
    this.timers = this.timers.filter((t) => t.at > now)
    for (const t of due) t.cb()
  }
}

export class RecordingPresenter implements AlarmPresenter {
  presented: { alarm: PlannedAlarm; med: Medication }[] = []
  missed: MissedDose[][] = []
  escalations: { alerts: EscalationAlert[]; quiet: boolean; at?: Date }[] = []
  present(alarm: PlannedAlarm, med: Medication) {
    this.presented.push({ alarm, med })
  }
  presentEscalation(alerts: EscalationAlert[], opts: { quiet: boolean }) {
    this.escalations.push({ alerts, quiet: opts.quiet })
  }
  showMissed(m: MissedDose[]) {
    this.missed.push(m)
  }
}

/** In-memory Google Calendar with failure injection. */
export class FakeCalendar implements CalendarGateway {
  calendars = new Map<string, CalendarInfo>()
  events = new Map<string, Map<string, CalendarEvent>>()
  calls: string[] = []
  failNext: Error[] = []
  private n = 0

  private maybeFail(op: string) {
    this.calls.push(op)
    const e = this.failNext.shift()
    if (e) throw e
  }
  async createCalendar(name: string): Promise<CalendarInfo> {
    this.maybeFail('createCalendar')
    const id = `cal${++this.n}`
    const c = { id, summary: name }
    this.calendars.set(id, c)
    this.events.set(id, new Map())
    return c
  }
  async getCalendar(id: string) {
    this.calls.push('getCalendar')
    return this.calendars.get(id) ?? null
  }
  private cal(id: string) {
    const c = this.events.get(id)
    if (!c || !this.calendars.has(id)) throw new GatewayError('notFound', 'calendar not found', 404)
    return c
  }
  async findEvents(calId: string, props: Record<string, string>) {
    this.maybeFail('findEvents')
    return [...this.cal(calId).values()].filter((e) => Object.entries(props).every(([k, v]) => e.extendedProperties.private[k] === v)).map((e) => structuredClone(e))
  }
  async insertEvent(calId: string, body: CalendarEventBody) {
    this.maybeFail('insertEvent')
    const ev = { ...structuredClone(body), id: `ev${++this.n}` }
    this.cal(calId).set(ev.id, ev)
    return structuredClone(ev)
  }
  async patchEvent(calId: string, id: string, body: CalendarEventBody) {
    this.maybeFail('patchEvent')
    const c = this.cal(calId)
    if (!c.has(id)) throw new GatewayError('notFound', 'event not found', 404)
    const ev = { ...c.get(id)!, ...structuredClone(body), id }
    c.set(id, ev)
    return structuredClone(ev)
  }
  async deleteEvent(calId: string, id: string) {
    this.maybeFail('deleteEvent')
    this.cal(calId).delete(id)
  }
  allEvents(): CalendarEvent[] {
    return [...this.events.values()].flatMap((m) => [...m.values()])
  }
}
