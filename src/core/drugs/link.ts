/**
 * Name-field linking. Selecting a suggestion links the medication to a catalog entry; any edit to
 * the name afterwards unlinks it (clearing the RXCUI and the strength suggestions). Free text is
 * always allowed: an unlinked name is a perfectly valid medication.
 */
import type { Medication } from '../types'
import { isBrandName, splitDisplayName } from './rxterms'
import type { DrugMatch } from './types'

export interface DrugLink {
  displayName: string
  name: string
  rxcui: string | null
  source: 'rxterms'
}

export interface NameFieldState {
  text: string
  link: DrugLink | null
}

export function linkFromMatch(m: DrugMatch): DrugLink {
  return { displayName: m.displayName, name: m.name, rxcui: m.rxcui, source: m.source }
}

export function selectSuggestion(_s: NameFieldState, m: DrugMatch): NameFieldState {
  return { text: m.name, link: linkFromMatch(m) }
}

/** Typing in the name field: keeps the link only if the text still equals the linked name. */
export function editName(s: NameFieldState, text: string): NameFieldState {
  if (!s.link) return { text, link: null }
  return text.trim() === s.link.name ? { text, link: s.link } : { text, link: null }
}

export function nameStateFromMedication(m: Pick<Medication, 'name' | 'rxcui' | 'catalogName' | 'catalogSource'> | null): NameFieldState {
  if (!m) return { text: '', link: null }
  return {
    text: m.name,
    link: m.catalogName && m.catalogSource ? { displayName: m.catalogName, name: m.name, rxcui: m.rxcui ?? null, source: m.catalogSource } : null,
  }
}

/** Minimal DrugMatch for a link restored from a saved medication (strengths come from cache/lookup). */
export function matchFromLink(l: DrugLink): DrugMatch {
  const { name, route } = splitDisplayName(l.displayName)
  return { displayName: l.displayName, name: l.name, route, brand: isBrandName(name), rxcui: l.rxcui, source: l.source }
}

/** Suggestions whose name equals an unlinked medication's name (one per route group), for "Link to …?". */
export function findLinkCandidates(name: string, matches: DrugMatch[]): DrugMatch[] {
  const n = name.trim().toLowerCase()
  if (!n) return []
  return matches.filter((m) => m.name.toLowerCase() === n || m.displayName.toLowerCase() === n)
}
