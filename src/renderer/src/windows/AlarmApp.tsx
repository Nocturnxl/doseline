import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { AlarmClock, BellRing, Check, ChevronLeft, ChevronRight, ClockArrowLeft, SkipForward, TriangleAlert, VolumeX, X } from 'lucide-react'
import type { AlarmAction, AlarmView, AlarmWindowState } from '../../../shared/api'
import { ESCALATION_SNOOZE_OPTIONS, overdueLabel } from '../../../core/escalation'
import { api, useNow, useTheme } from '../lib/store'
import { countdown, ringLabel } from '../lib/format'
import { playSound, stopSound } from '../lib/sound'
import { Ring } from '../components/ui'
import { MedGlyph } from '../components/MedIcon'

const REPEAT_MS = 25_000
const MAX_RINGS = 3

export function AlarmApp() {
  const [state, setState] = useState<AlarmWindowState | null>(null)
  const [muted, setMuted] = useState(false)
  const lastRing = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  useTheme(null, state?.theme)

  useEffect(() => {
    void api.alarmGetState().then(setState)
    return api.onAlarmState((s) => setState(s))
  }, [])

  // Normal alarms chime and repeat a couple of times while unanswered. An escalation cycle plays its
  // own sound exactly once (the next cycle is the repeat); quiet hours ring silently.
  useEffect(() => {
    if (!state || state.ring === lastRing.current || !state.alarms.length) return
    lastRing.current = state.ring
    setMuted(false)
    if (!state.sound.enabled || state.ringSound === 'silent') return
    if (state.ringSound === 'escalation') {
      playSound(state.escalationSound, state.sound.volume)
      return
    }
    let count = 0
    const ring = () => {
      if (count++ >= MAX_RINGS) return
      playSound(state.sound.choice, state.sound.volume)
    }
    ring()
    const t = setInterval(ring, REPEAT_MS)
    return () => clearInterval(t)
  }, [state])

  useEffect(() => {
    if (muted || !state?.alarms.length) stopSound()
  }, [muted, state])

  // Size the window to its content (the escalation list grows with each overdue medication).
  useLayoutEffect(() => {
    const el = wrapRef.current?.firstElementChild as HTMLElement | null
    if (!el) return
    // The card is capped at the window height and its list scrolls, so measure the natural height:
    // the card plus whatever the list is currently hiding (otherwise the window would shrink-wrap
    // its own cap and collapse to the minimum).
    const report = () => {
      const list = el.querySelector<HTMLElement>('.esc-list')
      const hidden = list ? list.scrollHeight - list.clientHeight : 0
      // The escalated list needs a little more width so each row's four actions fit on one line.
      api.alarmResize(el.offsetHeight + hidden + 28, el.classList.contains('escalated') ? 480 : 420)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    const list = el.querySelector('.esc-list')
    if (list) for (const child of list.children) ro.observe(child)
    return () => ro.disconnect()
  }, [state])

  if (!state || !state.alarms.length) return null
  const escalated = state.alarms.some((a) => a.kind === 'escalation')
  const canMute = state.sound.enabled && state.ringSound !== 'silent' && !muted
  return (
    <div className="alarm-wrap" data-testid="alarm" ref={wrapRef}>
      {escalated ? (
        <EscalationCard alarms={state.alarms} canMute={canMute} onMute={() => setMuted(true)} />
      ) : (
        <SingleAlarm state={state} canMute={canMute} onMute={() => setMuted(true)} />
      )}
    </div>
  )
}

function useAct() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = async (key: string, action: AlarmAction, arg?: number | string) => {
    setBusy(key)
    setError(null)
    stopSound()
    const r = await api.alarmAct(key, action, arg)
    setBusy(null)
    if (!r.ok) setError(r.error)
  }
  return { act, busy, error }
}

// ------------------------------------------------------------------ escalation (consolidated)

