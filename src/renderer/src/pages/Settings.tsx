import { useEffect, useRef, useState } from 'react'
import { Bell, Bug, Pill, Siren, CalendarCheck, Database, Download, FolderOpen, Keyboard, LogOut, Monitor, Moon, Palette, Play, Plus, RefreshCw, Sun, TriangleAlert, Upload, Volume2, X } from 'lucide-react'
import type { Settings, SoundChoice } from '../../../core/types'
import { api, useSnapshot, useToasts } from '../lib/store'
import { minutesLabel } from '../lib/format'
import { ConfirmDialog, Segmented, Switch } from '../components/ui'
import { GoogleSetup } from '../components/GoogleSetup'
import { EscalationPicker } from '../components/EscalationPicker'
import { isValidClock } from '../../../core/time'
import { playSound } from '../lib/sound'

export function SettingsPage() {
  const snap = useSnapshot()
  const { push } = useToasts()
  const s = snap.settings
  const update = async (patch: Partial<Settings>, msg?: string) => {
    const r = await api.updateSettings(patch)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else if (msg) push({ kind: 'success', message: msg })
  }
  const [versionClicks, setVersionClicks] = useState(0)

  return (
    <div className="page">
      <div className="page-header">
        <div className="titles">
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings-layout">
        <GoogleCard />

        <section className="card settings-card">
          <header>
            <Bell />
            <h2>Reminders</h2>
          </header>
          <div className="setting" style={{ alignItems: 'flex-start' }}>
            <div className="text">
              <div className="t">Remind me before each dose</div>
              <div className="d">An alarm also fires at the due time. Medications can override these.</div>
            </div>
            <OffsetEditor value={s.reminderOffsets} onChange={(v) => void update({ reminderOffsets: v })} />
          </div>
          <div className="setting">
            <div className="text">
              <div className="t">On-time window</div>
              <div className="d">A dose taken within this window of its scheduled time counts as on time.</div>
            </div>
            <select className="select" style={{ width: 150 }} value={s.graceMinutes} onChange={(e) => void update({ graceMinutes: Number(e.target.value) })} aria-label="On-time window">
              {[15, 30, 45, 60, 90, 120, 180].map((m) => (
                <option key={m} value={m}>
                  ± {minutesLabel(m)}
                </option>
              ))}
            </select>
          </div>
        </section>

        <OverdueAlertsCard />

        <section className="card settings-card">
          <header>
            <Volume2 />
            <h2>Sound</h2>
          </header>
          <div className="setting">
            <div className="text">
              <div className="t">Play a sound with alarms</div>
              <div className="d">Notifications stay silent so the chime isn't doubled.</div>
            </div>
            <Switch checked={s.sound.enabled} onChange={(v) => void update({ sound: { ...s.sound, enabled: v } })} label="Alarm sound" />
          </div>
          <div className="setting">
            <div className="text">
              <div className="t">Alarm sound</div>
            </div>
            <Segmented<SoundChoice>
              label="Alarm sound"
              value={s.sound.choice}
              onChange={(v) => {
                void update({ sound: { ...s.sound, choice: v } })
                playSound(v, s.sound.volume)
              }}
              options={[
                { value: 'chime', label: 'Chime' },
                { value: 'bell', label: 'Bell' },
                { value: 'pulse', label: 'Pulse' },
              ]}
            />
            <button className="btn btn-icon" aria-label="Preview sound" onClick={() => playSound(s.sound.choice, s.sound.volume)}>
              <Play />
            </button>
          </div>
          <div className="setting">
            <div className="text">
              <div className="t">Volume</div>
            </div>
            <VolumeSlider value={s.sound.volume} disabled={!s.sound.enabled} onCommit={(v) => void update({ sound: { ...s.sound, volume: v } })} choice={s.sound.choice} />
          </div>
        </section>

        <section className="card settings-card">
          <header>
            <Palette />
            <h2>Appearance & system</h2>
          </header>
          <div className="setting">
            <div className="text">
              <div className="t">Theme</div>
            </div>
            <Segmented
              label="Theme"
              value={s.theme}
              onChange={(v) => void update({ theme: v })}
              options={[
                { value: 'dark', label: <><Moon /> Dark</> },
                { value: 'light', label: <><Sun /> Light</> },
                { value: 'system', label: <><Monitor /> System</> },
              ]}
            />
          </div>
          <div className="setting">
            <div className="text">
              <div className="t">Launch at Windows sign-in</div>
              <div className="d">Starts quietly in the tray so reminders are always running.{!snap.platform.isPackaged ? ' (Applies to the installed app only.)' : ''}</div>
            </div>
            <Switch checked={s.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} label="Launch at sign-in" />
          </div>
          <div className="setting">
            <div className="text">
              <div className="t">Quick-log shortcut</div>
              <div className="d">Opens the command palette from anywhere in Windows.</div>
            </div>
            <HotkeyRecorder value={s.hotkey} onChange={(v) => void update({ hotkey: v }, `Shortcut set to ${v}`)} />
          </div>
        </section>

        <DrugLookupCard />

        <DataCard />

        <section className="card settings-card">
          <header>
            <Keyboard />
            <h2>About</h2>
          </header>
          <div className="setting">
            <div className="text">
              <button
                className="t"
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'default', color: 'inherit', font: 'inherit', fontWeight: 560 }}
                onClick={() => {
                  const n = versionClicks + 1
                  setVersionClicks(n)
                  if (n >= 5 && !s.devMode) {
                    void update({ devMode: true }, 'Developer tools enabled')
                    setVersionClicks(0)
                  }
                }}
              >
                Doseline {snap.platform.version}
              </button>
              <div className="d">Your data stays on this PC. Google Calendar sync is optional.</div>
            </div>
            <button className="btn btn-sm" onClick={() => void api.openLogFolder()}>
              <FolderOpen />
              Open log folder
            </button>
          </div>
        </section>

        {s.devMode && <DevCard onHide={() => void update({ devMode: false })} />}
      </div>
    </div>
  )
}

