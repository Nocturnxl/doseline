import { useMemo, useState, type CSSProperties } from 'react'
import { BellRing, Check, ClockArrowLeft, Ellipsis, Flame, Moon, Plus, SkipForward, TriangleAlert, X } from 'lucide-react'
import type { EscalationView, Route } from '../../../shared/api'
import { overdueLabel } from '../../../core/escalation'
import type { Medication } from '../../../core/types'
import { todayTimeline, upNext, type TimelineItem, type UpNextItem } from '../../../core/today'
import { currentStreak } from '../../../core/adherence'
import { describeSchedule } from '../../../core/schedule'
import { doseLine } from '../../../core/calendar'
import { addLocalDays, startOfLocalDay } from '../../../core/time'
import { api, useNow, useSnapshot } from '../lib/store'
import { countdown, fmtDate, fmtTime, fmtWhen, greeting, plural, ringLabel } from '../lib/format'
import { MedBadge, MedGlyph } from '../components/MedIcon'
import { MenuButton, Ring } from '../components/ui'
import { useDoseActions } from '../components/DoseActions'
import { MedEditor } from './MedEditor'
import { EmptyArt } from '../components/EmptyArt'

const STATUS_LABEL: Record<string, string> = {
  upcoming: 'Upcoming',
  due: 'Due',
  overdue: 'Overdue',
  taken: 'Taken',
  skipped: 'Skipped',
  missed: 'Missed',
  available: 'Available',
  escalated: 'Escalated',
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill ${status}`}>
      {status === 'escalated' && <BellRing />}
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

/** The escalation for this item's pending dose, if it has started. */
function escalationFor(item: UpNextItem, escalations: EscalationView[], now: Date): EscalationView | null {
  if (!item.next) return null
  const e = escalations.find((x) => x.medicationId === item.med.id && new Date(x.dueAt).getTime() === item.next!.dueAt.getTime())
  return e && new Date(e.escalatedAt) <= now ? e : null
}

export function TodayPage({ go }: { go: (r: Route) => void }) {
  const snap = useSnapshot()
  const now = useNow(1000)
  const [adding, setAdding] = useState(false)
  const { zone, settings } = snap
  const items = useMemo(() => upNext(snap.meds, snap.logs, now, zone, settings.graceMinutes), [snap.meds, snap.logs, now, zone, settings.graceMinutes])
  const minuteKey = Math.floor(now.getTime() / 60_000)
  const timeline = useMemo(() => todayTimeline(snap.meds, snap.logs, new Date(minuteKey * 60_000), zone, settings.graceMinutes), [snap.meds, snap.logs, minuteKey, zone, settings.graceMinutes])
  const streak = useMemo(() => currentStreak(snap.meds, snap.logs, new Date(minuteKey * 60_000), zone, settings.graceMinutes), [snap.meds, snap.logs, minuteKey, zone, settings.graceMinutes])
  const medById = useMemo(() => new Map(snap.meds.map((m) => [m.id, m])), [snap.meds])

  const scheduled = items.filter((i) => i.next)
  const hero = scheduled[0] ?? null
  const rest = items.filter((i) => i !== hero)

  // Progress counts scheduled doses only; as-needed doses aren't expected.
  const scheduledItems = timeline.filter((t) => !t.projected && medById.get(t.medicationId)?.schedule.type !== 'prn')
  const takenToday = scheduledItems.filter((t) => t.status === 'taken').length
  const expectedToday = scheduledItems.filter((t) => t.status !== 'skipped').length

  return (
    <div className="page">
      <div className="page-header">
        <div className="titles">
          <h1>{greeting(now)}</h1>
          <p>{fmtDate(now, zone)}</p>
        </div>
        {snap.meds.length > 0 && (
          <button className="btn" onClick={() => setAdding(true)}>
            <Plus />
            Add medication
          </button>
        )}
      </div>

      <MissedBanner />

      {snap.meds.length === 0 ? (
        <div className="card">
          <div className="empty">
            <EmptyArt />
            <h2>Let's add your first medication</h2>
            <p>Doseline will remind you before each dose, keep a log of what you've taken, and can mirror upcoming doses to Google Calendar.</p>
            <button className="btn btn-primary btn-lg" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>
              <Plus />
              Add medication
            </button>
          </div>
        </div>
      ) : (
        <div className="today-grid">
          <div className="stack" style={{ gap: 20 }}>
            {hero ? <Hero item={hero} now={now} escalation={escalationFor(hero, snap.escalations, now)} /> : <AllClear />}
            {rest.length > 0 && (
              <section>
                <div className="section-title" style={{ marginTop: 4 }}>
                  <h2>Coming up</h2>
                  <span className="subtle small">{plural(rest.length, 'medication')}</span>
                </div>
                <div className="card dose-list">
                  {rest.map((i) => (
                    <DoseRow key={i.med.id} item={i} now={now} escalation={escalationFor(i, snap.escalations, now)} />
                  ))}
                </div>
              </section>
            )}
          </div>
          <aside className="stack" style={{ gap: 20 }}>
            <div className="card card-pad">
              <div className="card-header" style={{ marginBottom: 12 }}>
                <h2>Today</h2>
                <span className="subtle small num">
                  {takenToday} of {Math.max(expectedToday, takenToday)} taken
                </span>
              </div>
              <TimelineStrip items={timeline} now={now} meds={medById} />
              <div className="stat-tiles" style={{ marginTop: 14 }}>
                <div className="stat">
                  <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {streak}
                    {streak > 0 && <Flame size={18} color="var(--warning)" />}
                  </div>
                  <div className="l">Day streak</div>
                </div>
                <button className="stat" style={{ border: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit' }} onClick={() => go('adherence')}>
                  <div className="v">{expectedToday ? Math.round((takenToday / Math.max(expectedToday, takenToday)) * 100) : 0}%</div>
                  <div className="l">Done today →</div>
                </button>
              </div>
            </div>
            <div className="card card-pad">
              <div className="card-header" style={{ marginBottom: 6 }}>
                <h3>Schedule</h3>
              </div>
              <TimelineList items={timeline} now={now} meds={medById} />
            </div>
          </aside>
        </div>
      )}
      {adding && <MedEditor onClose={() => setAdding(false)} />}
    </div>
  )
}

function Hero({ item, now, escalation }: { item: UpNextItem; now: Date; escalation: EscalationView | null }) {
  const { zone } = useSnapshot()
  const { take, skip, backdate } = useDoseActions()
  const { med, next } = item
  const status = escalation ? 'escalated' : item.status
  const due = next!.dueAt
  const overdue = status === 'overdue' || !!escalation
  const label = ringLabel(due, now)
  const isPrn = med.schedule.type === 'prn'
  return (
    <section className={`card hero${escalation ? ' escalated' : ''}`} style={{ '--med': med.color } as CSSProperties} aria-label={`Next dose: ${med.name}`}>
      <Ring size={148} stroke={9} progress={item.progress} color={overdue ? 'var(--danger)' : med.color} label={`${countdown(due, now)}`}>
        {due > now ? (
          <div className="ring-count">
            <span className="v">{label.value}</span>
            <span className="u">{label.unit}</span>
          </div>
        ) : (
          <div className="ring-count">
            <MedGlyph icon={med.icon} size={34} />
            <span className="u" style={{ color: overdue ? 'var(--danger)' : 'var(--accent)' }}>
              {overdue ? 'Overdue' : 'Due now'}
            </span>
          </div>
        )}
      </Ring>
      <div className="hero-body">
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <span className="eyebrow">{isPrn ? 'Available again' : 'Next dose'}</span>
          <StatusPill status={status} />
        </div>
        <div className="med-name">{med.name}</div>
        <div className="med-dose">
          {doseLine(med)}
          {med.instructions ? ` · ${med.instructions}` : ''}
        </div>
        <div className="row small muted" style={{ marginTop: 10, gap: 6 }}>
          <time className="num" style={{ color: 'var(--text)', fontWeight: 560 }}>
            {fmtWhen(due, zone, now)}
          </time>
          <span className="subtle">·</span>
          <span className="num">{countdown(due, now)}</span>
        </div>
        {escalation && (
          <div className="escalation-note" role="status">
            <BellRing />
            <span>
              Overdue by <b className="num">{overdueLabel(due, now)}</b>. The overdue alarm repeats until you take or skip it
              {escalation.repeats ? ` (reminded ${escalation.repeats + 1} times so far)` : ''}.
            </span>
          </div>
        )}
        <div className="actions">
          <button className="btn btn-primary btn-lg" onClick={() => void take(med)}>
            <Check />
            Take now
          </button>
          <button className="btn btn-lg" onClick={() => backdate(med, due)}>
            <ClockArrowLeft />
            Took it at…
          </button>
          {!isPrn && (
            <button className="btn btn-ghost btn-lg" onClick={() => void skip(med)}>
              <SkipForward />
              Skip
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function AllClear() {
  return (
    <section className="card hero" style={{ '--med': 'var(--success)', gridTemplateColumns: 'auto 1fr' } as CSSProperties}>
      <Ring size={120} stroke={8} progress={1} color="var(--success)">
        <Moon size={32} color="var(--success)" />
      </Ring>
      <div className="hero-body">
        <div className="med-name">All caught up</div>
        <div className="med-dose">Nothing scheduled right now. As-needed medications are below.</div>
      </div>
    </section>
  )
}

function DoseRow({ item, now, escalation }: { item: UpNextItem; now: Date; escalation: EscalationView | null }) {
  const { zone } = useSnapshot()
  const { take, skip, backdate } = useDoseActions()
  const { med, next } = item
  const status = escalation ? 'escalated' : item.status
  const isPrn = med.schedule.type === 'prn'
  return (
    <div className={`dose-row${escalation ? ' escalated' : ''}`} style={{ '--med': med.color } as CSSProperties}>
      <Ring size={46} stroke={4} progress={item.progress} color={status === 'overdue' || escalation ? 'var(--danger)' : med.color}>
        <MedGlyph icon={med.icon} size={18} />
      </Ring>
      <div style={{ minWidth: 0 }}>
        <div className="name">
          {med.name} <span className="muted" style={{ fontWeight: 450 }}>{med.strength}</span>
        </div>
        <div className="meta">
          {doseLine(med)}
          {med.instructions ? ` · ${med.instructions}` : ''} · {describeSchedule(med)}
        </div>
      </div>
      <div className="when">
        {next ? <time className="num">{fmtWhen(next.dueAt, zone, now)}</time> : <span className="small muted">Any time</span>}
        <StatusPill status={status} />
      </div>
      <div className="row-actions">
        <button className="btn btn-sm" onClick={() => void take(med)} aria-label={`Take ${med.name} now`}>
          <Check />
          Take
        </button>
        <MenuButton
          label={`More actions for ${med.name}`}
          items={[
            { label: 'Took it at…', icon: <ClockArrowLeft />, onSelect: () => backdate(med, next?.dueAt) },
            ...(!isPrn ? [{ label: 'Skip this dose', icon: <SkipForward />, onSelect: () => void skip(med) }] : []),
          ]}
        >
          <Ellipsis />
        </MenuButton>
      </div>
    </div>
  )
}

function dayFraction(d: Date, zone: string): number {
  const start = startOfLocalDay(d, zone)
  const end = addLocalDays(start, 1, zone)
  return (d.getTime() - start.getTime()) / (end.getTime() - start.getTime())
}

function TimelineStrip({ items, now, meds }: { items: TimelineItem[]; now: Date; meds: Map<string, Medication> }) {
  const { zone } = useSnapshot()
  const nowF = dayFraction(now, zone)
  return (
    <div className="timeline-strip" aria-hidden>
      <div className="axis" />
      <div className="elapsed" style={{ width: `${nowF * 100}%` }} />
      {items.map((i) => {
        const m = meds.get(i.medicationId)
        if (!m) return null
        return <span key={i.key} className={`mark ${i.status}${i.projected ? ' projected' : ''}`} style={{ left: `${dayFraction(i.at, zone) * 100}%`, '--med': m.color } as CSSProperties} title={`${m.name} · ${fmtTime(i.at, zone)} · ${STATUS_LABEL[i.status]}`} />
      })}
      <div className="now" style={{ left: `${nowF * 100}%` }} />
      <div className="ticks">
        <span>12a</span>
        <span>6a</span>
        <span>12p</span>
        <span>6p</span>
        <span>12a</span>
      </div>
    </div>
  )
}

function TimelineList({ items, now, meds }: { items: TimelineItem[]; now: Date; meds: Map<string, Medication> }) {
  const { zone } = useSnapshot()
  if (items.length === 0) return <p className="small subtle" style={{ padding: '8px 0' }}>Nothing scheduled today.</p>
  const nowIdx = items.findIndex((i) => i.at > now)
  const rows: React.ReactNode[] = []
  items.forEach((i, idx) => {
    if (idx === nowIdx) rows.push(<NowMarker key="now" now={now} zone={zone} />)
    const m = meds.get(i.medicationId)
    if (!m) return
    rows.push(
      <div key={i.key} className={`tl-item ${i.status}${i.projected ? ' projected' : ''}`} style={{ '--med': m.color } as CSSProperties}>
        <time className="num">{fmtTime(i.at, zone)}</time>
        <span className="dot" />
        <span className="label">
          {m.name}
          {i.projected ? <span className="subtle"> · est.</span> : null}
        </span>
        <span className={`pill ${i.status}`} style={{ height: 20 }}>
          {i.status === 'taken' ? <Check /> : i.status === 'missed' ? <X /> : i.status === 'overdue' ? <TriangleAlert /> : null}
          {STATUS_LABEL[i.status]}
        </span>
      </div>,
    )
  })
  if (nowIdx === -1) rows.push(<NowMarker key="now" now={now} zone={zone} />)
  return <div className="tl-list">{rows}</div>
}

function NowMarker({ now, zone }: { now: Date; zone: string }) {
  return (
    <div className="tl-now" aria-label="Now">
      <span className="num" style={{ textAlign: 'right' }}>
        {fmtTime(now, zone)}
      </span>
      <span className="bar" />
    </div>
  )
}

function MissedBanner() {
  const snap = useSnapshot()
  const { backdate } = useDoseActions()
  const entries = snap.missed.filter((e) => snap.meds.some((m) => m.id === e.medicationId))
  if (!entries.length) return null
  const byId = new Map(snap.meds.map((m) => [m.id, m]))
  return (
    <div className="missed-banner" role="region" aria-label="Missed while you were away">
      <TriangleAlert />
      <div style={{ flex: 1 }}>
        <h3>Missed while you were away</h3>
        <p className="small muted" style={{ marginTop: 2 }}>
          These doses came due while your PC was asleep or off. Log any you actually took, or dismiss.
        </p>
        <div className="stack" style={{ gap: 6, marginTop: 10 }}>
          {entries.slice(0, 6).map((e) => {
            const m = byId.get(e.medicationId)!
            return (
              <div key={`${e.medicationId}${e.dueAt}`} className="row" style={{ gap: 10 }}>
                <MedBadge icon={m.icon} color={m.color} size={26} />
                <span style={{ fontWeight: 560 }}>{m.name}</span>
                <span className="small muted num">{fmtWhen(e.dueAt, snap.zone)}</span>
                {e.escalated && (
                  <span className="pill escalated" title="This dose also passed its overdue-alert threshold while you were away">
                    <BellRing />
                    Escalated
                  </span>
                )}
                <span className="spacer" />
                <button className="btn btn-sm" onClick={() => backdate(m, new Date(e.dueAt))}>
                  <ClockArrowLeft />
                  I took it
                </button>
              </div>
            )
          })}
        </div>
      </div>
      <button className="btn btn-sm btn-ghost" onClick={() => void api.dismissMissed()}>
        Dismiss
      </button>
    </div>
  )
}
