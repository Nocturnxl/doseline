import { describe, expect, it } from 'vitest'
import { buildDoseEvent, buildRefillEvent, eventNeedsUpdate, eventTitle, nearestGoogleColorId, reminderOverrides } from './calendar'
import { GoogleCalendarGateway, classify } from './googleCalendar'
import { AuthRequiredError, GatewayError } from './ports'
import { med } from './testkit'

const m = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { id: 'med1', notes: 'Check BP weekly', color: '#e5484d' })

describe('event shaping', () => {
  it('builds a tagged dose event', () => {
    const ev = buildDoseEvent(m, new Date('2026-05-04T12:00:00Z'), 'America/New_York', [30, 15])
    expect(ev.summary).toBe('💊 Lisinopril 10 mg')
    expect(eventTitle(m)).toBe('💊 Lisinopril 10 mg')
    expect(ev.description).toContain('Dose: 1 tablet (10 mg)')
    expect(ev.description).toContain('Instructions: with food')
    expect(ev.description).toContain('Notes: Check BP weekly')
    expect(ev.start).toEqual({ dateTime: '2026-05-04T12:00:00.000Z', timeZone: 'America/New_York' })
    expect(ev.reminders).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 30 }, { method: 'popup', minutes: 15 }, { method: 'popup', minutes: 0 }] })
    expect(ev.extendedProperties.private).toEqual({ app: 'doseline', kind: 'dose', medicationId: 'med1', doseId: 'med1@2026-05-04T12:00:00.000Z' })
    expect(ev.colorId).toBe('4') // #e5484d is closest to Flamingo
  })

  it('caps reminders at Google\'s limit of 5, keeping the closest', () => {
    expect(reminderOverrides([120, 90, 60, 30, 15, 5]).map((o) => o.minutes)).toEqual([60, 30, 15, 5, 0])
  })

  it('maps colors to the nearest Google colorId', () => {
    expect(nearestGoogleColorId('#d50000')).toBe('11')
    expect(nearestGoogleColorId('#3cb371')).toBe('2')
    expect(nearestGoogleColorId('#0ea5e9')).toBe('7')
    expect(nearestGoogleColorId('#fbbf24')).toBe('5')
    expect(nearestGoogleColorId('#8b5cf6')).toMatch(/^(1|3|9)$/)
    expect(nearestGoogleColorId('not a color')).toBeTruthy()
  })

  it('builds an all-day refill event', () => {
    const ev = buildRefillEvent(m, '2026-05-31', 4)
    expect(ev.start).toEqual({ date: '2026-05-31' })
    expect(ev.end).toEqual({ date: '2026-06-01' })
    expect(ev.extendedProperties.private.kind).toBe('refill')
  })

  it('detects when an event needs a patch', () => {
    const a = buildDoseEvent(m, new Date('2026-05-04T12:00:00Z'), 'America/New_York', [30])
    expect(eventNeedsUpdate(a, { ...a })).toBe(false)
    expect(eventNeedsUpdate(a, buildDoseEvent(m, new Date('2026-05-04T13:00:00Z'), 'America/New_York', [30]))).toBe(true)
    expect(eventNeedsUpdate(a, buildDoseEvent(m, new Date('2026-05-04T12:00:00Z'), 'America/New_York', [10]))).toBe(true)
    // Google returns dateTime with an offset rather than Z: same instant must compare equal.
    expect(eventNeedsUpdate({ ...a, start: { dateTime: '2026-05-04T08:00:00-04:00' } }, a)).toBe(false)
  })
})

describe('GoogleCalendarGateway', () => {
  function gw(responses: (Response | Error)[], tokens = ['t1', 't2']) {
    const calls: { url: string; init?: RequestInit }[] = []
    let forced = 0
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const r = responses.shift()
      if (!r) throw new Error('no response')
      if (r instanceof Error) throw r
      return r
    }
    const auth = {
      isConnected: async () => true,
      getAccessToken: async (force?: boolean) => {
        if (force) forced++
        return force ? tokens[1]! : tokens[0]!
      },
    }
    return { g: new GoogleCalendarGateway(auth, fetchFn), calls, forced: () => forced }
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('searches events by private extended properties', async () => {
    const { g, calls } = gw([json(200, { items: [{ id: 'e1', status: 'confirmed' }, { id: 'e2', status: 'cancelled' }] })])
    const evs = await g.findEvents('cal@x', { app: 'doseline', medicationId: 'm1' })
    expect(evs.map((e) => e.id)).toEqual(['e1'])
    const u = new URL(calls[0]!.url)
    expect(u.pathname).toBe('/calendar/v3/calendars/cal%40x/events')
    expect(u.searchParams.getAll('privateExtendedProperty')).toEqual(['app=doseline', 'medicationId=m1'])
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer t1')
  })

  it('refreshes the token once on 401', async () => {
    const { g, calls, forced } = gw([json(401, {}), json(200, { id: 'c', summary: 'Medications' })])
    await g.getCalendar('c')
    expect(forced()).toBe(1)
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer t2')
  })

  it('maps network failures to offline', async () => {
    const { g } = gw([new TypeError('fetch failed')])
    await expect(g.insertEvent('c', {} as never)).rejects.toMatchObject({ kind: 'offline' })
  })

  it('treats deleting a missing event as success', async () => {
    const { g } = gw([json(410, { error: { message: 'gone' } })])
    await expect(g.deleteEvent('c', 'e')).resolves.toBeUndefined()
  })

  it('surfaces AuthRequiredError from the token provider', async () => {
    const g = new GoogleCalendarGateway({ isConnected: async () => true, getAccessToken: async () => { throw new AuthRequiredError() } }, async () => json(200, {}))
    await expect(g.getCalendar('c')).rejects.toBeInstanceOf(AuthRequiredError)
  })

  it('classifies HTTP errors', () => {
    expect(classify(401)).toBe('auth')
    expect(classify(403, 'rateLimitExceeded')).toBe('rateLimit')
    expect(classify(403, 'insufficientPermissions')).toBe('auth')
    expect(classify(403, 'forbidden')).toBe('notFound')
    expect(classify(404)).toBe('notFound')
    expect(classify(429)).toBe('rateLimit')
    expect(classify(503)).toBe('server')
    expect(classify(400)).toBe('client')
    expect(new GatewayError('client', 'x')).toBeInstanceOf(Error)
  })
})
