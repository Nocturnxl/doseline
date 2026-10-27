/** Small, theme-aware illustrations for empty states. */
export function EmptyArt({ variant = 'meds' }: { variant?: 'meds' | 'history' | 'chart' | 'box' }) {
  return (
    <svg className="empty-art" width="160" height="104" viewBox="0 0 160 104" fill="none" aria-hidden>
      <defs>
        <linearGradient id="ea-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.6" />
        </linearGradient>
      </defs>
      <rect x="8" y="84" width="144" height="4" rx="2" fill="var(--track)" />
      <circle cx="30" cy="86" r="5" fill="var(--surface-1)" stroke="var(--accent)" strokeWidth="2.5" />
      <circle cx="80" cy="86" r="5" fill="var(--surface-1)" stroke="var(--text-3)" strokeWidth="2.5" strokeDasharray="3 3" />
      <circle cx="130" cy="86" r="5" fill="var(--surface-1)" stroke="var(--text-3)" strokeWidth="2.5" strokeDasharray="3 3" />
      {variant === 'meds' && (
        <g transform="translate(80 40) rotate(-35)">
          <rect x="-42" y="-16" width="84" height="32" rx="16" fill="var(--surface-2)" stroke="var(--border-strong)" />
          <path d="M-26 -16 H0 V16 H-26 a16 16 0 0 1 0 -32 Z" fill="url(#ea-g)" />
          <path d="M-28 -8 H-12" stroke="#fff" strokeOpacity="0.5" strokeWidth="3" strokeLinecap="round" />
        </g>
      )}
      {variant === 'history' && (
        <g>
          <rect x="44" y="10" width="72" height="62" rx="10" fill="var(--surface-2)" stroke="var(--border-strong)" />
          <rect x="54" y="24" width="30" height="5" rx="2.5" fill="url(#ea-g)" />
          <rect x="54" y="36" width="52" height="5" rx="2.5" fill="var(--track)" />
          <rect x="54" y="48" width="42" height="5" rx="2.5" fill="var(--track)" />
        </g>
      )}
      {variant === 'chart' && (
        <g>
          <rect x="46" y="44" width="14" height="30" rx="4" fill="var(--track)" />
          <rect x="66" y="30" width="14" height="44" rx="4" fill="url(#ea-g)" opacity="0.7" />
          <rect x="86" y="18" width="14" height="56" rx="4" fill="url(#ea-g)" />
          <rect x="106" y="36" width="14" height="38" rx="4" fill="var(--track)" />
        </g>
      )}
      {variant === 'box' && (
        <g>
          <path d="M50 30 L80 16 L110 30 L110 66 L80 78 L50 66 Z" fill="var(--surface-2)" stroke="var(--border-strong)" />
          <path d="M50 30 L80 44 L110 30" stroke="var(--border-strong)" />
          <path d="M80 44 V78" stroke="var(--border-strong)" />
          <path d="M64 23 L94 37" stroke="url(#ea-g)" strokeWidth="5" strokeLinecap="round" />
        </g>
      )}
    </svg>
  )
}
