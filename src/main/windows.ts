import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, nativeTheme, screen, shell, type BrowserWindowConstructorOptions } from 'electron'
import { is } from './env'

export const supportsMica = process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) >= 22621

const PRELOAD = path.join(__dirname, '../preload/index.js')

const DARK_BG = '#101216'
const LIGHT_BG = '#f5f6f8'

export function themeBg(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG
}

function baseWebPreferences(): BrowserWindowConstructorOptions['webPreferences'] {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    // Alarm chimes must play without a prior click in that window.
    autoplayPolicy: 'no-user-gesture-required',
    devTools: !is.packaged,
  }
}

/** Load a renderer route (hash-based) in dev server or from the bundled file. */
export function loadRoute(win: BrowserWindow, hash: string): Promise<void> {
  if (!is.packaged && process.env['ELECTRON_RENDERER_URL']) return win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  return win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash })
}

/** Deny navigation and new windows; http(s) links open in the system browser. */
export function harden(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    e.preventDefault()
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
}

export function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: supportsMica ? '#00000000' : dark ? DARK_BG : LIGHT_BG, symbolColor: dark ? '#c9ced8' : '#3a3f4a', height: 44 }
}

export function createMainWindow(icon: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'Doseline',
    icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    backgroundColor: supportsMica ? '#00000000' : themeBg(),
    ...(supportsMica ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: { ...baseWebPreferences(), backgroundThrottling: false },
  })
  harden(win)
  void loadRoute(win, '/')
  return win
}

export function createAlarmWindow(icon: string): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 420
  const height = 336
  const win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + workArea.height - height - 16,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    title: 'Doseline alarm',
    icon,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: { ...baseWebPreferences(), backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  harden(win)
  void loadRoute(win, '/alarm')
  return win
}

export function createPaletteWindow(icon: string): BrowserWindow {
  const width = 560
  const height = 420
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.18),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Doseline quick log',
    icon,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: baseWebPreferences(),
  })
  harden(win)
  void loadRoute(win, '/palette')
  return win
}

export function createReportWindow(query: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 1200,
    show: false,
    webPreferences: { ...baseWebPreferences(), offscreen: false },
  })
  harden(win)
  void loadRoute(win, `/report?${query}`)
  return win
}

const ALARM_MIN_H = 220
const ALARM_MAX_H = 720

/** Fit the alarm window to its content, keeping it anchored to the bottom-right corner. */
export function resizeAlarmWindow(win: BrowserWindow, contentHeight: number, width: number): void {
  const h = Math.round(Math.min(ALARM_MAX_H, Math.max(ALARM_MIN_H, contentHeight)))
  const w = Math.round(Math.min(560, Math.max(380, width)))
  const [curW, curH] = win.getSize() as [number, number]
  if (Math.abs(curH - h) < 2 && curW === w) return
  const { workArea } = screen.getPrimaryDisplay()
  win.setBounds({ x: workArea.x + workArea.width - w - 16, y: workArea.y + workArea.height - h - 16, width: w, height: h })
}

/** Reposition a window onto the current primary display (displays change while hidden). */
export function placeBottomRight(win: BrowserWindow): void {
  const { workArea } = screen.getPrimaryDisplay()
  const [w, h] = win.getSize() as [number, number]
  win.setPosition(workArea.x + workArea.width - w - 16, workArea.y + workArea.height - h - 16)
}

export function placePalette(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const [w] = win.getSize() as [number, number]
  win.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.18))
}
