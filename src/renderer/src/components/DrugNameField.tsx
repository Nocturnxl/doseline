import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, LoaderCircle, WifiOff } from 'lucide-react'
import {
  type DrugMatch,
  DrugSearchController,
  type DrugSearchState,
  IDLE_SEARCH,
  type NameFieldState,
  type OwnedDrugs,
  editName,
  highlightSegments,
  rankDrugMatches,
  selectSuggestion,
} from '../../../core/drugs'
import { browserTimers, searchDrugsViaIpc } from '../lib/drugs'

interface Props {
  id: string
  value: NameFieldState
  onChange(next: NameFieldState, picked?: DrugMatch): void
  /** When false the field is a plain text input (online lookup is off). */
  lookup: boolean
  owned: OwnedDrugs
  placeholder?: string
  autoFocus?: boolean
}

/**
 * Medication name with online suggestions (ARIA 1.2 combobox + listbox). Free text always wins:
 * nothing is auto-selected, so Enter on a typed name never swaps it for a suggestion.
 */
export function DrugNameField({ id, value, onChange, lookup, owned, placeholder, autoFocus }: Props) {
  const listId = useId()
  const [search, setSearch] = useState<DrugSearchState>(IDLE_SEARCH)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const ownedRef = useRef(owned)
  ownedRef.current = owned
  const listRef = useRef<HTMLUListElement>(null)

  const ctl = useMemo(
    () =>
      new DrugSearchController({
        search: searchDrugsViaIpc,
        rank: (r, q) => rankDrugMatches(r, q, ownedRef.current),
        onChange: setSearch,
        timers: browserTimers,
      }),
    [],
  )
  useEffect(() => () => ctl.dispose(), [ctl])
  useEffect(() => {
    if (!lookup) {
      ctl.reset()
      setOpen(false)
    }
  }, [lookup, ctl])

  const results = search.status === 'ready' || search.status === 'loading' ? search.results : []
  const showList = lookup && open && results.length > 0
  useEffect(() => setActive(-1), [search.results])
  useEffect(() => {
    if (active >= 0) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (m: DrugMatch) => {
    onChange(selectSuggestion(value, m), m)
    ctl.reset()
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showList) {
      if (e.key === 'ArrowDown' && lookup && results.length) {
        e.preventDefault()
        setOpen(true)
        setActive(0)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a <= 0 ? results.length - 1 : a - 1))
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
      if (e.key === 'Enter') e.preventDefault()
      pick(results[active]!)
    } else if (e.key === 'Escape') {
      // Close the list, keep the typed text, and don't let the drawer close too.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  const note =
    lookup && search.status === 'error' ? (
      <span className="field-note" role="status">
        <WifiOff />
        {search.error === 'offline' ? 'Suggestions unavailable offline' : 'Suggestions unavailable right now'}
      </span>
    ) : null

  return (
    <>
      <div className="combo">
        <input
          id={id}
          className="input"
          value={value.text}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={autoFocus || undefined}
          {...(lookup
            ? {
                role: 'combobox',
                'aria-expanded': showList,
                'aria-controls': listId,
                'aria-autocomplete': 'list' as const,
                'aria-activedescendant': showList && active >= 0 ? `${listId}-${active}` : undefined,
              }
            : {})}
          onChange={(e) => {
            const text = e.target.value
            onChange(editName(value, text))
            if (lookup) {
              ctl.setQuery(text)
              setOpen(true)
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          onFocus={() => results.length && setOpen(true)}
        />
        {lookup && search.status === 'loading' && <LoaderCircle className="combo-icon spin" aria-hidden />}
        {value.link && search.status !== 'loading' && <Check className="combo-icon linked" aria-label="Linked to RxTerms" />}
        {showList && (
          <ul className="combo-list" role="listbox" id={listId} ref={listRef} aria-label="Suggestions">
            {results.map((m, i) => (
              <li
                key={m.displayName}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className="combo-option"
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(m)}
              >
                <span className="combo-name">
                  {highlightSegments(m.name, search.query).map((s, j) => (s.match ? <b key={j}>{s.text}</b> : <span key={j}>{s.text}</span>))}
                </span>
                {m.brand && <span className="combo-tag">Brand</span>}
                {m.route && <span className="combo-route">{m.route}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {note}
    </>
  )
}
