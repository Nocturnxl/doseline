import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { type DrugMatch, type StrengthChip, type StrengthOption, type StrengthRanking, type UsedStrength, groupStrengths, joinStrength } from '../../../core/drugs'
import { api } from '../lib/store'
import { prefersReducedMotion } from '../lib/drugs'

interface Props {
  drug: DrugMatch
  /** Whether a chip is the current selection. */
  isSelected(o: StrengthOption): boolean
  onPick(o: StrengthOption, chip: StrengthChip): void
  onCustom(): void
}

type Load = { state: 'loading' } | { state: 'ready'; options: StrengthOption[] } | { state: 'failed' }

/**
 * Strength chips for a linked drug. RxTerms strengths show immediately in numeric order; when the
 * openFDA ranking arrives the chips reorder with a short FLIP animation. Ranking failures are silent.
 */
export function StrengthPicker({ drug, isSelected, onPick, onCustom }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [ranking, setRanking] = useState<StrengthRanking | null>(null)
  const [used, setUsed] = useState<UsedStrength[]>([])
  const key = drug.displayName

  useEffect(() => {
    let live = true
    setLoad({ state: 'loading' })
    setRanking(null)
    void api.drugUsedStrengths(key).then((u) => live && setUsed(u))
    void api.drugStrengths(drug).then((r) => {
      if (!live) return
      setLoad(r.ok ? { state: 'ready', options: r.value } : { state: 'failed' })
      if (r.ok && r.value.length) void api.drugRanking(drug).then((rk) => live && rk.ok && setRanking(rk.value))
    })
    return () => {
      live = false
    }
    // Refetch only when the linked drug changes, not on every parent render.
  }, [key])

  const groups = useMemo(() => (load.state === 'ready' ? groupStrengths(load.options, { used, scores: ranking?.scores ?? null }) : []), [load, used, ranking])
  const flipRef = useFlip<HTMLDivElement>([groups])

  if (load.state === 'failed') return null
  const many = groups.length > 1
  const anyCommon = groups.some((g) => g.chips.some((c) => c.common))

  return (
    <div className="strength-picker" ref={flipRef} aria-busy={load.state === 'loading'}>
      {load.state === 'loading' ? (
        <div className="strength-chips" aria-hidden>
          {[64, 56, 72, 60].map((w, i) => (
            <span key={i} className="schip skeleton" style={{ width: w }} />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <div className="strength-group" key={g.key} role="group" aria-label={many ? g.label : 'Suggested strengths'}>
            {many && <div className="strength-group-label">{g.label}</div>}
            <div className="strength-chips">
              {g.chips.map((c) => (
                <button
                  key={c.option.raw}
                  data-flip={c.option.raw}
                  type="button"
                  className="schip"
                  aria-pressed={isSelected(c.option)}
                  title={chipTitle(c)}
                  onClick={() => onPick(c.option, c)}
                >
                  <span className="num">{c.option.parsed ? joinStrength(c.option.value, c.option.unit) : c.option.raw}</span>
                  {c.custom && c.option.formLabel && <span className="schip-sub">{c.option.formLabel}</span>}
                  {c.yours && <span className="schip-tag yours">Yours</span>}
                  {!c.yours && c.common && <span className="schip-tag">Common</span>}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
      <div className="strength-chips">
        <button type="button" className="schip custom" data-flip="__custom" onClick={onCustom}>
          <Plus />
          Custom…
        </button>
      </div>
      {anyCommon && <p className="strength-footnote">“Common” marks the strengths with the most products listed in the FDA NDC directory. It reflects availability, not how often they’re prescribed.</p>}
    </div>
  )
}

function chipTitle(c: StrengthChip): string {
  const o = c.option
  const parts = [c.custom ? `${joinStrength(o.value, o.unit)} ${o.formLabel}`.trim() : o.raw]
  if (o.details.length) parts.push(`Variants: ${o.details.join(', ')}`)
  if (o.score != null && !c.custom) parts.push(`${o.score} listed ${o.score === 1 ? 'product' : 'products'}`)
  return parts.join('\n')
}

/** FLIP: after each change in `deps`, animate [data-flip] children from their previous positions. */
function useFlip<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null)
  const rects = useRef(new Map<string, { left: number; top: number }>())
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    // Positions relative to the picker, so scrolling the drawer doesn't look like movement.
    const origin = root.getBoundingClientRect()
    const els = [...root.querySelectorAll<HTMLElement>('[data-flip]')]
    const next = new Map(
      els.map((el) => {
        const r = el.getBoundingClientRect()
        return [el.dataset.flip!, { left: r.left - origin.left, top: r.top - origin.top }]
      }),
    )
    if (!prefersReducedMotion()) {
      for (const el of els) {
        const prev = rects.current.get(el.dataset.flip!)
        const now = next.get(el.dataset.flip!)!
        if (!prev) continue
        const dx = prev.left - now.left
        const dy = prev.top - now.top
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
      }
    }
    rects.current = next
  }, deps)
  return ref
}
