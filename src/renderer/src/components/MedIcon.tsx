import type { CSSProperties } from 'react'
import { Bandage, Droplet, HeartPulse, Leaf, Pill, PillBottle, Syringe, Tablets, Wind } from 'lucide-react'
import type { MedIcon as MedIconName } from '../../../core/types'

/** Diagonal two-tone capsule, the app's signature glyph. */
function Capsule(props: { size?: number; strokeWidth?: number }) {
  const s = props.size ?? 24
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={props.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <g transform="rotate(-45 12 12)">
        <path d="M7 8h5v8H7a4 4 0 0 1 0-8Z" fill="currentColor" fillOpacity="0.35" stroke="none" />
        <rect x="3" y="8" width="18" height="8" rx="4" />
        <path d="M12 8v8" />
      </g>
    </svg>
  )
}

export const MED_ICON_LABEL: Record<MedIconName, string> = {
  pill: 'Capsule',
  capsule: 'Pill',
  tablet: 'Tablets',
  drop: 'Drops',
  syringe: 'Injection',
  inhaler: 'Inhaler',
  patch: 'Patch',
  bottle: 'Bottle',
  heart: 'Heart',
  leaf: 'Supplement',
}

export function MedGlyph({ icon, size = 20 }: { icon: MedIconName; size?: number }) {
  const p = { size, strokeWidth: 2 }
  switch (icon) {
    case 'pill':
      return <Capsule {...p} />
    case 'capsule':
      return <Pill {...p} />
    case 'tablet':
      return <Tablets {...p} />
    case 'drop':
      return <Droplet {...p} />
    case 'syringe':
      return <Syringe {...p} />
    case 'inhaler':
      return <Wind {...p} />
    case 'patch':
      return <Bandage {...p} />
    case 'bottle':
      return <PillBottle {...p} />
    case 'heart':
      return <HeartPulse {...p} />
    case 'leaf':
      return <Leaf {...p} />
  }
}

export function MedBadge({ icon, color, size = 36 }: { icon: MedIconName; color: string; size?: number }) {
  return (
    <span className="med-badge" style={{ '--med': color, '--size': `${size}px` } as CSSProperties} aria-hidden>
      <MedGlyph icon={icon} size={Math.round(size * 0.55)} />
    </span>
  )
}

export function MedChip({ name, color, strength }: { name: string; color: string; strength?: string }) {
  return (
    <span className="med-chip" style={{ '--med': color } as CSSProperties}>
      <span className="dot" />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 560 }}>{name}</span>
        {strength ? <span className="muted"> {strength}</span> : null}
      </span>
    </span>
  )
}

export const MED_COLORS = ['#7aa2ff', '#4fb8e6', '#3cc5b0', '#5cc98a', '#f2b84b', '#f28a4b', '#f2667f', '#d17ff0', '#9b8cff', '#94a0b8']