function GoogleCard() {
  const snap = useSnapshot()
  const { push } = useToasts()
  const g = snap.google
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<'disconnect' | 'forget' | null>(null)
  const [busy, setBusy] = useState(false)
  const reconnect = async () => {
    setBusy(true)
    const r = await api.googleConnect()
    setBusy(false)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else push({ kind: 'success', message: 'Reconnected to Google' })
  }
  return (
    <section className="card settings-card">
      <header>
        <CalendarCheck />
        <h2>Google Calendar</h2>
        <span className="spacer" />
        {g.connected && !g.needsReconnect && <span className="pill taken">Connected</span>}
        {g.needsReconnect && <span className="pill overdue">Reconnect needed</span>}
        {!g.connected && <span className="pill">Not connected</span>}
      </header>
      {g.connected ? (
        <>
          {g.needsReconnect && (
            <div className="callout danger" style={{ margin: '8px 0' }}>
              <TriangleAlert />
              <div style={{ flex: 1 }}>
                Google stopped accepting Doseline's sign-in (it was revoked, or expired because the app is in Testing mode). Local reminders keep working; calendar changes are queued until you reconnect.
              </div>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void reconnect()}>
                Reconnect
              </button>
            </div>
          )}
          <div className="setting">
            <div className="text">
              <div className="t">{g.email ?? 'Google account'}</div>
              <div className="d">
                Doses go to the "{g.calendarName}" calendar, which Doseline created and manages.
                {snap.sync.lastSyncAt ? ` Last synced ${new Date(snap.sync.lastSyncAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}.` : ''}
                {snap.sync.pending ? ` ${snap.sync.pending} change(s) waiting.` : ''}
              </div>
            </div>
            <button className="btn btn-sm" onClick={() => void api.syncNow()}>
              <RefreshCw className={snap.sync.state === 'syncing' ? 'spin' : undefined} />
              Sync now
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirm('disconnect')}>
              <LogOut />
              Disconnect
            </button>
          </div>
          <div className="setting">
            <div className="text">
              <div className="t">Calendar</div>
              <div className="d">Doseline uses the narrow "calendars it creates" permission, so it can only write to its own Medications calendar, never your other calendars.</div>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={() => void api.openExternal('https://calendar.google.com/calendar/r')}>
              Open Google Calendar
            </button>
          </div>
        </>
      ) : editing || !g.configured ? (
        <div style={{ padding: '8px 0 20px' }}>
          <GoogleSetup onDone={() => setEditing(false)} />
        </div>
      ) : (
        <div className="setting">
          <div className="text">
            <div className="t">OAuth client saved</div>
            <div className="d num" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {g.clientId}
            </div>
          </div>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void reconnect()}>
            Sign in with Google
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            Change client
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setConfirm('forget')}>
            Remove
          </button>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm === 'disconnect' ? 'Disconnect Google Calendar?' : 'Remove OAuth client?'}
          body={confirm === 'disconnect' ? 'Doseline stops syncing and revokes its access. Events already in your Medications calendar stay there. Local reminders are unaffected.' : 'This deletes the saved client ID and secret from this PC and signs out.'}
          confirmLabel={confirm === 'disconnect' ? 'Disconnect' : 'Remove'}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm
            setConfirm(null)
            void (c === 'disconnect' ? api.googleDisconnect() : api.googleClearClient()).then((r) => (r.ok ? push({ kind: 'info', message: c === 'disconnect' ? 'Disconnected from Google' : 'OAuth client removed' }) : push({ kind: 'error', message: r.error })))
          }}
        />
      )}
    </section>
  )
}

