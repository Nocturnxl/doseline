import { useEffect, useState } from 'react'
import { ESCALATION_MAX_THRESHOLD, ESCALATION_MIN_THRESHOLD, ESCALATION_PRESETS } from '../../../core/escalation'
import { minutesLabel } from '../lib/format'
import { Segmented } from './ui'

type Choice = 'default' | 'off' | 'custom' | `${number}`

/**
 * Escalation threshold: presets (30 min / 1 h / 2 h) plus Custom (5 min to 6 h).
 * In the medication editor it also offers "Use default" (null) and "Off" (0).
 */
export function EscalationPicker({
  value,
  onChange,
  withDefault = false,
  defaultMinutes,
  label,
}: {
  /** Minutes; null = use default, 0 = off. */
  value: number | null
  onChange: (v: number | null) => void
  withDefault?: boolean
  defaultMinutes?: number
  label: string
}) {
  const fromValue = (v: number | null): Choice => (v == null ? 'default' : v === 0 ? 'off' : ESCALATION_PRESETS.includes(v) ? (`${v}` as Choice) : 'custom')
  const [choice, setChoice] = useState<Choice>(fromValue(value))
  const [custom, setCustom] = useState(String(value && !ESCALATION_PRESETS.includes(value) ? value : 45))
  // Follow outside changes. Choosing "Custom" with an invalid number leaves `value` unchanged,
  // so the picker stays on Custom while the user fixes it.
  useEffect(() => setChoice(fromValue(value)), [value])

  const customNum = Number(custom)
  const customValid = Number.isInteger(customNum) && customNum >= ESCALATION_MIN_THRESHOLD && customNum <= ESCALATION_MAX_THRESHOLD
  const options = [
    ...(withDefault ? [{ value: 'default' as Choice, label: defaultMinutes ? `Default (${minutesLabel(defaultMinutes)})` : 'Default' }] : []),
    ...ESCALATION_PRESETS.map((m) => ({ value: `${m}` as Choice, label: minutesLabel(m) })),
    { value: 'custom' as Choice, label: 'Custom' },
    ...(withDefault ? [{ value: 'off' as Choice, label: 'Off' }] : []),
  ]
  const commitCustom = () => {
    if (customValid) onChange(customNum)
  }
  return (
    <div className="stack" style={{ gap: 8, alignItems: 'stretch' }}>
      <Segmented<Choice>
        block={withDefault}
        label={label}
        value={choice}
        onChange={(c) => {
          setChoice(c)
          if (c === 'default') onChange(null)
          else if (c === 'off') onChange(0)
          else if (c === 'custom') commitCustom()
          else onChange(Number(c))
        }}
        options={options}
      />
      {choice === 'custom' && (
        <div className="row" style={{ gap: 8 }}>
          <div className="input-group" style={{ width: 150 }}>
            <input
              className={`input num${customValid ? '' : ' invalid'}`}
              type="number"
              min={ESCALATION_MIN_THRESHOLD}
              max={ESCALATION_MAX_THRESHOLD}
              step={5}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={commitCustom}
              onKeyDown={(e) => e.key === 'Enter' && commitCustom()}
              aria-label={`${label}, custom minutes`}
            />
            <span className="addon">min</span>
          </div>
          <span className={`small ${customValid ? 'subtle' : ''}`} style={customValid ? undefined : { color: 'var(--danger)' }}>
            {customValid ? minutesLabel(customNum) + ' past due' : '5 to 360 minutes'}
          </span>
        </div>
      )}
    </div>
  )
}
