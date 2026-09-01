/**
 * Canonical text normalisation. Both the ingest side (steam/sync.ts, which writes
 * games.name_folded) and the query side (db/queries.ts, which folds user search
 * input) MUST use these exact functions.
 *
 * They were originally implemented separately and silently disagreed on
 * zero-width characters, which made affected titles unsearchable. Keep one
 * implementation here so the two can never drift again.
 */

/**
 * Slicing by UTF-16 code units can cut an astral character (emoji, some CJK) in
 * half, leaving an unpaired high surrogate that encodes to U+FFFD. Drop it.
 */
export function dropLoneSurrogate(s: string): string {
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

/** Format-control and C0/C1 control chars: zero-width joiners, RTL overrides, etc. */
const INVISIBLE_RE = /[\p{Cf}\p{Cc}]/gu;

/**
 * Display name. Strips invisibles so a title containing an RTL override cannot
 * scramble the rest of a Discord embed, and caps length for the DB.
 */
export function sanitizeName(name: string): string {
  const cleaned = name.normalize('NFC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 190 ? dropLoneSurrogate(cleaned.slice(0, 190)) : cleaned;
}

/**
 * Search key. SQLite's LOWER() and NOCASE only fold ASCII, so "Pokémon" would not
 * match "pokemon" and Cyrillic/Greek titles would not fold at all. Do it in JS:
 * NFKC (compatibility forms), strip invisibles, decompose and drop combining
 * marks (accent stripping), then lowercase and collapse whitespace.
 */
export function foldName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