function EscalationCard({ alarms, canMute, onMute }: { alarms: AlarmView[]; canMute: boolean; onMute: () => void }) {
  const now = useNow(1000)
  const { act, busy, error } = useAct()
  const escalations = alarms.filter((a) => a.kind === 'escalation')
  const others = alarms.filter((a) => a.kind !== 'escalation')
  const n = escalations.length
  return (
    <div className="alarm-card escalated" role="alertdialog" aria-labelledby="esc-title" aria-describedby="esc-desc">
      <div className="alarm-glow" />
      <div className="alarm-top">
        <span className="eyebrow row esc-eyebrow" style={{ gap: 6 }} id="esc-title">
          <TriangleAlert size={14} />
          {n === 1 ? 'Overdue dose' : `${n} overdue doses`}
        </span>
        <span className="spacer" />
        {canMute && (
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Mute" onClick={onMute}>
            <VolumeX />
          </button>
        )}
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Hide until the next repeat" title="Hide until the next repeat" onClick={() => void Promise.all(alarms.map((a) => act(a.key, 'dismiss')))}>
          <X />
        </button>
      </div>
      <p className="esc-desc small muted" id="esc-desc">
        {n === 1
          ? 'This dose is well past due. Doseline will keep reminding you until you log or skip it.'
          : 'These doses are well past due. Doseline will keep reminding you until each one is logged or skipped.'}
      </p>
      <ul className="esc-list">
        {escalations.map((a) => (
          <EscalationRow key={a.key} a={a} now={now} busy={busy === a.key} onAct={(action, arg) => void act(a.key, action, arg)} />
        ))}
        {others.map((a) => (
          <EscalationRow key={a.key} a={a} now={now} busy={busy === a.key} onAct={(action, arg) => void act(a.key, action, arg)} />
        ))}
      </ul>
      {error && <div className="small" style={{ color: 'var(--danger)', padding: '0 4px' }}>{error}</div>}
    </div>
  )
}

