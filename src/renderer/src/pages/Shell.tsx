import { useEffect, useState } from 'react'
import { ChartColumn, Cloud, CloudOff, FileClock, LoaderCircle, Package, RefreshCw, Settings as SettingsIcon, Sun, TriangleAlert, Zap } from 'lucide-react'
import type { Route } from '../../../shared/api'
import { upNext } from '../../../core/today'
import { inventoryStatus } from '../../../core/inventory'
import { api, useNow, useSnapshot } from '../lib/store'
import { MedGlyph } from '../components/MedIcon'
import { TodayPage } from './Today'
import { MedsPage } from './Meds'
import { HistoryPage } from './History'
import { AdherencePage } from './Adherence'
import { InventoryPage } from './Inventory'
import { SettingsPage } from './Settings'

const NAV: { route: Route; label: string; icon: React.ReactNode }[] = [
  { route: 'today', label: 'Today', icon: <Sun /> },
  { route: 'meds', label: 'Medications', icon: <MedGlyph icon="pill" size={18} /> },
  { route: 'history', label: 'History', icon: <FileClock /> },
  { route: 'adherence', label: 'Adherence', icon: <ChartColumn /> },
  { route: 'inventory', label: 'Inventory', icon: <Package /> },
]

function SyncIndicator({ go }: { go: (r: Route) => void }) {
  const { google, sync } = useSnapshot()
  if (!google.connected) return null
  let icon = <Cloud />
  let text = 'Synced'
  let cls = ''
  if (google.needsReconnect || sync.state === 'reconnect') {
    icon = <TriangleAlert />
    text = 'Reconnect Google'
    cls = 'danger'
  } else if (sync.state === 'syncing') {
    icon = <LoaderCircle className="spin" />
    text = 'Syncing'
  } else if (sync.state === 'offline') {
    icon = <CloudOff />
    text = `Offline · ${sync.pending} queued`
    cls = 'warn'
  } else if (sync.state === 'error') {
    icon = <RefreshCw />
    text = 'Sync retrying'
    cls = 'warn'
  } else if (sync.pending > 0) {
    icon = <LoaderCircle className="spin" />
    text = 'Syncing'
  }
  return (
    <button className={`sync-indicator no-drag ${cls}`} onClick={() => go('settings')} title={sync.lastError ?? (sync.lastSyncAt ? `Last synced ${new Date(sync.lastSyncAt).toLocaleTimeString()}` : 'Google Calendar')}>
      {icon}
      {text}
    </button>
  )
}

export function Shell() {
  const snap = useSnapshot()
  const [route, setRoute] = useState<Route>('today')
  const now = useNow(30_000)

  useEffect(() => api.onNavigate((r) => setRoute(r)), [])
  useEffect(() => {
    // Keep main informed of the system time zone (Chromium tracks OS zone changes).
    const report = () => api.reportZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
    report()
    const t = setInterval(report, 60_000)
    window.addEventListener('focus', report)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', report)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return
      const i = Number(e.key)
      if (i >= 1 && i <= NAV.length) {
        e.preventDefault()
        setRoute(NAV[i - 1]!.route)
      }
      if (e.key === ',') {
        e.preventDefault()
        setRoute('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const attention = upNext(snap.meds, snap.logs, now, snap.zone, snap.settings.graceMinutes).filter((i) => i.status === 'due' || i.status === 'overdue').length
  const lowStock = snap.meds.filter((m) => m.active && inventoryStatus(m, snap.logs, now)?.low).length

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <img src="./icon.png" alt="" />
          Doseline
        </div>
        <div className="spacer" />
        <SyncIndicator go={setRoute} />
      </header>
      <nav className="sidebar" aria-label="Main">
        {NAV.map((n, i) => (
          <button key={n.route} className="nav-item" aria-current={route === n.route ? 'page' : undefined} onClick={() => setRoute(n.route)} title={`${n.label} (Ctrl+${i + 1})`}>
            {n.icon}
            {n.label}
            {n.route === 'today' && attention > 0 ? <span className="count" aria-label={`${attention} due`}>{attention}</span> : null}
            {n.route === 'inventory' && lowStock > 0 ? <span className="count" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }} aria-label={`${lowStock} low`}>{lowStock}</span> : null}
          </button>
        ))}
        <button className="quicklog" onClick={() => api.openPalette()} title="Open quick log (works from anywhere)">
          <Zap />
          <span style={{ flex: 1, textAlign: 'left' }}>Quick log</span>
          <span className="kbd">{snap.settings.hotkey.replace(/\+/g, ' ')}</span>
        </button>
        <button className="nav-item" aria-current={route === 'settings' ? 'page' : undefined} onClick={() => setRoute('settings')} title="Settings (Ctrl+,)">
          <SettingsIcon />
          Settings
          {snap.google.needsReconnect ? <span className="count">!</span> : null}
        </button>
      </nav>
      <main className="content" id="content">
        {route === 'today' && <TodayPage go={setRoute} />}
        {route === 'meds' && <MedsPage />}
        {route === 'history' && <HistoryPage />}
        {route === 'adherence' && <AdherencePage />}
        {route === 'inventory' && <InventoryPage />}
        {route === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