function DataCard() {
  const { push } = useToasts()
  const run = async (fn: () => Promise<{ ok: boolean; value?: unknown; error?: string }>, msg: string) => {
    const r = await fn()
    if (!r.ok) push({ kind: 'error', message: r.error ?? 'Something went wrong' })
    else if (r.value) push({ kind: 'success', message: msg })
  }
  return (
    <section className="card settings-card">
      <header>
        <Database />
        <h2>Data</h2>
      </header>
      <div className="setting">
        <div className="text">
          <div className="t">Back up everything</div>
          <div className="d">Medications, full history and settings as one JSON file. Google credentials are not included.</div>
        </div>
        <button className="btn btn-sm" onClick={() => void run(() => api.exportBackup(), 'Backup saved')}>
          <Download />
          Export backup
        </button>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Restore from backup</div>
          <div className="d">Replaces all local data after confirmation.</div>
        </div>
        <button className="btn btn-sm" onClick={() => void run(() => api.importBackup(), 'Backup restored')}>
          <Upload />
          Import backup
        </button>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Export history</div>
          <div className="d">CSV of every dose, or a printable PDF report. Use History for a custom date range.</div>
        </div>
        <button className="btn btn-sm" onClick={() => void run(() => api.exportCsv({}), 'History exported')}>
          CSV
        </button>
        <button
          className="btn btn-sm"
          onClick={() => void run(() => api.exportPdf({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() }), 'Report saved')}
        >
          PDF (30 days)
        </button>
      </div>
    </section>
  )
}

