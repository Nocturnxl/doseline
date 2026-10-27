import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppSnapshot, ToastKind } from '../../../shared/api'

export const api = window.doseline

const SnapshotCtx = createContext<AppSnapshot | null>(null)

export function SnapshotProvider({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void api.getSnapshot().then((s) => alive && setSnap(s))
    const off = api.onSnapshot((s) => setSnap(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  useTheme(snap)
  if (!snap) return <>{fallback ?? null}</>
  return <SnapshotCtx.Provider value={snap}>{children}</SnapshotCtx.Provider>
}

export function useSnapshot(): AppSnapshot {
  const s = useContext(SnapshotCtx)
  if (!s) throw new Error('Snapshot not loaded')
  return s
}

/** Resolve and apply the theme to <html>, following the OS when set to "system". */
export function useTheme(snap: Pick<AppSnapshot, 'settings' | 'platform'> | null, overrideTheme?: 'dark' | 'light' | 'system') {
  const pref = overrideTheme ?? snap?.settings.theme ?? 'system'
  const mica = snap?.platform.mica ?? false
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref
      document.documentElement.dataset.theme = theme
      document.documentElement.dataset.mica = String(mica)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref, mica])
}

/** Current time, re-rendering every `ms`. Aligns to the next whole second for smooth countdowns. */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(new Date())
      t = setTimeout(tick, ms - (Date.now() % Math.min(ms, 1000)))
    }
    t = setTimeout(tick, ms - (Date.now() % Math.min(ms, 1000)))
    return () => clearTimeout(t)
  }, [ms])
  return now
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: { label: string; run: () => void }
  duration: number
}

interface ToastApi {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number
  dismiss: (id: number) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => {
      const id = ++seq.current
      const duration = t.duration ?? (t.kind === 'error' ? 7000 : 4000)
      setToasts((ts) => [...ts.slice(-3), { ...t, id, duration }])
      setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )
  useEffect(() => api.onToast((t) => push({ kind: t.kind, message: t.message })), [push])
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss])
  return <ToastCtx.Provider value={value}>{children}</ToastCtx.Provider>
}

export function useToasts(): ToastApi {
  const t = useContext(ToastCtx)
  if (!t) throw new Error('ToastProvider missing')
  return t
}