function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function EscalationRow({ a, now, busy, onAct }: { a: AlarmView; now: Date; busy: boolean; onAct: (action: AlarmAction, arg?: number | string) => void }) {
  const [mode, setMode] = useState<'actions' | 'takeAt' | 'snooze'>('actions')
  const due = new Date(a.dueAt)
  const [at, setAt] = useState(() => localInputValue(due))
  const isEsc = a.kind === 'escalation'
  const atDate = new Date(at)
  const atValid = !Number.isNaN(atDate.getTime()) && atDate <= now
  const snoozeOptions = isEsc ? ESCALATION_SNOOZE_OPTIONS : [5, 10, 15]
  const dueText = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <li className={`esc-row${isEsc ? ' is-escalated' : ''}`} style={{ '--med': a.color } as CSSProperties}>
      <div className="esc-head">
        <span className="esc-badge" aria-hidden>
          <MedGlyph icon={a.icon} size={18} />
        </span>
        <div className="esc-text">
          <div className="esc-name">
            {a.name} <span className="muted">{a.strength}</span>
          </div>
          <div className="small muted esc-dose">
            {a.dose}
            {a.instructions ? ` · ${a.instructions}` : ''}
          </div>
        </div>
        {isEsc ? (
          <div className="esc-overdue" aria-live="off">
            <span className="esc-overdue-label">Overdue by</span>
            <span className="num esc-overdue-value">{overdueLabel(due, now)}</span>
          </div>
        ) : (
          <div className="esc-overdue plain">
            <span className="esc-overdue-label">{due > now ? 'Coming up' : 'Due'}</span>
            <span className="num esc-overdue-value">{countdown(due, now)}</span>
          </div>
        )}
      </div>
      <div className="esc-meta small subtle num">
        Due {dueText}
        {isEsc && a.repeats ? ` · reminded ${a.repeats + 1} times` : isEsc ? ' · escalated' : ''}
        {a.test ? ' · test' : ''}
      </div>
      {mode === 'actions' && (
        <div className="esc-actions">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onAct('take')}>
            <Check />
            Take now
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => setMode('takeAt')}>
            <ClockArrowLeft />
            Took it at…
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => onAct('skip')}>
            <SkipForward />
            Skip
          </button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode('snooze')}>
            <BellRing />
            Snooze
          </button>
        </div>
      )}
      {mode === 'takeAt' && (
        <form
          className="esc-actions"
          onSubmit={(e) => {
            e.preventDefault()
            if (atValid) onAct('takeAt', atDate.toISOString())
          }}
        >
          <input className="input num esc-time" type="datetime-local" value={at} max={localInputValue(now)} onChange={(e) => setAt(e.target.value)} aria-label={`When you took ${a.name}`} autoFocus />
          <button className="btn btn-primary btn-sm" disabled={busy || !atValid}>
            Log
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('actions')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'snooze' && (
        <div className="esc-actions">
          <span className="small subtle" style={{ marginRight: 'auto' }}>
            {isEsc ? 'Next reminder in' : 'Snooze'}
          </span>
          {snoozeOptions.map((m) => (
            <button key={m} className="btn btn-sm" disabled={busy} onClick={() => onAct('snooze', m)}>
              {m} min
            </button>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setMode('actions')}>
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}

// ------------------------------------------------------------------ single reminder (unchanged design)

function SingleAlarm({ state, canMute, onMute }: { state: AlarmWindowState; canMute: boolean; onMute: () => void }) {
  const [idx, setIdx] = useState(0)
  const now = useNow(1000)
  const { act, busy, error } = useAct()
  useEffect(() => setIdx(0), [state.ring])
  const a = state.alarms[Math.min(idx, state.alarms.length - 1)]!
  const due = new Date(a.dueAt)
  const isReminder = due > now
  const overdue = now.getTime() - due.getTime() > 60_000
  const label = ringLabel(due, now)
  const progress = isReminder ? 1 - (due.getTime() - now.getTime()) / Math.max(a.offsetMin * 60_000, 60_000) : 1

  return (
    <div className="alarm-card" style={{ '--med': a.color } as CSSProperties} role="alertdialog" aria-labelledby="alarm-title" aria-describedby="alarm-desc">
      <div className="alarm-glow" />
      <div className="alarm-top">
        <span className="eyebrow row" style={{ gap: 6, color: 'var(--med)' }}>
          <AlarmClock size={14} />
          {a.test ? 'Test alarm' : a.kind === 'snooze' ? 'Snoozed reminder' : isReminder ? 'Coming up' : overdue ? 'Overdue' : 'Time for your dose'}
        </span>
        <span className="spacer" />
        {state.alarms.length > 1 && (
          <span className="row tiny subtle" style={{ gap: 2 }}>
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Previous alarm" onClick={() => setIdx((i) => (i - 1 + state.alarms.length) % state.alarms.length)}>
              <ChevronLeft />
            </button>
            <span className="num">
              {idx + 1}/{state.alarms.length}
            </span>
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Next alarm" onClick={() => setIdx((i) => (i + 1) % state.alarms.length)}>
              <ChevronRight />
            </button>
          </span>
        )}
        {canMute && (
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Mute" onClick={onMute}>
            <VolumeX />
          </button>
        )}
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" onClick={() => void act(a.key, 'dismiss')}>
          <X />
        </button>
      </div>
      <div className="alarm-main">
        <Ring size={92} stroke={6} progress={progress} color={overdue ? 'var(--danger)' : a.color} label={countdown(due, now)}>
          {isReminder ? (
            <div className="ring-count">
              <span className="v" style={{ fontSize: 22 }}>
                {label.value}
              </span>
              <span className="u" style={{ marginTop: 4 }}>
                {label.unit}
              </span>
            </div>
          ) : (
            <span className="alarm-pulse">
              <MedGlyph icon={a.icon} size={30} />
            </span>
          )}
        </Ring>
        <div style={{ minWidth: 0 }}>
          <div className="alarm-name" id="alarm-title">
            {a.name}
          </div>
          <div className="muted" id="alarm-desc">
            {a.dose}
          </div>
          {a.instructions && <div className="alarm-instr">{a.instructions}</div>}
          <div className="small subtle num" style={{ marginTop: 6 }}>
            Due {due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {countdown(due, now)}
          </div>
        </div>
      </div>
      {error && <div className="small" style={{ color: 'var(--danger)', padding: '0 4px' }}>{error}</div>}
      <div className="alarm-actions">
        <button className="btn btn-primary btn-lg" style={{ flex: 1 }} disabled={!!busy} onClick={() => void act(a.key, 'take')}>
          <Check />
          Take now
        </button>
        <button className="btn btn-lg" disabled={!!busy} onClick={() => void act(a.key, 'skip')} title="Skip this dose">
          <SkipForward />
          Skip
        </button>
      </div>
      <div className="alarm-snooze">
        <span className="small subtle">Snooze</span>
        {[5, 10, 15].map((m) => (
          <button key={m} className="btn btn-sm" disabled={!!busy} onClick={() => void act(a.key, 'snooze', m)}>
            {m} min
          </button>
        ))}
      </div>
    </div>
  )
}
