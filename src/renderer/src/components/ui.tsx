import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useToasts } from '../lib/store'

// ------------------------------------------------------------------ Ring

export function Ring({ size, stroke = 6, progress, color, children, label }: { size: number; stroke?: number; progress: number; color: string; children?: ReactNode; label?: string }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.min(1, Math.max(0, progress))
  return (
    <div className="ring" style={{ width: size, height: size, '--med': color } as CSSProperties} role={label ? 'img' : undefined} aria-label={label}>
      <svg className="ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle className="ring-value" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p)} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ Controls

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />
}

export function Segmented<T extends string>({ value, options, onChange, block, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; block?: boolean; label: string }) {
  return (
    <div className={`segmented${block ? ' block' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

// ------------------------------------------------------------------ Overlays

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
}

/** Keep Tab focus inside a dialog and restore focus on close. */
function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    if (!el) return
    const focusables = () => [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'))
    const auto = el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0]
    auto?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const f = focusables()
      if (!f.length) return
      const first = f[0]!
      const last = f[f.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [ref])
}

export function Modal({ title, icon, children, footer, onClose, width }: { title: ReactNode; icon?: ReactNode; children?: ReactNode; footer?: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useFocusTrap(ref)
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref} style={width ? { width: `min(${width}px, calc(100vw - 48px))` } : undefined}>
        <div className="modal-head">
          {icon}
          <h2 style={{ flex: 1, paddingTop: icon ? 6 : 0 }}>{title}</h2>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {children ? <div className="modal-body">{children}</div> : null}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ title, children, footer, onClose, headExtra }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; headExtra?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useFocusTrap(ref)
  return createPortal(
    <div className="scrim drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" ref={ref}>
        <div className="drawer-head">
          {headExtra}
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  separatorBefore?: boolean
}

/** Button that opens a small popover menu, positioned to stay on screen. */
export function MenuButton({ items, children, className = 'btn btn-ghost btn-icon btn-sm', label, align = 'end' }: { items: MenuItem[]; children: ReactNode; className?: string; label: string; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return
    const b = btn.current.getBoundingClientRect()
    const m = menu.current.getBoundingClientRect()
    let top = b.bottom + 6
    if (top + m.height > window.innerHeight - 8) top = b.top - m.height - 6
    let left = align === 'end' ? b.right - m.width : b.left
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8))
    setPos({ top, left })
    menu.current.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btn.current?.focus()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const bs = [...(menu.current?.querySelectorAll('button') ?? [])]
        const i = bs.indexOf(document.activeElement as HTMLButtonElement)
        bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <>
      <button ref={btn} className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      {open &&
        createPortal(
          <div className="menu" role="menu" ref={menu} style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>
            {items.map((it, i) => (
              <div key={i}>
                {it.separatorBefore ? <hr /> : null}
                <button
                  role="menuitem"
                  className={it.danger ? 'danger' : undefined}
                  onClick={() => {
                    setOpen(false)
                    it.onSelect()
                  }}
                >
                  {it.icon}
                  {it.label}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel, icon }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; icon?: ReactNode }) {
  return (
    <Modal
      title={title}
      icon={icon}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} data-autofocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="muted">{body}</div>
    </Modal>
  )
}

// ------------------------------------------------------------------ Toasts

export function ToastViewport() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <CircleAlert className="toast-icon" /> : t.kind === 'success' ? <CircleCheck className="toast-icon" /> : <Info className="toast-icon" />}
          <span className="toast-msg">{t.message}</span>
          {t.action ? (
            <button
              className="btn btn-sm"
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X />
          </button>
          {t.action ? <span className="toast-progress" style={{ width: '100%', animationDuration: `${t.duration}ms` }} /> : null}
        </div>
      ))}
    </div>
  )
}
