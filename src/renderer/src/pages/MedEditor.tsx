import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Bell, CalendarRange, CircleAlert, Clock, Link2, Package, Palette, Pause, Play, Plus, Trash, X } from 'lucide-react'
import type { Medication, MedIcon, Schedule, Weekday } from '../../../core/types'
import { MED_ICONS } from '../../../core/types'
import { validateMedication } from '../../../core/validation'
import { WEEKDAY_SHORT } from '../../../core/schedule'
import { isValidClock } from '../../../core/time'
import type { MedicationInput } from '../../../shared/api'
import { api, useSnapshot, useToasts } from '../lib/store'
import { fromLocalInput, minutesLabel, toLocalInput } from '../lib/format'
import { MED_COLORS, MED_ICON_LABEL, MedBadge, MedGlyph } from '../components/MedIcon'
import { ConfirmDialog, Drawer, Field, Segmented, Switch } from '../components/ui'
import { DrugNameField } from '../components/DrugNameField'
import { StrengthPicker } from '../components/StrengthPicker'
import { type DrugLink, type DrugMatch, type StrengthOption, findLinkCandidates, iconForForm, joinStrength, linkFromMatch, matchFromLink, splitStrength, strengthKey } from '../../../core/drugs'
import { searchDrugsViaIpc } from '../lib/drugs'
import { EscalationPicker } from '../components/EscalationPicker'

const FORMS = ['tablet', 'capsule', 'extended-release tablet', 'extended-release capsule', 'liquid', 'suspension', 'drops', 'injection', 'pen injector', 'inhaler', 'spray', 'patch', 'cream', 'powder', 'other']
const STRENGTH_UNITS = ['mg', 'mcg', 'g', 'ml', 'mg/ml', 'mg/5ml', 'mcg/puff', 'units', 'units/ml', 'mg/hr', '%', 'IU', 'mEq']
const INSTRUCTION_HINTS = ['with food', 'on an empty stomach', 'with a full glass of water', 'before bed', 'in the morning', 'do not crush']
const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7]

interface Draft {
  name: string
  /** Catalog entry the name was picked from; cleared by any edit to the name. */
  link: DrugLink | null
  strengthValue: string
  strengthUnit: string
  strengthRxcui: string | null
  form: string
  doseAmount: string
  doseUnit: string
  instructions: string
  notes: string
  color: string
  icon: MedIcon
  type: Schedule['type']
  everyHours: string
  firstDoseAt: string
  times: string[]
  days: Weekday[]
  minIntervalHours: string
  maxPer24h: string
  notifyWhenAvailable: boolean
  customReminders: boolean
  reminderOffsets: number[]
  /** Overdue escalation override: null = default, 0 = off. */
  escalationMinutes: number | null
  startDate: string
  endDate: string
  trackInventory: boolean
  invCount: string
  invPerDose: string
  invThreshold: string
  refillEvent: boolean
  active: boolean
}

function toDraft(m: Medication | null, zone: string, defaults: number[]): Draft {
  const s = m?.schedule
  return {
    name: m?.name ?? '',
    link: m?.catalogName && m.catalogSource ? { displayName: m.catalogName, name: m.name, rxcui: m.rxcui ?? null, source: m.catalogSource } : null,
    strengthValue: splitStrength(m?.strength ?? '').value,
    strengthUnit: splitStrength(m?.strength ?? '').unit,
    strengthRxcui: m?.strengthRxcui ?? null,
    form: m?.form ?? 'tablet',
    doseAmount: String(m?.doseAmount ?? 1),
    doseUnit: m?.doseUnit ?? 'tablet',
    instructions: m?.instructions ?? '',
    notes: m?.notes ?? '',
    color: m?.color ?? MED_COLORS[Math.floor(Math.random() * MED_COLORS.length)]!,
    icon: m?.icon ?? 'pill',
    type: s?.type ?? 'fixed',
    everyHours: s?.type === 'interval' ? String(s.everyHours) : '8',
    firstDoseAt: toLocalInput(s?.type === 'interval' && s.firstDoseAt ? new Date(s.firstDoseAt) : new Date(), zone),
    times: s?.type === 'fixed' ? [...s.times].sort() : ['08:00'],
    days: s?.type === 'fixed' ? [...s.days] : [...ALL_DAYS],
    minIntervalHours: s?.type === 'prn' ? String(s.minIntervalHours) : '4',
    maxPer24h: s?.type === 'prn' && s.maxPer24h ? String(s.maxPer24h) : '',
    notifyWhenAvailable: s?.type === 'prn' ? s.notifyWhenAvailable : false,
    customReminders: !!m?.reminderOffsets?.length,
    reminderOffsets: m?.reminderOffsets?.length ? [...m.reminderOffsets] : [...defaults],
    escalationMinutes: m?.escalationMinutes ?? null,
    startDate: m?.startDate ?? '',
    endDate: m?.endDate ?? '',
    trackInventory: !!m?.inventory,
    invCount: String(m?.inventory?.count ?? 30),
    invPerDose: String(m?.inventory?.unitsPerDose ?? 1),
    invThreshold: String(m?.inventory?.refillThreshold ?? 7),
    refillEvent: m?.inventory?.refillEvent ?? false,
    active: m?.active ?? true,
  }
}