function DevCard({ onHide }: { onHide: () => void }) {
  const { push } = useToasts()
  const [confirmDemo, setConfirmDemo] = useState(false)
  return (
    <section className="card settings-card" style={{ borderStyle: 'dashed' }}>
      <header>
        <Bug />
        <h2>Developer</h2>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onHide}>
          Hide
        </button>
      </header>
      <div className="setting">
        <div className="text">
          <div className="t">Fire a test alarm now</div>
          <div className="d">Shows the alarm window, notification and sound with a fake medication. Nothing is logged.</div>
        </div>
        <button className="btn btn-sm" onClick={() => void api.devFireTestAlarm()}>
          Fire alarm
        </button>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Create a 2-minute test dose</div>
          <div className="d">Adds a "Doseline test" medication due in 2 minutes with a 1-minute reminder, plus its Google event if connected. Exercises the whole chain.</div>
        </div>
        <button
          className="btn btn-sm"
          onClick={() =>
            void api.devCreateTestDose().then((r) => push(r.ok ? { kind: 'info', message: r.value, duration: 8000 } : { kind: 'error', message: r.error }))
          }
        >
          Create test dose
        </button>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Load demo data</div>
          <div className="d">Replaces every medication and all history with a fictional demo dataset (five medications, about six months of history). Used for screenshots. Export a backup first if you want to keep your data.</div>
        </div>
        <button className="btn btn-sm btn-danger" onClick={() => setConfirmDemo(true)}>
          Load demo data
        </button>
      </div>
      {confirmDemo && (
        <ConfirmDialog
          title="Replace all data with demo data?"
          body="Every medication and all dose history on this PC will be replaced by fictional demo data. This can't be undone, except by restoring a backup."
          confirmLabel="Replace with demo data"
          danger
          onCancel={() => setConfirmDemo(false)}
          onConfirm={() => {
            setConfirmDemo(false)
            void api.devLoadDemoData().then((r) => push(r.ok ? { kind: 'success', message: r.value } : { kind: 'error', message: r.error }))
          }}
        />
      )}
      <div className="setting">
        <div className="text">
          <div className="t">Overdue escalation test</div>
          <div className="d">
            Creates real test medications due in 1 minute. They escalate after the threshold in Overdue alerts above (set Custom to 5 min to test quickly), then repeat on its interval.
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {[1, 2, 4].map((n) => (
            <button
              key={n}
              className="btn btn-sm"
              onClick={() =>
                void api.devCreateTestDose({ count: n, dueInMin: 1 }).then((r) => push(r.ok ? { kind: 'info', message: r.value, duration: 10000 } : { kind: 'error', message: r.error }))
              }
            >
              {n === 1 ? '1 dose' : `${n} doses`}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Preview the overdue alarm</div>
          <div className="d">Shows the escalated alarm window with fake medications. Nothing is logged.</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm" onClick={() => void api.devFireTestEscalation(1)}>
            Single
          </button>
          <button className="btn btn-sm" onClick={() => void api.devFireTestEscalation(3)}>
            Consolidated
          </button>
        </div>
      </div>
    </section>
  )
}

function OffsetEditor({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const n = Math.round(Number(draft))
    if (n > 0 && n <= 10080) onChange([...new Set([...value, n])].sort((a, b) => b - a))
    setDraft('')
  }
  return (
    <div className="chips-input" style={{ justifyContent: 'flex-end', maxWidth: 360 }}>
      {value.map((o) => (
        <span key={o} className="chip num">
          {minutesLabel(o)}
          <button aria-label={`Remove ${o} minute reminder`} onClick={() => onChange(value.filter((x) => x !== o))}>
            <X />
          </button>
        </span>
      ))}
      <input className="input num" style={{ width: 92, height: 30 }} type="number" min="1" placeholder="Min" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} aria-label="Minutes before" />
      <button className="btn btn-sm btn-icon" onClick={add} disabled={!(Number(draft) > 0)} aria-label="Add reminder">
        <Plus />
      </button>
    </div>
  )
}

function VolumeSlider({ value, onCommit, disabled, choice }: { value: number; onCommit: (v: number) => void; disabled: boolean; choice: SoundChoice }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <div className="row" style={{ width: 240 }}>
      <input
        className="range"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={v}
        disabled={disabled}
        style={{ '--pct': `${v * 100}%` } as React.CSSProperties}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => {
          onCommit(v)
          playSound(choice, v)
        }}
        onKeyUp={() => onCommit(v)}
        aria-label="Volume"
      />
      <span className="small muted num" style={{ width: 40, textAlign: 'right' }}>
        {Math.round(v * 100)}%
      </span>
    </div>
  )
}

const KEY_NAMES: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
      if (!e.ctrlKey && !e.altKey) return // require Ctrl or Alt so we don't hijack typing
      let key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
      if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
      if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
      setRecording(false)
      onChange([...mods, key].join('+'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])
  return (
    <button ref={ref} className={`hotkey-box${recording ? ' recording' : ''}`} onClick={() => setRecording((r) => !r)} aria-label={recording ? 'Press the new shortcut, or Escape to cancel' : `Shortcut ${value}. Click to change`}>
      {recording ? (
        <span className="small">Press keys… (Esc to cancel)</span>
      ) : (
        value.split('+').map((k) => (
          <span key={k} className="kbd">
            {k}
          </span>
        ))
      )}
    </button>
  )
}

function DrugLookupCard() {
  const snap = useSnapshot()
  const { push } = useToasts()
  const [editingKey, setEditingKey] = useState(false)
  const [key, setKey] = useState('')
  const on = snap.settings.drugLookup
  const saveKey = async (value: string | null) => {
    const r = await api.setOpenFdaKey(value)
    if (!r.ok) return push({ kind: 'error', message: r.error })
    setEditingKey(false)
    setKey('')
    push({ kind: 'success', message: value ? 'openFDA API key saved' : 'openFDA API key removed' })
  }
  return (
    <section className="card settings-card">
      <header>
        <Pill />
        <h2>Drug lookup</h2>
      </header>
      <div className="setting">
        <div className="text">
          <div className="t">Online drug lookup</div>
          <div className="d">
            Suggests drug names and strengths as you type. Typed drug names are sent to the NLM (RxTerms) and FDA (openFDA) public APIs. No account, name or other personal identifier is sent.
          </div>
        </div>
        <Switch
          checked={on}
          onChange={async (v) => {
            const r = await api.updateSettings({ drugLookup: v })
            if (!r.ok) push({ kind: 'error', message: r.error })
          }}
          label="Online drug lookup"
        />
      </div>
      {on && (
        <div className="setting" style={{ alignItems: 'flex-start' }}>
          <div className="text">
            <div className="t">openFDA API key</div>
            <div className="d">Optional. Doseline works without one; a free key only raises FDA's rate limits. Stored encrypted on this PC.</div>
          </div>
          {editingKey ? (
            <form
              className="row"
              style={{ gap: 6 }}
              onSubmit={(e) => {
                e.preventDefault()
                void saveKey(key)
              }}
            >
              <input className="input" style={{ width: 220 }} type="password" autoComplete="off" spellCheck={false} placeholder="Paste key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="openFDA API key" autoFocus />
              <button className="btn btn-primary btn-sm" disabled={!key.trim()}>
                Save
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingKey(false)}>
                Cancel
              </button>
            </form>
          ) : snap.drugs.openFdaKeySet ? (
            <div className="row" style={{ gap: 6 }}>
              <span className="pill taken">Key saved</span>
              <button className="btn btn-sm" onClick={() => setEditingKey(true)}>
                Change
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void saveKey(null)}>
                Remove
              </button>
            </div>
          ) : (
            <button className="btn btn-sm" onClick={() => setEditingKey(true)}>
              <Plus />
              Add key
            </button>
          )}
        </div>
      )}
    </section>
  )
}

