import { app, powerMonitor, session } from 'electron'
import { APP_ID, is } from './env'
import { AppController } from './controller'
import { registerIpc } from './ipc'
import iconIco from '../../resources/icon.ico?asset'
import iconPng from '../../resources/icon.png?asset'
import trayIco from '../../resources/tray.ico?asset'

// Separate profile for testing/demo data (also gives that profile its own single-instance lock).
if (process.env['DOSELINE_USER_DATA']) app.setPath('userData', process.env['DOSELINE_USER_DATA'])

// Toasts show the app name and icon only when the AUMID matches the installer's shortcut.
app.setAppUserModelId(APP_ID)

/** Native consumers (toasts, tray) need real files, not paths inside app.asar. */
const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let ctl: AppController | null = null
  const startHidden = process.argv.includes('--hidden')

  app.on('second-instance', () => ctl?.showMain())

  app.whenReady().then(async () => {
    // Defense in depth: no permission prompts (camera, geolocation, notifications from web content...).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    // Block every remote request from renderers; the UI is fully bundled. Requests made by the
    // main process itself (Google APIs via net.fetch) have no webContents and are allowed.
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      if (details.webContentsId === undefined) return cb({})
      const u = details.url
      const allowed = u.startsWith('file:') || u.startsWith('devtools:') || u.startsWith('data:') || (is.dev && /^(https?|wss?):\/\/(localhost|127\.0\.0\.1)/.test(u))
      cb({ cancel: !allowed })
    })

    ctl = new AppController({ icon: unpacked(iconIco), iconPng: unpacked(iconPng), trayIcon: unpacked(trayIco) })
    registerIpc(ctl)
    await ctl.start(startHidden)

    powerMonitor.on('resume', () => void ctl?.onSystemChange('resume'))
    powerMonitor.on('unlock-screen', () => void ctl?.onSystemChange('unlock'))
  }).catch((e) => {
    console.error('Fatal startup error', e)
    app.exit(1)
  })

  // Closing windows keeps the app alive in the tray.
  app.on('window-all-closed', () => {
    /* stay resident */
  })

  app.on('before-quit', () => {
    if (ctl) ctl.quitting = true
  })

  app.on('will-quit', () => {
    void ctl?.shutdown()
  })

  process.on('uncaughtException', (e) => {
    ctl?.reportError('uncaught exception', e)
  })
  process.on('unhandledRejection', (e) => {
    ctl?.reportError('unhandled rejection', e)
  })
}