function fromDraft(d: Draft, existing: Medication | null): MedicationInput {
  let schedule: Schedule
  if (d.type === 'interval') {
    const keepFirst = existing?.schedule.type === 'interval' ? existing.schedule.firstDoseAt : undefined
    const first = fromLocalInput(d.firstDoseAt)
    schedule = { type: 'interval', everyHours: Number(d.everyHours), firstDoseAt: Number.isNaN(first.getTime()) ? keepFirst : first.toISOString() }
  } else if (d.type === 'fixed') {
    schedule = { type: 'fixed', times: [...new Set(d.times)].sort(), days: [...d.days].sort() }
  } else {
    schedule = { type: 'prn', minIntervalHours: Number(d.minIntervalHours), maxPer24h: d.maxPer24h ? Number(d.maxPer24h) : null, notifyWhenAvailable: d.notifyWhenAvailable }
  }
  return {
    id: existing?.id,
    name: d.name.trim(),
    strength: joinStrength(d.strengthValue, d.strengthUnit),
    form: d.form.trim() || 'other',
    rxcui: d.link?.rxcui ?? null,
    strengthRxcui: d.link ? d.strengthRxcui : null,
    catalogName: d.link?.displayName ?? null,
    catalogSource: d.link?.source ?? null,
    doseAmount: Number(d.doseAmount),
    doseUnit: d.doseUnit.trim() || d.form,
    instructions: d.instructions.trim(),
    notes: d.notes.trim(),
    color: d.color,
    icon: d.icon,
    schedule,
    active: d.active,
    startDate: d.startDate || null,
    endDate: d.endDate || null,
    reminderOffsets: d.customReminders ? d.reminderOffsets : null,
    escalationMinutes: d.escalationMinutes,
    inventory: d.trackInventory ? { count: Number(d.invCount), unitsPerDose: Number(d.invPerDose), refillThreshold: Number(d.invThreshold), refillEvent: d.refillEvent } : null,
  }
}

