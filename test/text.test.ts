import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/db/index.js';
import { dropLoneSurrogate, foldName, sanitizeName } from '../src/text.js';
import { foldForSearch } from '../src/db/queries.js';

/**
 * The ingest side writes games.name_folded and the query side folds user search
 * input; if they disagree, affected titles become silently unsearchable (they
 * once did, on zero-width characters).
 *
 * Asserting foldFromSync === foldForSearch is now tautological -- both are
 * re-exports of the same function, which is exactly the structural fix. So the
 * real guard is a round trip through SQLite: fold a name on the way in, fold a
 * user's query on the way out, and require that the query finds the row.
 */
/**
 * The TYPED side must itself require folding, otherwise a drifting query-side
 * fold still matches by luck and the guard proves nothing. Each `typed` value
 * below is deliberately NOT already in folded form.
 */
const ROUND_TRIP: ReadonlyArray<[stored: string, typed: string]> = [
  ['Deep Rock Galactic', 'DEEP Rock'],
  ['Pokemon Legends', 'Pokémon'],
  ['Okami HD', 'Ōkami'],
  ['Fullwidth Game', 'Ｆｕｌｌｗｉｄｔｈ'],
  ['МЕТРО 2033', 'Метро'],
  ['ZeroWidth Title', 'Zero\u200bWidth'],
  ['Cafe Racer', 'Café  Racer'],
  ['Istanbul Tycoon', 'İstanbul'],
  ['Devanagari Quest', 'Devanāgarī'],
  ['Half-Life 2', 'HALF-LIFE'],
];

describe('ingest fold and query fold agree through SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    const ins = db.prepare(
      'INSERT INTO games (appid, name, name_folded) VALUES (?, ?, ?)',
    );
    ROUND_TRIP.forEach(([stored], i) => {
      // Exactly what the ingest path does.
      ins.run(1000 + i, sanitizeName(stored), foldName(sanitizeName(stored)));
    });
  });

  for (const [stored, typed] of ROUND_TRIP) {
    it(`finds ${JSON.stringify(stored)} when the user types ${JSON.stringify(typed)}`, () => {
      const row = db
        .prepare("SELECT appid FROM games WHERE name_folded LIKE ? ESCAPE '\\'")
        .get(`%${foldForSearch(typed)}%`);
      expect(row, `"${typed}" should match stored "${stored}"`).toBeDefined();
    });
  }

  it('does not match an unrelated query', () => {
    const row = db
      .prepare("SELECT appid FROM games WHERE name_folded LIKE ? ESCAPE '\\'")
      .get(`%${foldForSearch('factorio')}%`);
    expect(row).toBeUndefined();
  });
});

describe('foldName', () => {
  it('strips zero-width characters', () => {
    expect(foldName('Zero​Width')).toBe('zerowidth');
  });
  it('strips accents so "pokemon" matches "Pokémon"', () => {
    expect(foldName('Pokémon')).toBe('pokemon');
  });
  it('folds fullwidth compatibility forms', () => {
    expect(foldName('Ｆｕｌｌｗｉｄｔｈ')).toBe('fullwidth');
  });
  it('lowercases non-Latin scripts without mangling them', () => {
    expect(foldName('МЕТРО')).toBe('метро');
  });
  it('collapses and trims whitespace', () => {
    expect(foldName('  a  b   c  ')).toBe('a b c');
  });
  it('preserves % so LIKE-escaping is still the query layer\'s job', () => {
    expect(foldName('100% Orange Juice')).toBe('100% orange juice');
  });
});

describe('sanitizeName', () => {
  it('removes RTL overrides that would scramble an embed', () => {
    expect(sanitizeName('Game‮EmaG')).toBe('GameEmaG');
  });
  it('caps length at 190 characters', () => {
    expect(sanitizeName('x'.repeat(300))).toHaveLength(190);
  });
  it('keeps accents intact for display', () => {
    expect(sanitizeName('Pokémon')).toBe('Pokémon');
  });
});
