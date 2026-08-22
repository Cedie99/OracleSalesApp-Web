// Match a free-text municipality/province (as returned by Nominatim reverse
// geocoding) to a CANONICAL PSGC locality — the same names clients.city is
// picked from (lib/data/psgc-localities.ts). This is the "canonicalise" half of
// the Store Locations pin-derived-area feature (STORE_LOCATIONS_CONTRACT.md
// §visibility+autoderive): the officer's pin is reverse-geocoded, and the raw
// municipality string it yields is resolved here to a real PSGC name so the
// field-observed area is comparable to the registered one ("Quezon City" vs
// "Q.C.", "City of Malolos" vs "Malolos").
//
// Why fuzzy, not exact: Nominatim and PSGC disagree on the "City of X" / "X City"
// prefix, PSGC has stray trailing spaces and duplicate names across provinces
// (two "City of San Fernando", six "San Fernando"), and NCR highly-urbanised
// cities have province == their own name in PSGC but "Metro Manila" in Nominatim.
// So: try an exact normalised full-name match first, then a "core" match (the
// name minus city/of/municipality words) with the province as a soft tie-breaker.

import { PSGC_LOCALITIES, type PsgcLocality } from './psgc-localities'

export interface PsgcMatch {
  code: string
  name: string
  province: string
}

/** lowercase, strip diacritics + punctuation, collapse whitespace, trim. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining marks (ñ -> n, etc.)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Words that differ between the two sources for the SAME place. Dropping them
// makes "City of Malolos", "Malolos City" and "Malolos" all compare equal.
const NOISE_WORDS = new Set(['city', 'of', 'municipality', 'town'])

/** normalize() minus the noise words — the comparable core of a place name. */
function coreKey(value: string): string {
  return normalize(value)
    .split(' ')
    .filter(word => word && !NOISE_WORDS.has(word))
    .join(' ')
}

interface IndexedLocality {
  loc: PsgcLocality
  fullKey: string
  core: string
  provinceKey: string
}

// Built once. A core key can map to several localities (San Fernando ×6), so the
// index is keyed by core -> list, plus an exact full-name lookup for the clean
// hits (Quezon City).
let byCore: Map<string, IndexedLocality[]> | null = null
let byFull: Map<string, IndexedLocality[]> | null = null

function buildIndex() {
  byCore = new Map()
  byFull = new Map()
  for (const loc of PSGC_LOCALITIES) {
    const entry: IndexedLocality = {
      loc,
      fullKey: normalize(loc.name),
      core: coreKey(loc.name),
      provinceKey: coreKey(loc.province),
    }
    const pushTo = (map: Map<string, IndexedLocality[]>, key: string) => {
      if (!key) return
      const list = map.get(key)
      if (list) list.push(entry)
      else map.set(key, [entry])
    }
    pushTo(byFull, entry.fullKey)
    pushTo(byCore, entry.core)
  }
}

function toMatch(entry: IndexedLocality): PsgcMatch {
  return {
    code: entry.loc.code,
    // PSGC data carries stray trailing spaces ("City of Malolos ") — trim on the
    // way out so the stored value is clean.
    name: entry.loc.name.trim(),
    province: entry.loc.province.trim(),
  }
}

/**
 * Pick from candidates sharing a name, using the province as a tie-breaker.
 * Returns the single unambiguous winner, or null if it stays ambiguous.
 */
function disambiguate(candidates: IndexedLocality[], province: string | null): PsgcMatch | null {
  if (candidates.length === 1) return toMatch(candidates[0])
  if (candidates.length === 0) return null

  if (province) {
    const provKey = coreKey(province)
    const byProvince = candidates.filter(c => c.provinceKey === provKey)
    if (byProvince.length === 1) return toMatch(byProvince[0])
    // A province that matches several (shouldn't happen for real PSGC data) or
    // none is not a confident answer.
  }
  // Ambiguous municipality with no usable province — refuse rather than guess a
  // wrong locality, which would misfile the store's area.
  return null
}

/**
 * Resolve a raw municipality (and optional province) to a canonical PSGC
 * locality, or null when there is no confident match. `municipality` is the
 * city/town Nominatim returned; `province` is its `state` field.
 */
export function matchPsgcLocality(
  municipality: string | null | undefined,
  province?: string | null,
): PsgcMatch | null {
  if (!municipality) return null
  if (!byFull || !byCore) buildIndex()

  const prov = province?.trim() || null

  // 1. Exact normalised full-name (keeps "city"): the clean, common case.
  const full = byFull!.get(normalize(municipality))
  if (full) {
    const hit = disambiguate(full, prov)
    if (hit) return hit
  }

  // 2. Core match (name minus city/of/municipality) with province tie-break.
  const core = byCore!.get(coreKey(municipality))
  if (core) {
    const hit = disambiguate(core, prov)
    if (hit) return hit
  }

  return null
}