export function MedEditor({ med, onClose }: { med?: Medication | null; onClose: () => void }) {
  const snap = useSnapshot()
  const { push } = useToasts()
  const existing = med ?? null
  const [d, setD] = useState<Draft>(() => toDraft(existing, snap.zone, snap.settings.reminderOffsets))
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newTime, setNewTime] = useState('20:00')
  const [newOffset, setNewOffset] = useState('')
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }))
  const lookup = snap.settings.drugLookup
  const iconTouched = useRef(!!existing)
  const strengthInput = useRef<HTMLInputElement>(null)
  const autoDoseUnit = useRef<string | null>(null)
  const owned = useMemo(() => ({ displayNames: snap.meds.flatMap((m) => (m.catalogName ? [m.catalogName] : [])), names: snap.meds.map((m) => m.name) }), [snap.meds])
  const linkedDrug = useMemo(() => (d.link ? matchFromLink(d.link) : null), [d.link])
  const [picked, setPicked] = useState<DrugMatch | null>(null)
  // Reuse the strengths embedded in the search result when the drug was just picked.
  const pickerDrug = picked && d.link && picked.displayName === d.link.displayName ? picked : linkedDrug

  // Editing an unlinked medication: offer to link it when its name matches a catalog entry exactly.
  const [candidates, setCandidates] = useState<DrugMatch[]>([])
  useEffect(() => {
    if (!existing || existing.catalogName || !lookup || existing.name.trim().length < 2) return
    const ac = new AbortController()
    searchDrugsViaIpc(existing.name, ac.signal)
      .then((r) => setCandidates(findLinkCandidates(existing.name, r).slice(0, 4)))
      .catch(() => {})
    return () => ac.abort()
  }, [existing, lookup])

  const applyLink = (m: DrugMatch) => {
    setPicked(m)
    setCandidates([])
    // Keep the user's own spelling of the name; the link records the catalog entry.
    setD((p) => ({ ...p, link: { ...linkFromMatch(m), name: p.name.trim() }, strengthRxcui: null }))
  }

  const pickStrength = (o: StrengthOption) => {
    setD((p) => {
      // Only replace a dose unit that the form (or a previous chip) filled in, never one the user typed.
      const autoUnit = !p.doseUnit.trim() || p.doseUnit === p.form || FORMS.includes(p.doseUnit) || p.doseUnit === autoDoseUnit.current
      if (autoUnit) autoDoseUnit.current = o.doseUnit
      return {
        ...p,
        strengthValue: o.value || o.raw,
        strengthUnit: o.unit,
        form: o.formLabel,
        strengthRxcui: o.rxcui,
        doseUnit: autoUnit ? o.doseUnit : p.doseUnit,
        icon: iconTouched.current ? p.icon : iconForForm(o.form || o.raw),
      }
    })
  }

  const isSelectedStrength = (o: StrengthOption) => {
    if (d.strengthRxcui && o.rxcuis.includes(d.strengthRxcui)) return true
    if (!d.strengthValue.trim()) return false
    return strengthKey(joinStrength(d.strengthValue, d.strengthUnit)) === strengthKey(joinStrength(o.value, o.unit)) && d.form.trim().toLowerCase() === o.formLabel.toLowerCase()
  }

  const save = async () => {
    const input = fromDraft(d, existing)
    const now = new Date().toISOString()
    const errs = validateMedication({ ...input, id: input.id ?? 'new', pauses: [], createdAt: now, updatedAt: now } as Medication)
    if (errs.length) {
      setErrors(errs)
      document.querySelector('.drawer-body')?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setSaving(true)
    const r = await api.saveMedication(input)
    setSaving(false)
    if (!r.ok) {
      setErrors([r.error])
      return
    }
    push({ kind: 'success', message: existing ? `Saved ${r.value.name}` : `Added ${r.value.name}` })
    onClose()
  }

  const toggleActive = async () => {
    if (!existing) return set('active', !d.active)
    const r = await api.setActive(existing.id, !existing.active)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else {
      push({ kind: 'info', message: existing.active ? `Paused ${existing.name}. No reminders until you resume.` : `Resumed ${existing.name}` })
      onClose()
    }
  }

  const remove = async () => {
    if (!existing) return
    const r = await api.deleteMedication(existing.id)
    if (!r.ok) push({ kind: 'error', message: r.error })
    else {
      push({ kind: 'info', message: `Deleted ${existing.name}` })
      onClose()
    }
  }

  return (
    <Drawer
      title={existing ? `Edit ${existing.name}` : 'New medication'}
      headExtra={<MedBadge icon={d.icon} color={d.color} size={34} />}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(true)} style={{ color: 'var(--danger)' }}>
                <Trash />
                Delete
              </button>
              <button className="btn btn-ghost" onClick={() => void toggleActive()}>
                {existing.active ? <Pause /> : <Play />}
                {existing.active ? 'Pause' : 'Resume'}
              </button>
            </>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {existing ? 'Save changes' : 'Add medication'}
          </button>
        </>
      }
    >
      {errors.length > 0 && (
        <div className="callout danger" style={{ marginTop: 14 }} role="alert">
          <CircleAlert />
          <div>
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        </div>
      )}

      <section className="form-section">
        <Field
          label="Name"
          htmlFor="m-name"
          hint={d.link ? <span className="linked-hint">Matched to <b>{d.link.displayName}</b> in RxTerms. Editing the name unlinks it.</span> : undefined}
        >
          <DrugNameField
            id="m-name"
            value={{ text: d.name, link: d.link }}
            lookup={lookup}
            owned={owned}
            placeholder="e.g. Lisinopril"
            autoFocus
            onChange={(next, m) => {
              if (m) setPicked(m)
              setD((p) => ({ ...p, name: next.text, link: next.link, strengthRxcui: next.link ? p.strengthRxcui : null }))
            }}
          />
        </Field>
        {lookup && candidates.length > 0 && !d.link && (
          <div className="callout info link-offer">
            <Link2 />
            <div className="stack" style={{ gap: 8 }}>
              <div>Link {existing?.name} to RxTerms to get strength suggestions?</div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {candidates.map((c) => (
                  <button key={c.displayName} type="button" className="btn btn-sm" onClick={() => applyLink(c)}>
                    {c.displayName}
                  </button>
                ))}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCandidates([])}>
                  Not now
                </button>
              </div>
            </div>
          </div>
        )}
        {lookup && pickerDrug && (
          <Field label="Suggested strengths">
            <StrengthPicker
              drug={pickerDrug}
              isSelected={isSelectedStrength}
              onPick={pickStrength}
              onCustom={() => {
                setD((p) => ({ ...p, strengthRxcui: null }))
                strengthInput.current?.focus()
                strengthInput.current?.select()
              }}
            />
          </Field>
        )}
        <div className="grid-strength">
          <Field label="Strength" htmlFor="m-strength">
            <input
              id="m-strength"
              ref={strengthInput}
              className="input num"
              value={d.strengthValue}
              onChange={(e) => setD((p) => ({ ...p, strengthValue: e.target.value, strengthRxcui: null }))}
              placeholder="e.g. 10"
              autoComplete="off"
            />
          </Field>
          <Field label="Unit" htmlFor="m-sunit">
            <input id="m-sunit" className="input" list="strength-units" value={d.strengthUnit} onChange={(e) => setD((p) => ({ ...p, strengthUnit: e.target.value, strengthRxcui: null }))} placeholder="mg" autoComplete="off" />
            <datalist id="strength-units">
              {STRENGTH_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <Field label="Form" htmlFor="m-form">
            <input
              id="m-form"
              className="input"
              list="form-options"
              value={d.form}
              autoComplete="off"
              onChange={(e) => {
                const f = e.target.value
                setD((p) => ({ ...p, form: f, strengthRxcui: null, doseUnit: p.doseUnit === p.form || !p.doseUnit ? f : p.doseUnit }))
              }}
              placeholder="tablet"
            />
            <datalist id="form-options">
              {FORMS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Dose amount" htmlFor="m-amt">
            <input id="m-amt" className="input num" type="number" min="0" step="0.25" value={d.doseAmount} onChange={(e) => set('doseAmount', e.target.value)} />
          </Field>
          <Field label="Dose unit" htmlFor="m-unit">
            <input id="m-unit" className="input" value={d.doseUnit} onChange={(e) => set('doseUnit', e.target.value)} placeholder="tablet, ml, puff…" />
          </Field>
        </div>
        <Field label="Instructions" htmlFor="m-instr">
          <input id="m-instr" className="input" list="instr-hints" value={d.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder="with food" />
          <datalist id="instr-hints">
            {INSTRUCTION_HINTS.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </Field>
        <Field label="Notes" htmlFor="m-notes" hint="Shown in the calendar event and the doctor report.">
          <textarea id="m-notes" className="textarea" value={d.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Optional" />
        </Field>
      </section>

      <section className="form-section">
        <h3>
          <Palette size={16} /> Appearance
        </h3>
        <div className="swatches" role="group" aria-label="Color">
          {MED_COLORS.map((c) => (
            <button key={c} type="button" className="swatch" style={{ '--sw': c } as CSSProperties} aria-pressed={d.color.toLowerCase() === c} aria-label={`Color ${c}`} onClick={() => set('color', c)} />
          ))}
          <label className="swatch" style={{ '--sw': `conic-gradient(#f26d8f, #f2b84b, #5cc98a, #4fb8e6, #9b8cff, #f26d8f)`, position: 'relative', overflow: 'hidden' } as CSSProperties} title="Custom color">
            <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} style={{ opacity: 0, position: 'absolute', inset: 0, cursor: 'pointer' }} aria-label="Custom color" />
          </label>
        </div>
        <div className="icon-picker" role="group" aria-label="Icon" style={{ '--med': d.color } as CSSProperties}>
          {MED_ICONS.map((ic) => (
            <button key={ic} type="button" aria-pressed={d.icon === ic} aria-label={MED_ICON_LABEL[ic]} title={MED_ICON_LABEL[ic]} onClick={() => {
                iconTouched.current = true
                set('icon', ic)
              }}>
              <MedGlyph icon={ic} size={18} />
            </button>
          ))}
        </div>
      </section>

      <section className="form-section">
        <h3>
          <Clock size={16} /> Schedule
        </h3>
        <Segmented
          block
          label="Schedule type"
          value={d.type}
          onChange={(v) => set('type', v)}
          options={[
            { value: 'fixed', label: 'At set times' },
            { value: 'interval', label: 'Every N hours' },
            { value: 'prn', label: 'As needed' },
          ]}
        />
        {d.type === 'fixed' && (
          <>
            <Field label="Times" hint="Wall-clock times in your current time zone.">
              <div className="chips-input">
                {d.times.map((t) => (
                  <span key={t} className="chip num">
                    {t}
                    <button aria-label={`Remove ${t}`} onClick={() => set('times', d.times.filter((x) => x !== t))}>
                      <X />
                    </button>
                  </span>
                ))}
                <div className="row" style={{ gap: 6 }}>
                  <input type="time" className="input num" style={{ width: 120, height: 30 }} value={newTime} onChange={(e) => setNewTime(e.target.value)} aria-label="New time" />
                  <button
                    className="btn btn-sm"
                    disabled={!isValidClock(newTime) || d.times.includes(newTime)}
                    onClick={() => set('times', [...d.times, newTime].sort())}
                  >
                    <Plus />
                    Add time
                  </button>
                </div>
              </div>
            </Field>
            <Field label={<span className="row" style={{ justifyContent: 'space-between' }}>Days <span className="row" style={{ gap: 4 }}>
              <button className="link small" type="button" onClick={() => set('days', [...ALL_DAYS])}>Every day</button>
              <span className="subtle">·</span>
              <button className="link small" type="button" onClick={() => set('days', [1, 2, 3, 4, 5])}>Weekdays</button>
            </span></span>}>
              <div className="day-toggles" role="group" aria-label="Days of the week">
                {ALL_DAYS.map((day) => (
                  <button key={day} type="button" aria-pressed={d.days.includes(day)} onClick={() => set('days', d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day])}>
                    {WEEKDAY_SHORT[day - 1]}
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}
        {d.type === 'interval' && (
          <div className="grid-2">
            <Field label="Every" htmlFor="m-every" hint="Counted from the last dose you log.">
              <div className="input-group">
                <input id="m-every" className="input num" type="number" min="0.25" step="0.5" value={d.everyHours} onChange={(e) => set('everyHours', e.target.value)} />
                <span className="addon">hours</span>
              </div>
            </Field>
            <Field label={existing ? 'First dose (if none logged)' : 'First dose'} htmlFor="m-first">
              <input id="m-first" className="input num" type="datetime-local" value={d.firstDoseAt} onChange={(e) => set('firstDoseAt', e.target.value)} />
            </Field>
          </div>
        )}
        {d.type === 'prn' && (
          <>
            <div className="grid-2">
              <Field label="Minimum time between doses" htmlFor="m-min">
                <div className="input-group">
                  <input id="m-min" className="input num" type="number" min="0" step="0.5" value={d.minIntervalHours} onChange={(e) => set('minIntervalHours', e.target.value)} />
                  <span className="addon">hours</span>
                </div>
              </Field>
              <Field label="Max doses per 24 h" htmlFor="m-max" hint="Optional">
                <input id="m-max" className="input num" type="number" min="1" step="1" value={d.maxPer24h} onChange={(e) => set('maxPer24h', e.target.value)} placeholder="No limit" />
              </Field>
            </div>
            <div className="toggle-row">
              <div className="text">
                <div className="t">Remind me when it's available again</div>
                <div className="d">Adds an alarm and calendar event for when the next dose may be taken.</div>
              </div>
              <Switch checked={d.notifyWhenAvailable} onChange={(v) => set('notifyWhenAvailable', v)} label="Remind when available" />
            </div>
          </>
        )}
      </section>

      <section className="form-section">
        <h3>
          <Bell size={16} /> Reminders
        </h3>
        <div className="toggle-row">
          <div className="text">
            <div className="t">Custom reminder times</div>
            <div className="d">{d.customReminders ? 'Overrides the defaults from Settings for this medication.' : `Using defaults: ${snap.settings.reminderOffsets.map(minutesLabel).join(', ') || 'none'} before, plus at the due time.`}</div>
          </div>
          <Switch checked={d.customReminders} onChange={(v) => set('customReminders', v)} label="Custom reminder times" />
        </div>
        {d.customReminders && (
          <div className="chips-input">
            {d.reminderOffsets.map((o) => (
              <span key={o} className="chip num">
                {minutesLabel(o)} before
                <button aria-label={`Remove ${o} minutes`} onClick={() => set('reminderOffsets', d.reminderOffsets.filter((x) => x !== o))}>
                  <X />
                </button>
              </span>
            ))}
            <div className="input-group" style={{ width: 150 }}>
              <input
                className="input num"
                style={{ height: 30 }}
                type="number"
                min="1"
                placeholder="Minutes"
                value={newOffset}
                onChange={(e) => setNewOffset(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && Number(newOffset) > 0) {
                    set('reminderOffsets', [...new Set([...d.reminderOffsets, Math.round(Number(newOffset))])].sort((a, b) => b - a))
                    setNewOffset('')
                  }
                }}
                aria-label="Add reminder minutes before"
              />
            </div>
            <button
              className="btn btn-sm"
              disabled={!(Number(newOffset) > 0)}
              onClick={() => {
                set('reminderOffsets', [...new Set([...d.reminderOffsets, Math.round(Number(newOffset))])].sort((a, b) => b - a))
                setNewOffset('')
              }}
            >
              <Plus />
              Add
            </button>
          </div>
        )}
        <Field
          label="Overdue alert"
          hint={
            d.type === 'prn'
              ? 'As-needed medications never escalate.'
              : d.escalationMinutes === 0
                ? 'No overdue alarm for this medication.'
                : `An urgent alarm starts this long after a missed dose and repeats every ${minutesLabel(snap.settings.escalation.repeatMinutes)} until you act.`
          }
        >
          {d.type !== 'prn' && (
            <EscalationPicker withDefault label="Overdue alert" value={d.escalationMinutes} defaultMinutes={snap.settings.escalation.thresholdMinutes} onChange={(v) => set('escalationMinutes', v)} />
          )}
        </Field>
      </section>

      <section className="form-section">
        <h3>
          <CalendarRange size={16} /> Course dates
        </h3>
        <div className="grid-2">
          <Field label="Start date" htmlFor="m-start" hint="Optional">
            <input id="m-start" className="input num" type="date" value={d.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label="End date" htmlFor="m-end" hint="Optional, e.g. for antibiotics">
            <input id="m-end" className="input num" type="date" value={d.endDate} onChange={(e) => set('endDate', e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="form-section">
        <div className="toggle-row">
          <h3 className="row" style={{ gap: 8 }}>
            <Package size={16} /> Track inventory
          </h3>
          <Switch checked={d.trackInventory} onChange={(v) => set('trackInventory', v)} label="Track inventory" />
        </div>
        {d.trackInventory && (
          <>
            <div className="grid-3">
              <Field label="On hand" htmlFor="m-count">
                <input id="m-count" className="input num" type="number" min="0" value={d.invCount} onChange={(e) => set('invCount', e.target.value)} />
              </Field>
              <Field label="Units per dose" htmlFor="m-per">
                <input id="m-per" className="input num" type="number" min="0.25" step="0.25" value={d.invPerDose} onChange={(e) => set('invPerDose', e.target.value)} />
              </Field>
              <Field label="Refill alert at" htmlFor="m-thr">
                <input id="m-thr" className="input num" type="number" min="0" value={d.invThreshold} onChange={(e) => set('invThreshold', e.target.value)} />
              </Field>
            </div>
            <div className="toggle-row">
              <div className="text">
                <div className="t">Add a "Refill" calendar event</div>
                <div className="d">When supply drops to the alert level, add an all-day reminder to Google Calendar.</div>
              </div>
              <Switch checked={d.refillEvent} onChange={(v) => set('refillEvent', v)} label="Refill calendar event" />
            </div>
          </>
        )}
      </section>

      {confirmDelete && existing && (
        <ConfirmDialog
          title={`Delete ${existing.name}?`}
          body="This permanently removes the medication and its entire dose history, and deletes its calendar event. Pause it instead if you might take it again."
          confirmLabel="Delete medication"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void remove()
          }}
        />
      )}
    </Drawer>
  )
}
