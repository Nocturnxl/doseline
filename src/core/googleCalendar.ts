import type { AccessTokenProvider, CalendarGateway, CalendarInfo } from './ports'
import { AuthRequiredError, GatewayError } from './ports'
import type { CalendarEvent, CalendarEventBody } from './calendar'

const BASE = 'https://www.googleapis.com/calendar/v3'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Google Calendar v3 REST client. Uses only the standard fetch API so it works unchanged in a
 * browser build; the platform supplies fetch and an access-token provider.
 */
export class GoogleCalendarGateway implements CalendarGateway {
  constructor(
    private auth: AccessTokenProvider,
    private fetchFn: FetchFn,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, query?: URLSearchParams): Promise<T> {
    let token: string
    try {
      token = await this.auth.getAccessToken()
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e
      throw toGatewayError(e)
    }
    const url = `${BASE}${path}${query && [...query.keys()].length ? `?${query}` : ''}`
    const send = (t: string) =>
      this.fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    let res: Response
    try {
      res = await send(token)
      if (res.status === 401) {
        token = await this.auth.getAccessToken(true)
        res = await send(token)
      }
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e
      throw toGatewayError(e)
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    }
    let reason = ''
    let message = `HTTP ${res.status}`
    try {
      const j = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } }
      reason = j.error?.errors?.[0]?.reason ?? ''
      message = j.error?.message ?? message
    } catch {
      /* ignore non-JSON bodies */
    }
    throw new GatewayError(classify(res.status, reason), message, res.status)
  }

  async createCalendar(name: string, description: string, zone: string): Promise<CalendarInfo> {
    const cal = await this.request<{ id: string; summary: string }>('POST', '/calendars', { summary: name, description, timeZone: zone })
    return { id: cal.id, summary: cal.summary }
  }

  async getCalendar(calendarId: string): Promise<CalendarInfo | null> {
    try {
      const cal = await this.request<{ id: string; summary: string }>('GET', `/calendars/${encodeURIComponent(calendarId)}`)
      return { id: cal.id, summary: cal.summary }
    } catch (e) {
      if (e instanceof GatewayError && (e.kind === 'notFound' || e.kind === 'gone')) return null
      throw e
    }
  }

  /** Look for a calendar this app created earlier (e.g. after reinstalling). Best-effort. */
  async findAppCalendar(name: string, description: string): Promise<CalendarInfo | null> {
    const q = new URLSearchParams({ minAccessRole: 'owner', maxResults: '250' })
    const list = await this.request<{ items?: { id: string; summary: string; description?: string }[] }>('GET', '/users/me/calendarList', undefined, q)
    const hit = (list.items ?? []).find((c) => c.summary === name && c.description === description)
    return hit ? { id: hit.id, summary: hit.summary } : null
  }

  async findEvents(calendarId: string, privateProps: Record<string, string>): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({ showDeleted: 'false', maxResults: '50' })
    for (const [k, v] of Object.entries(privateProps)) q.append('privateExtendedProperty', `${k}=${v}`)
    const res = await this.request<{ items?: (CalendarEvent & { status?: string })[] }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, undefined, q)
    return (res.items ?? []).filter((e) => e.status !== 'cancelled')
  }

  insertEvent(calendarId: string, body: CalendarEventBody): Promise<CalendarEvent> {
    return this.request('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body)
  }

  patchEvent(calendarId: string, eventId: string, body: CalendarEventBody): Promise<CalendarEvent> {
    return this.request('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body)
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
    } catch (e) {
      if (e instanceof GatewayError && (e.kind === 'notFound' || e.kind === 'gone')) return
      throw e
    }
  }
}

export function classify(status: number, reason = ''): GatewayError['kind'] {
  if (status === 401) return 'auth'
  if (status === 403 && /rateLimit/i.test(reason)) return 'rateLimit'
  if (status === 403 && /insufficientPermissions|authError/i.test(reason)) return 'auth'
  // Plain "forbidden" on a calendar means it isn't one this app created (or it was unshared).
  if (status === 403 && /forbidden/i.test(reason)) return 'notFound'
  if (status === 404) return 'notFound'
  if (status === 410) return 'gone'
  if (status === 429) return 'rateLimit'
  if (status >= 500) return 'server'
  return 'client'
}

function toGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e
  const msg = e instanceof Error ? e.message : String(e)
  // fetch() rejects with TypeError on DNS / connection failures.
  return new GatewayError('offline', msg)
}