const REPEAT_OPTIONS = [5, 10, 15, 20, 30, 45, 60]

function OverdueAlertsCard() {
  const snap = useSnapshot()
  const { push } = useToasts()
  const e = snap.settings.escalation
  const sound = snap.settings.sound
  const update = async (patch: Partial<Omit<Settings['escalation'], 'quietHours'>> & { quietHours?: Partial<Settings['escalation']['quietHours']> }) => {
    const r = await api.updateSettings({ escalation: patch })
    if (!r.ok) push({ kind: 'error', message: r.error })
  }
  return (
    <section className="card settings-card" id="overdue-alerts">
      <header>
        <Siren />
        <h2>Overdue alerts</h2>
      </header>
      <div className="setting" style={{ alignItems: 'flex-start' }}>
        <div className="text">
          <div className="t">Escalate after</div>
          <div className="d">When a scheduled dose is still unlogged this long after it was due, a more urgent alarm starts and repeats until you take, skip or snooze it. As-needed medications never escalate.</div>
        </div>
        <EscalationPicker label="Escalate after" value={e.thresholdMinutes} onChange={(v) => v && void update({ thresholdMinutes: v })} />
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Repeat every</div>
          <div className="d">Snoozing an overdue alarm only delays the next repeat.</div>
        </div>
        <select className="select" style={{ width: 150 }} value={e.repeatMinutes} onChange={(ev) => void update({ repeatMinutes: Number(ev.target.value) })} aria-label="Repeat every">
          {[...new Set([...REPEAT_OPTIONS, e.repeatMinutes])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {minutesLabel(m)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Overdue sound</div>
          <div className="d">{sound.enabled ? 'Played once per repeat, at the alarm volume.' : 'Alarm sounds are off in Sound below.'}</div>
        </div>
        <Segmented<SoundChoice>
          label="Overdue sound"
          value={e.sound}
          onChange={(v) => {
            void update({ sound: v })
            playSound(v, sound.volume)
          }}
          options={[
            { value: 'urgent', label: 'Urgent' },
            { value: 'siren', label: 'Siren' },
            { value: 'bell', label: 'Bell' },
          ]}
        />
        <button className="btn btn-icon" aria-label="Preview overdue sound" onClick={() => playSound(e.sound, sound.volume)}>
          <Play />
        </button>
      </div>
      <div className="setting">
        <div className="text">
          <div className="t">Quiet hours</div>
          <div className="d">Overdue alarms still appear and flash the taskbar, but stay silent. Sound returns with the first alarm after quiet hours end.</div>
        </div>
        <Switch checked={e.quietHours.enabled} onChange={(v) => void update({ quietHours: { enabled: v } })} label="Quiet hours" />
      </div>
      {e.quietHours.enabled && (
        <div className="setting">
          <div className="text">
            <div className="t">Quiet from</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input className="input num" type="time" style={{ width: 130 }} value={e.quietHours.start} onChange={(ev) => isValidClock(ev.target.value) && void update({ quietHours: { start: ev.target.value } })} aria-label="Quiet hours start" />
            <span className="small muted">to</span>
            <input className="input num" type="time" style={{ width: 130 }} value={e.quietHours.end} onChange={(ev) => isValidClock(ev.target.value) && void update({ quietHours: { end: ev.target.value } })} aria-label="Quiet hours end" />
          </div>
        </div>
      )}
    </section>
  )
}
