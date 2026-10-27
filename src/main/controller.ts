import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Notification, app, dialog, globalShortcut, ipcMain, nativeTheme, net, shell } from 'electron'
import { AlarmEngine } from '../core/alarmEngine'
import type { MissedDose, PlannedAlarm } from '../core/alarms'
import { doseLine, eventTitle } from '../core/calendar'
import { logsToCsv, makeBackup, parseBackup } from '../core/exporting'
import { buildDemoData } from '../core/demo'
import { GoogleCalendarGateway } from '../core/googleCalendar'
import type { AlarmPresenter, EscalationAlert, Logger, TimerScheduler } from '../core/ports'
import { ESCALATION_SNOOZE_OPTIONS, overdueLabel } from '../core/escalation'
import { computeNextDue } from '../core/schedule'
import { DoseService } from '../core/service'
import { CalendarSync } from '../core/sync'
import { upNext } from '../core/today'
import { CALENDAR_NAME } from '../core/calendar'
import type { Medication, Settings } from '../core/types'
import type { AlarmAction, AlarmView, AlarmWindowState, AppSnapshot, ExportRange, Result, Route, ToastMessage } from '../shared/api'
import { SqliteRepository } from './db'
import { is } from './env'
import { GoogleAuth } from './googleAuth'
import { FileLogger } from './logger'
import { OAuthClientStore, SafeStorageTokenStore } from './secureStore'
import { DoselineTray } from './tray'
import { DrugService } from './drugs'
import { createAlarmWindow, createMainWindow, createPaletteWindow, createReportWindow, placeBottomRight, placePalette, resizeAlarmWindow, supportsMica, titleBarOverlay } from './windows'

const TICK_MS = 30_000

export interface Assets {
  icon: string
  iconPng: string
  trayIcon: string
}

