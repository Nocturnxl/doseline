import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/windows.css'
import { SnapshotProvider, ToastProvider, useSnapshot } from './lib/store'
import { ToastViewport } from './components/ui'
import { DoseActionsProvider } from './components/DoseActions'
import { Shell } from './pages/Shell'
import { Onboarding } from './pages/Onboarding'
import { AlarmApp } from './windows/AlarmApp'
import { PaletteApp } from './windows/PaletteApp'
import { ReportApp } from './windows/ReportApp'

function MainApp() {
  const snap = useSnapshot()
  return (
    <DoseActionsProvider>
      {snap.settings.onboarded ? <Shell /> : <Onboarding />}
      <ToastViewport />
    </DoseActionsProvider>
  )
}

const route = window.location.hash.replace(/^#/, '').split('?')[0] || '/'
const root = createRoot(document.getElementById('root')!)

if (route === '/alarm') {
  document.documentElement.classList.add('alarm-root')
  root.render(
    <StrictMode>
      <AlarmApp />
    </StrictMode>,
  )
} else if (route === '/palette') {
  document.documentElement.classList.add('palette-root')
  root.render(
    <StrictMode>
      <SnapshotProvider>
        <PaletteApp />
      </SnapshotProvider>
    </StrictMode>,
  )
} else if (route === '/report') {
  document.documentElement.classList.add('report-root')
  root.render(
    <StrictMode>
      <SnapshotProvider>
        <ReportApp />
      </SnapshotProvider>
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <SnapshotProvider>
        <ToastProvider>
          <MainApp />
        </ToastProvider>
      </SnapshotProvider>
    </StrictMode>,
  )
}