const nodeTimers: TimerScheduler = {
  setTimer(at, cb) {
    // setTimeout overflows above ~24.8 days; AlarmEngine never asks for more than an hour.
    return setTimeout(cb, Math.max(0, Math.min(at.getTime() - Date.now(), 2 ** 31 - 1)))
  },
  clearTimer(h) {
    clearTimeout(h as NodeJS.Timeout)
  },
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail(e: unknown): Result<never> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

/** Composition root: wires core services to Electron adapters and owns windows. */
export class AppController implements AlarmPresenter {
  readonly logger: Logger
  readonly repo: SqliteRepository
  readonly auth: GoogleAuth
  readonly clients: OAuthClientStore
  readonly sync: CalendarSync
  readonly service: DoseService
  readonly engine: AlarmEngine
  readonly drugs: DrugService
  private tray: DoselineTray | null = null
  mainWindow: BrowserWindow | null = null
  private alarmWindow: BrowserWindow | null = null
  private paletteWindow: BrowserWindow | null = null
  private alarms: AlarmView[] = []
  private ring = 0
  private ringSound: AlarmWindowState['ringSound'] = 'normal'
  private zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  private settingsCache: Settings | null = null
  private broadcastTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private wasOnline = true
  private registeredHotkey: string | null = null
  quitting = false
  private hiddenHintShown = false

  constructor(private assets: Assets) {
    const userData = app.getPath('userData')
    this.logger = new FileLogger(path.join(userData, 'logs'), is.dev)
    this.repo = new SqliteRepository(path.join(userData, 'doseline.db'))
    this.clients = new OAuthClientStore(path.join(userData, 'secure'))
    this.auth = new GoogleAuth(new SafeStorageTokenStore(path.join(userData, 'secure')), this.clients, this.logger, () => this.scheduleBroadcast())
    const gateway = new GoogleCalendarGateway(this.auth, (input, init) => net.fetch(input, init))
    const clock = { now: () => new Date() }
    const zone = () => this.zone
    this.sync = new CalendarSync({ repo: this.repo, gateway, auth: this.auth, clock, zone, logger: this.logger, onStatus: () => this.scheduleBroadcast() })
    this.service = new DoseService({
      repo: this.repo,
      clock,
      zone,
      newId: () => crypto.randomUUID(),
      onChanged: (ids) => this.onDataChanged(ids),
    })
    this.engine = new AlarmEngine({ repo: this.repo, clock, zone, timers: nodeTimers, presenter: this, logger: this.logger })
    this.drugs = new DrugService(this.repo, this.logger, () => this.settings(), path.join(userData, 'secure'))
  }

  // ---------------------------------------------------------------- lifecycle

  async start(startHidden: boolean): Promise<void> {
    this.logger.info('app start', { version: app.getVersion(), packaged: is.packaged })
    const settings = await this.settings()
    this.applyTheme(settings.theme)
    this.applyLoginItem(settings.launchAtLogin)
    this.createMain(!startHidden)
    this.tray = new DoselineTray(this.assets.trayIcon, this)
    this.registerHotkey(settings.hotkey)
    await this.engine.recompute('startup', true)
    await this.sync.enqueueAll()
    void this.sync.run()
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS)
    this.scheduleBroadcast()
  }

  async shutdown(): Promise<void> {
    this.quitting = true
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.engine.stop()
    globalShortcut.unregisterAll()
    this.tray?.destroy()
    try {
      this.repo.close()
    } catch {
      /* ignore */
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.engine.tick(TICK_MS)
      const online = net.isOnline()
      if (online && !this.wasOnline) {
        this.logger.info('network back online; retrying sync')
        const jobs = await this.repo.listSyncJobs()
        await this.sync.enqueue(jobs.map((j) => j.target))
      }
      this.wasOnline = online
      const next = await this.sync.nextRunAt()
      if (next && next.getTime() <= Date.now()) void this.sync.run()
      void this.refreshTray()
    } catch (e) {
      this.logger.error('tick failed', { error: String(e) })
    }
  }

  /** System resumed, unlocked, or clock/zone changed: rebuild every timer from scratch. */
  async onSystemChange(reason: string): Promise<void> {
    this.logger.info('system change', { reason })
    await this.engine.recompute(reason, true)
    this.scheduleBroadcast()
    void this.sync.run()
  }

  setZone(zone: string): void {
    if (!zone || zone === this.zone) return
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
    } catch {
      return
    }
    this.logger.info('time zone changed', { from: this.zone, to: zone })
    this.zone = zone
    void this.onSystemChange('timezone')
    void this.sync.enqueueAll().then(() => this.sync.run())
  }

  private async onDataChanged(ids: string[]): Promise<void> {
    this.settingsCache = null
    await this.engine.recompute('data-change')
    await this.pruneAlarms()
    this.scheduleBroadcast()
    await this.sync.enqueueMeds(ids)
    void this.sync.run().catch((e) => this.logger.error('sync run failed', { error: String(e) }))
  }

  async settings(): Promise<Settings> {
    if (!this.settingsCache) this.settingsCache = await this.repo.getSettings()
    return this.settingsCache
  }

  // ---------------------------------------------------------------- snapshot

  async snapshot(): Promise<AppSnapshot> {
    const [meds, logs, settings, missed, connected, email, escalations] = await Promise.all([
      this.repo.listMedications(),
      this.repo.listLogs(),
      this.settings(),
      this.engine.getMissed(),
      this.auth.isConnected(),
      this.auth.email(),
      this.engine.currentEscalations(),
    ])
    const client = this.clients.load()
    return {
      meds,
      logs,
      settings,
      zone: this.zone,
      google: {
        configured: !!client,
        clientId: client?.clientId ?? null,
        connected,
        email,
        needsReconnect: connected && (this.auth.needsReconnect || this.sync.getStatus().state === 'reconnect'),
        calendarName: CALENDAR_NAME,
        connecting: this.auth.connecting,
      },
      sync: this.sync.getStatus(),
      drugs: { openFdaKeySet: this.drugs.keySet },
      escalations: escalations.map((p) => ({
        medicationId: p.medicationId,
        dueAt: p.dueAt.toISOString(),
        escalatedAt: p.record?.escalatedAt ?? p.startAt.toISOString(),
        repeats: p.record?.repeats ?? 0,
        nextAt: p.fireAt.toISOString(),
      })),
      missed,
      platform: { version: app.getVersion(), mica: supportsMica, isPackaged: is.packaged, logPath: (this.logger as FileLogger).file },
    }
  }

  scheduleBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      void this.broadcast()
    }, 40)
  }

  private async broadcast(): Promise<void> {
    try {
      const snap = await this.snapshot()
      for (const w of [this.mainWindow, this.paletteWindow]) if (w && !w.isDestroyed()) w.webContents.send('snapshot', snap)
      await this.refreshTray()
    } catch (e) {
      this.logger.error('broadcast failed', { error: String(e) })
    }
  }

  toast(t: ToastMessage): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('toast', t)
  }

  reportError(context: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e)
    this.logger.error(context, { error: msg })
    this.toast({ kind: 'error', message: msg })
  }

  // ---------------------------------------------------------------- windows

  /** Create the main window. Closing it only hides it; if it was ever destroyed, it is rebuilt on demand. */
  private createMain(show: boolean): BrowserWindow {
    const win = createMainWindow(this.assets.icon)
    this.mainWindow = win
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      win.hide()
      if (!this.hiddenHintShown && Notification.isSupported()) {
        this.hiddenHintShown = true
        this.notify('Doseline is still running', 'Reminders keep working from the system tray. Right-click the tray icon to quit.')
      }
    })
    win.on('closed', () => {
      if (this.mainWindow === win) this.mainWindow = null
    })
    win.once('ready-to-show', () => {
      if (show) win.show()
    })
    return win
  }

  showMain(route?: Route): void {
    let w = this.mainWindow
    if (!w || w.isDestroyed()) {
      w = this.createMain(true)
      if (route) w.webContents.once('did-finish-load', () => w!.webContents.send('navigate', route))
      return
    }
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    if (route) w.webContents.send('navigate', route)
  }

  applyTheme(theme: Settings['theme']): void {
    nativeTheme.themeSource = theme
    const w = this.mainWindow
    if (w && !w.isDestroyed()) {
      try {
        w.setTitleBarOverlay(titleBarOverlay())
      } catch {
        /* overlay not available */
      }
      if (!supportsMica) w.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#101216' : '#f5f6f8')
    }
  }

  applyLoginItem(enabled: boolean): void {
    if (!is.packaged) return
    const portable = process.env['PORTABLE_EXECUTABLE_FILE']
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'], ...(portable ? { path: portable } : {}) })
  }

  registerHotkey(accel: string): boolean {
    if (this.registeredHotkey) globalShortcut.unregister(this.registeredHotkey)
    this.registeredHotkey = null
    if (!accel) return true
    try {
      const okReg = globalShortcut.register(accel, () => this.openPalette())
      if (okReg) this.registeredHotkey = accel
      else this.toast({ kind: 'error', message: `The shortcut ${accel} is already used by another app.` })
      return okReg
    } catch {
      this.toast({ kind: 'error', message: `"${accel}" is not a valid shortcut.` })
      return false
    }
  }

  openPalette(): void {
    if (!this.paletteWindow || this.paletteWindow.isDestroyed()) {
      this.paletteWindow = createPaletteWindow(this.assets.icon)
      this.paletteWindow.on('blur', () => this.paletteWindow?.hide())
      this.paletteWindow.once('ready-to-show', () => this.revealPalette())
      return
    }
    this.revealPalette()
  }

  private revealPalette(): void {
    const w = this.paletteWindow
    if (!w) return
    placePalette(w)
    w.webContents.send('palette-open')
    void this.snapshot().then((s) => w.webContents.send('snapshot', s))
    w.show()
    w.focus()
  }

  closePalette(): void {
    this.paletteWindow?.hide()
  }

  // ---------------------------------------------------------------- alarms (AlarmPresenter)

  present(alarm: PlannedAlarm, med: Medication, test = false): void {
    void this.settings().then((settings) => {
      const view: AlarmView = {
        key: alarm.id,
        medicationId: med.id,
        name: med.name,
        strength: med.strength,
        dose: doseLine(med),
        instructions: med.instructions,
        color: med.color,
        icon: med.icon,
        dueAt: alarm.dueAt.toISOString(),
        offsetMin: alarm.offsetMin,
        kind: alarm.kind,
        test,
      }
      // An escalation card for this med stays; a plain reminder never replaces it.
      if (this.alarms.some((a) => a.medicationId === med.id && a.kind === 'escalation')) return
      this.alarms = [view, ...this.alarms.filter((a) => a.medicationId !== med.id)]
      this.ring++
      this.ringSound = 'normal'
      const when = alarm.kind === 'reminder' ? `due in ${alarm.offsetMin} min` : 'due now'
      this.notify(`${eventTitle(med)} · ${when}`, [doseLine(med), med.instructions].filter(Boolean).join(' · '), settings.sound.enabled, () => this.showAlarmWindow(true))
      this.showAlarmWindow(false)
      this.logger.info('alarm presented', { kind: alarm.kind, offset: alarm.offsetMin })
    })
  }

  presentEscalation(alerts: EscalationAlert[], opts: { quiet: boolean }): void {
    this.showEscalation(alerts, opts.quiet, false)
  }

  /** One consolidated window, one sound and (when needed) one notification per escalation cycle. */
  private showEscalation(alerts: EscalationAlert[], quiet: boolean, test: boolean): void {
    void this.settings().then((settings) => {
      const views: AlarmView[] = alerts.map((a) => ({
        key: `esc|${a.med.id}|${a.dueAt.toISOString()}`,
        medicationId: a.med.id,
        name: a.med.name,
        strength: a.med.strength,
        dose: doseLine(a.med),
        instructions: a.med.instructions,
        color: a.med.color,
        icon: a.med.icon,
        dueAt: a.dueAt.toISOString(),
        offsetMin: 0,
        kind: 'escalation',
        escalatedAt: a.escalatedAt.toISOString(),
        repeats: a.repeats,
        test,
      }))
      const ids = new Set(views.map((v) => v.medicationId))
      const keptEscalations = this.alarms.filter((a) => a.kind === 'escalation' && !ids.has(a.medicationId))
      const others = this.alarms.filter((a) => a.kind !== 'escalation' && !ids.has(a.medicationId))
      this.alarms = [...views, ...keptEscalations, ...others]
      this.ring++
      this.ringSound = quiet || !settings.sound.enabled ? 'silent' : 'escalation'
      const windowFocused = !!this.alarmWindow && !this.alarmWindow.isDestroyed() && this.alarmWindow.isFocused()
      if (alerts.some((a) => a.first) || !windowFocused) {
        const now = new Date()
        const title = alerts.length === 1 ? `Overdue: ${eventTitle(alerts[0]!.med)}` : `${alerts.length} doses overdue`
        // Windows toasts show only a few lines and can't grow, so summarise beyond two medications.
        const body =
          alerts.length <= 2
            ? alerts.map((a) => `${a.med.name} · overdue by ${overdueLabel(a.dueAt, now)}`).join('\n')
            : `${alerts
                .slice(0, 2)
                .map((a) => a.med.name)
                .join(', ')} and ${alerts.length - 2} more. Open the alarm to log each one.`
        this.notify(title, body, true, () => this.showAlarmWindow(true))
      }
      this.showAlarmWindow(false)
      this.scheduleBroadcast()
    })
  }

  /** The alarm window reports the height its content needs. */
  resizeAlarm(height: number, width: number): void {
    if (this.alarmWindow && !this.alarmWindow.isDestroyed()) resizeAlarmWindow(this.alarmWindow, height, width)
  }

  showMissed(missed: MissedDose[]): void {
    const n = missed.length
    this.notify('Missed while you were away', `${n} dose${n === 1 ? '' : 's'} came due while your PC was asleep or off. Open Doseline to review.`, false, () => this.showMain('today'))
    this.scheduleBroadcast()
  }

  private notify(title: string, body: string, silent = false, onClick?: () => void): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, icon: this.assets.iconPng, silent, timeoutType: 'default' })
    n.on('click', () => (onClick ? onClick() : this.showMain()))
    n.show()
  }

  private async alarmState(): Promise<AlarmWindowState> {
    const s = await this.settings()
    return { alarms: this.alarms, sound: s.sound, escalationSound: s.escalation.sound, theme: s.theme, ring: this.ring, ringSound: this.ringSound }
  }

  getAlarmState(): Promise<AlarmWindowState> {
    return this.alarmState()
  }

  private showAlarmWindow(focus: boolean): void {
    if (!this.alarmWindow || this.alarmWindow.isDestroyed()) {
      this.alarmWindow = createAlarmWindow(this.assets.icon)
      this.alarmWindow.on('closed', () => (this.alarmWindow = null))
      // Focusing the alarm acknowledges it: stop flashing the taskbar button.
      this.alarmWindow.on('focus', () => this.alarmWindow?.flashFrame(false))
      this.alarmWindow.once('ready-to-show', () => this.revealAlarm(focus))
      return
    }
    void this.alarmState().then((s) => this.alarmWindow?.webContents.send('alarm-state', s))
    this.revealAlarm(focus)
  }

  private revealAlarm(focus: boolean): void {
    const w = this.alarmWindow
    if (!w) return
    if (!w.isVisible()) placeBottomRight(w)
    w.setAlwaysOnTop(true, 'screen-saver')
    if (focus) {
      w.show()
      w.focus()
    } else {
      w.showInactive()
      w.flashFrame(true)
    }
    void this.alarmState().then((s) => w.webContents.send('alarm-state', s))
  }

  private async pushAlarmState(): Promise<void> {
    if (!this.alarmWindow || this.alarmWindow.isDestroyed()) return
    if (this.alarms.length === 0) {
      this.alarmWindow.hide()
      this.alarmWindow.flashFrame(false)
    }
    this.alarmWindow.webContents.send('alarm-state', await this.alarmState())
  }

  /** Drop alarm cards whose dose was handled elsewhere (main window, tray, palette). */
  private async pruneAlarms(): Promise<void> {
    if (!this.alarms.length) return
    const [meds, logs] = await Promise.all([this.repo.listMedications(), this.repo.listLogs()])
    const byId = new Map(meds.map((m) => [m.id, m]))
    const before = this.alarms.length
    this.alarms = this.alarms.filter((a) => {
      if (a.test) return true
      const m = byId.get(a.medicationId)
      if (!m) return false
      const next = computeNextDue(m, logs, new Date(), this.zone)
      return !!next && next.dueAt.toISOString() === a.dueAt
    })
    if (this.alarms.length !== before) await this.pushAlarmState()
  }

  async alarmAct(key: string, action: AlarmAction, arg: number | Date = 10): Promise<void> {
    const a = this.alarms.find((x) => x.key === key)
    if (!a) return
    this.alarmWindow?.flashFrame(false)
    this.alarms = this.alarms.filter((x) => x.key !== key)
    const minutes = typeof arg === 'number' ? arg : 10
    const escalation = a.kind === 'escalation'
    if (!a.test) {
      if (action === 'take' || action === 'takeAt') {
        const at = action === 'takeAt' && arg instanceof Date ? arg : undefined
        const r = await this.service.logDose({ medicationId: a.medicationId, kind: 'taken', at })
        const when = at ? ` at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
        this.toast({ kind: 'success', message: `Logged ${a.name}${when}` })
        if (r.warnings.length) this.toast({ kind: 'info', message: r.warnings[0]!.message })
      } else if (action === 'skip') {
        const med = await this.repo.getMedication(a.medicationId)
        if (med && med.schedule.type !== 'prn') await this.service.logDose({ medicationId: a.medicationId, kind: 'skipped' })
      } else if (action === 'snooze' && escalation) {
        // Defers only the next repeat; the dose stays escalated.
        await this.engine.snoozeEscalation(a.medicationId, new Date(a.dueAt), ESCALATION_SNOOZE_OPTIONS.includes(minutes) ? minutes : 15)
        this.scheduleBroadcast()
      } else if (action === 'snooze') {
        const mins = [5, 10, 15].includes(minutes) ? minutes : 10
        await this.repo.saveSnooze({ id: crypto.randomUUID(), medicationId: a.medicationId, dueAt: a.dueAt, fireAt: new Date(Date.now() + mins * 60_000).toISOString() })
        await this.engine.recompute('snooze')
      }
    } else if (action === 'snooze' && !escalation) {
      const mins = [5, 10, 15].includes(minutes) ? minutes : 10
      setTimeout(() => this.fireTestAlarm(), mins * 60_000)
    }
    await this.pushAlarmState()
  }

  /** Developer helper: replace all local data with the fictional demo dataset (for screenshots and trying the app). */
  async loadDemoData(): Promise<string> {
    if (await this.auth.isConnected()) throw new Error('Disconnect Google Calendar first, so demo medications are not added to your calendar.')
    const now = new Date()
    const { medications, logs } = buildDemoData(now, this.zone, () => crypto.randomUUID())
    const settings = { ...(await this.repo.getSettings()), onboarded: true }
    await this.repo.importAll(makeBackup(medications, logs, settings, now))
    this.settingsCache = null
    this.alarms = []
    await this.pushAlarmState()
    await this.engine.dismissMissed()
    await this.engine.recompute('demo-data')
    this.scheduleBroadcast()
    return `Loaded ${medications.length} demo medications and ${logs.length} history entries.`
  }

  /** Developer helper: the escalated alarm window with `count` fake overdue medications. */
  fireTestEscalation(count: number): void {
    const now = Date.now()
    const samples: [string, string, Medication['icon'], number][] = [
      ['Metoprolol XR', '#f2626a', 'tablet', 75],
      ['Atorvastatin', '#7aa2ff', 'pill', 48],
      ['Levothyroxine', '#f1b65a', 'capsule', 32],
      ['Insulin glargine', '#52c98e', 'syringe', 106],
    ]
    const alerts: EscalationAlert[] = samples.slice(0, Math.max(1, Math.min(4, count))).map(([name, color, icon, overdueMin], i) => ({
      med: {
        id: `test-esc-${i}`,
        name,
        strength: ['50 mg', '20 mg', '75 mcg', '100 units/ml'][i]!,
        form: 'tablet',
        doseAmount: 1,
        doseUnit: icon === 'syringe' ? 'units' : 'tablet',
        instructions: i === 0 ? 'with food' : '',
        color,
        icon,
        notes: '',
        schedule: { type: 'interval', everyHours: 24 },
        active: true,
        pauses: [],
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      dueAt: new Date(now - overdueMin * 60_000),
      escalatedAt: new Date(now - (overdueMin - 30) * 60_000),
      repeats: Math.floor((overdueMin - 30) / 15),
      first: false,
    }))
    void this.settings().then((s) => this.showEscalation(alerts, false, true))
  }

  fireTestAlarm(): void {
    const med: Medication = {
      id: 'test',
      name: 'Test medication',
      strength: '5 mg',
      form: 'tablet',
      doseAmount: 1,
      doseUnit: 'tablet',
      instructions: 'This is a test alarm',
      color: '#7c8cff',
      icon: 'capsule',
      notes: '',
      schedule: { type: 'interval', everyHours: 24 },
      active: true,
      pauses: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const now = new Date()
    this.present({ id: `test|${now.toISOString()}`, medicationId: 'test', dueAt: now, fireAt: now, offsetMin: 0, kind: 'due' }, med, true)
  }

  async createTestDose(count = 1, dueInMin = 2): Promise<string> {
    const n = Math.max(1, Math.min(4, Math.round(count)))
    const lead = Math.max(1, Math.min(60, Math.round(dueInMin)))
    for (const m of await this.repo.listMedications()) if (m.name.startsWith('Doseline test')) await this.service.deleteMedication(m.id)
    const due = new Date(Date.now() + lead * 60_000)
    const colors = ['#a78bfa', '#4fb8e6', '#f2b84b', '#5cc98a']
    for (let i = 0; i < n; i++) {
      await this.service.saveMedication({
        name: n === 1 ? 'Doseline test' : `Doseline test ${i + 1}`,
        strength: '1 mg',
        form: 'tablet',
        doseAmount: 1,
        doseUnit: 'tablet',
        instructions: 'Developer test dose. Delete me when done.',
        color: colors[i]!,
        icon: 'capsule',
        notes: '',
        schedule: { type: 'interval', everyHours: 24, firstDoseAt: due.toISOString() },
        active: true,
        reminderOffsets: lead > 1 ? [lead - 1] : [],
      })
    }
    const settings = await this.settings()
    const escAt = new Date(due.getTime() + settings.escalation.thresholdMinutes * 60_000)
    const connected = await this.auth.isConnected()
    const what = n === 1 ? 'Test dose' : `${n} test doses`
    return `${what} due at ${due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; escalation at ${escAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, then every ${settings.escalation.repeatMinutes} min.${connected ? ' Matching events are being created in your Medications calendar.' : ''}`
  }

  // ---------------------------------------------------------------- tray

  async refreshTray(): Promise<void> {
    if (!this.tray) return
    const [meds, logs, settings] = await Promise.all([this.repo.listMedications(), this.repo.listLogs(), this.settings()])
    const items = upNext(meds, logs, new Date(), this.zone, settings.graceMinutes)
    this.tray.update(items)
  }

  async quickLog(medicationId: string): Promise<void> {
    try {
      const med = await this.repo.getMedication(medicationId)
      if (!med) return
      const r = await this.service.logDose({ medicationId, kind: 'taken' })
      const t = new Date(r.log.takenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      this.notify(`Logged ${eventTitle(med).replace('💊 ', '')}`, r.warnings.length ? `⚠ ${r.warnings[0]!.message}` : `Taken at ${t}`, true)
      this.toast({ kind: 'success', message: `Logged ${med.name} at ${t}` })
    } catch (e) {
      this.reportError('quick log failed', e)
    }
  }

  // ---------------------------------------------------------------- export / backup

  /** Save dialog, or (for automated testing) a fixed folder from DOSELINE_EXPORT_DIR. */
  private async savePath(title: string, defaultPath: string, filters: Electron.FileFilter[]): Promise<string | null> {
    const dir = process.env['DOSELINE_EXPORT_DIR']
    if (dir) return path.join(dir, defaultPath)
    const res = await dialog.showSaveDialog(this.mainWindow!, { title, defaultPath, filters })
    return res.canceled || !res.filePath ? null : res.filePath
  }

  private range(r: ExportRange): { from?: Date; to?: Date; medicationId?: string } {
    return { from: r.from ? new Date(r.from) : undefined, to: r.to ? new Date(r.to) : undefined, medicationId: r.medicationId || undefined }
  }

  async exportCsv(r: ExportRange): Promise<string | null> {
    const stamp = new Date().toISOString().slice(0, 10)
    const file = await this.savePath('Export dose history', `doseline-history-${stamp}.csv`, [{ name: 'CSV', extensions: ['csv'] }])
    if (!file) return null
    const logs = await this.repo.listLogs(this.range(r))
    const meds = await this.repo.listMedications()
    fs.writeFileSync(file, '﻿' + logsToCsv(logs, meds, this.zone), 'utf8')
    return file
  }

  async exportPdf(r: ExportRange): Promise<string | null> {
    const stamp = new Date().toISOString().slice(0, 10)
    const file = await this.savePath('Save report', `doseline-report-${stamp}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
    if (!file) return null
    const q = new URLSearchParams({ from: r.from ?? '', to: r.to ?? '' }).toString()
    const rw = createReportWindow(q)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The report took too long to render.')), 20_000)
        const handler = (e: Electron.IpcMainEvent) => {
          if (e.sender !== rw.webContents) return
          clearTimeout(timer)
          ipcMain.removeListener('report:ready', handler)
          resolve()
        }
        ipcMain.on('report:ready', handler)
      })
      const pdf = await rw.webContents.printToPDF({
        pageSize: app.getLocale() === 'en-US' ? 'Letter' : 'A4',
        printBackground: true,
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      })
      fs.writeFileSync(file, pdf)
    } finally {
      rw.destroy()
    }
    if (!process.env['DOSELINE_EXPORT_DIR']) shell.showItemInFolder(file)
    return file
  }

  async exportBackup(): Promise<string | null> {
    const stamp = new Date().toISOString().slice(0, 10)
    const file = await this.savePath('Back up Doseline data', `doseline-backup-${stamp}.json`, [{ name: 'Doseline backup', extensions: ['json'] }])
    if (!file) return null
    const data = await this.repo.exportAll()
    const backup = makeBackup(data.medications, data.logs, data.settings, new Date(), data.kv)
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8')
    return file
  }

  async importBackup(): Promise<boolean> {
    const res = await dialog.showOpenDialog(this.mainWindow!, { title: 'Restore from backup', properties: ['openFile'], filters: [{ name: 'Doseline backup', extensions: ['json'] }] })
    if (res.canceled || !res.filePaths[0]) return false
    const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')) as unknown
    const data = parseBackup(raw)
    const confirm = await dialog.showMessageBox(this.mainWindow!, {
      type: 'warning',
      buttons: ['Replace my data', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Restore backup',
      message: `Replace all local data with this backup?`,
      detail: `The backup contains ${data.medications.length} medication(s) and ${data.logs.length} log entries. Your current data will be overwritten.`,
    })
    if (confirm.response !== 0) return false
    await this.repo.importAll(data)
    this.settingsCache = null
    const settings = await this.settings()
    this.applyTheme(settings.theme)
    this.registerHotkey(settings.hotkey)
    await this.engine.recompute('import')
    await this.sync.enqueueAll()
    void this.sync.run()
    this.scheduleBroadcast()
    return true
  }
}
