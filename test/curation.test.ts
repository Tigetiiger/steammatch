/**
 * The import checklist (excluded games) and per-game visibility (/steam change).
 *
 * These are the two places a user gets to say "no" about a specific game, and
 * they mean different things:
 *   - EXCLUDED: never written to the database at all.
 *   - HIDDEN:   written, still yours, withheld from everyone else.
 * Most of what follows exists to prove the two never bleed into each other.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema, openDb } from '../src/db/index.js';
import {
  addUserGame,
  ensureUser,
  findMatches,
  forget,
  getExcludedAppids,
  guildCatalog,
  leaderboard,
  linkSteam,
  listAllUserGames,
  listExcludedGames,
  listGames,
  searchGamesForAutocomplete,
  setExcludedGames,
  setHiddenGames,
  setOptedIn,
  sharedGames,
  touchGuildMember,
  unlink,
  upsertManualGame,
  whoOwns,
} from '../src/db/queries.js';
import { LIMITS, checklistEmbed, type ChecklistView } from '../src/ui/embeds.js';
import { syncLibrary, type LibrarySource } from '../src/steam/sync.js';
import type { LibraryResult, OwnedGame, ProfileState } from '../src/types.js';

const G = 'guild-1';
const A = 'U_alice';
const B = 'U_bob';
const A_ID = '76561198000000001';
const B_ID = '76561198000000002';

const g = (appid: number, name: string, mins: number): OwnedGame => ({
  appid,
  name,
  playtimeForever: mins,
  playtime2Weeks: 0,
  iconHash: 'a'.repeat(40),
});

function source(games: OwnedGame[], state: ProfileState = 'public'): LibrarySource {
  return {
    async fetchLibrary(): Promise<LibraryResult> {
      return { state, personaName: 'p', avatarUrl: null, games };
    },
  };
}

let db: Database.Database;

async function joinGuild(userId: string, id64: string, games: OwnedGame[]) {
  ensureUser(db, userId);
  setOptedIn(db, userId, true);
  touchGuildMember(db, G, userId);
  linkSteam(db, userId, id64);
  return syncLibrary(db, userId, id64, source(games));
}

const LIBRARY = [
  g(10, 'Factorio', 5000),
  g(20, 'Deep Rock Galactic', 4000),
  g(30, 'Embarrassing Game', 3000),
];

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

/* ------------------------------------------------------------------ *
 * Excluded games
 * ------------------------------------------------------------------ */

describe('the import checklist', () => {
  it('never writes a game the user unchecked', async () => {
    ensureUser(db, A);
    linkSteam(db, A, A_ID);
    // What the command does: record the answer, THEN sync.
    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);

    const out = await syncLibrary(db, A, A_ID, source(LIBRARY));

    expect(out.written).toBe(2);
    expect(out.excluded).toBe(1);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20]);
  });

  it('removes a game that was already imported when it is unchecked later', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    expect(listGames(db, A, -1, 50, 0)).toHaveLength(3);

    // setExcludedGames drops the existing row itself, so the change is visible
    // immediately rather than only after the next sync.
    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20]);

    // ...and a later /steam update does not bring it back.
    const out = await syncLibrary(db, A, A_ID, source(LIBRARY));
    expect(out.excluded).toBe(1);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20]);
  });

  it('re-checking a game imports it again on the next update', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);
    expect(getExcludedAppids(db, A)).toEqual(new Set([30]));

    // The checklist always submits a COMPLETE answer, so "nothing excluded" is
    // the empty array -- not an absent call.
    setExcludedGames(db, A, []);
    await syncLibrary(db, A, A_ID, source(LIBRARY));

    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20, 30]);
  });

  it('keeps the name so an excluded game can be listed back without a games row', () => {
    ensureUser(db, A);
    setExcludedGames(db, A, [{ appid: 999, name: 'Never Imported' }]);
    // Nobody anywhere owns appid 999, so there is no games row to join to.
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 0 });
    expect(listExcludedGames(db, A)).toEqual([{ appid: 999, name: 'Never Imported' }]);
  });

  it('does not let one user\'s exclusions affect another\'s import', async () => {
    ensureUser(db, A);
    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);
    await joinGuild(B, B_ID, LIBRARY);
    expect(listGames(db, B, -1, 50, 0)).toHaveLength(3);
  });

  it('leaves manual games alone -- they are not Steam appids', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);

    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);
    await syncLibrary(db, A, A_ID, source(LIBRARY));

    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toContain(mc);
  });

  it('drops exclusions when the Steam identity changes, since appids differ', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);

    linkSteam(db, A, '76561198000000009');
    expect(getExcludedAppids(db, A)).toEqual(new Set());
  });

  it('drops exclusions on unlink and on forget', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    setExcludedGames(db, A, [{ appid: 30, name: 'x' }]);
    unlink(db, A);
    expect(getExcludedAppids(db, A)).toEqual(new Set());

    await joinGuild(A, A_ID, LIBRARY);
    setExcludedGames(db, A, [{ appid: 30, name: 'x' }]);
    forget(db, A);
    expect(getExcludedAppids(db, A)).toEqual(new Set());
  });
});

/* ------------------------------------------------------------------ *
 * Per-game visibility
 * ------------------------------------------------------------------ */

describe('/steam change visibility', () => {
  beforeEach(async () => {
    await joinGuild(A, A_ID, LIBRARY);
    await joinGuild(B, B_ID, LIBRARY);
  });

  it('hides a game from every guild-facing query at once', () => {
    setHiddenGames(db, A, [30]);

    expect(whoOwns(db, G, 30, 30, 25).map((o) => o.userId)).toEqual([B]);
    expect(sharedGames(db, G, B, A, 30).map((r) => r.appid).sort()).toEqual([10, 20]);
    expect(sharedGames(db, G, A, B, 30).map((r) => r.appid).sort()).toEqual([10, 20]);
    expect(leaderboard(db, G, 30, 2, 50).map((r) => r.appid).sort()).toEqual([10, 20]);
    expect(searchGamesForAutocomplete(db, G, 'Embarrassing').map((r) => r.owners)).toEqual([1]);
  });

  it('still shows the hidden game to its owner, marked', () => {
    setHiddenGames(db, A, [30]);
    const rows = listGames(db, A, -1, 50, 0);
    expect(rows.map((r) => r.appid).sort()).toEqual([10, 20, 30]);
    expect(rows.find((r) => r.appid === 30)?.hidden).toBe(true);
    expect(rows.find((r) => r.appid === 10)?.hidden).toBe(false);
  });

  it('does not offer a hidden game back as something to add', () => {
    setHiddenGames(db, A, [30]);
    // B still has it visibly, but A owns it -- hidden is not "gone".
    expect(guildCatalog(db, G, A, 25).map((c) => c.appid)).not.toContain(30);
  });

  it('drops the hidden game out of the overlap that drives /match', () => {
    const before = findMatches(db, G, A, 30, 10, 'overlap')[0]!;
    expect(before.overlap).toBe(3);

    setHiddenGames(db, A, [30]);
    // Below MIN_OVERLAP_FOR_MATCH now, so the pair stops matching entirely --
    // hiding a game genuinely removes it from both sides of the comparison.
    expect(findMatches(db, G, A, 30, 10, 'overlap')).toEqual([]);
  });

  it('replaces the whole hidden set, so unticking one game unhides it', () => {
    setHiddenGames(db, A, [10, 20, 30]);
    expect(listAllUserGames(db, A).every((r) => r.hidden)).toBe(true);

    setHiddenGames(db, A, [30]);
    const rows = listAllUserGames(db, A);
    expect(rows.filter((r) => r.hidden).map((r) => r.appid)).toEqual([30]);
  });

  it('survives a Steam update -- syncing does not silently unhide anything', async () => {
    setHiddenGames(db, A, [30]);
    await syncLibrary(db, A, A_ID, source(LIBRARY));
    expect(listGames(db, A, -1, 50, 0).find((r) => r.appid === 30)?.hidden).toBe(true);
  });

  it('lists every game for the checklist, below the threshold and hidden alike', () => {
    setHiddenGames(db, A, [30]);
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    // A 5-minute game would fail every playtime filter, but you must still be
    // able to change its visibility.
    expect(listAllUserGames(db, A).map((r) => r.appid).sort((x, y) => x - y)).toEqual(
      [mc, 10, 20, 30].sort((x, y) => x - y),
    );
  });

  it('is independent of exclusion: a hidden game can also be excluded', async () => {
    setHiddenGames(db, A, [30]);
    setExcludedGames(db, A, [{ appid: 30, name: 'Embarrassing Game' }]);
    await syncLibrary(db, A, A_ID, source(LIBRARY));
    expect(listAllUserGames(db, A).map((r) => r.appid).sort()).toEqual([10, 20]);
  });
});

/* ------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------ */

describe('migration onto a database created before curation existed', () => {
  it('adds hidden, builds the view, and defaults every old row to visible', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sm-cur-')), 'old.sqlite');
    const old = new Database(path);
    // Exactly the shape of the previous release: no `hidden`, no
    // `excluded_games`, and therefore no visible_user_games view.
    old.exec(`
      CREATE TABLE users (user_id TEXT PRIMARY KEY, opted_in INTEGER NOT NULL DEFAULT 0,
        discoverable INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at INTEGER) STRICT;
      CREATE TABLE games (appid INTEGER PRIMARY KEY, name TEXT NOT NULL,
        name_folded TEXT NOT NULL, icon_hash TEXT NOT NULL DEFAULT '',
        last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())) STRICT;
      CREATE TABLE user_games (user_id TEXT NOT NULL, appid INTEGER NOT NULL,
        playtime_forever INTEGER NOT NULL DEFAULT 0, playtime_2weeks INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, appid))
        STRICT, WITHOUT ROWID;
    `);
    old.prepare('INSERT INTO users (user_id, opted_in) VALUES (?,1)').run('legacy');
    old.prepare('INSERT INTO games (appid,name,name_folded) VALUES (10,?,?)').run('Factorio', 'factorio');
    old.prepare('INSERT INTO user_games (user_id,appid,playtime_forever) VALUES (?,10,999)').run('legacy');
    old.close();

    const db2 = openDb(path);
    // Opening at all is half the test: an index or view naming `hidden` in
    // schema.sql (which runs BEFORE migrate) would have thrown by now.
    const row = listGames(db2, 'legacy', 30, 10, 0)[0]!;
    expect(row).toMatchObject({ appid: 10, playtime: 999, tracked: true, hidden: false });

    // Both new features work on the migrated database.
    setHiddenGames(db2, 'legacy', [10]);
    expect(listGames(db2, 'legacy', -1, 10, 0)[0]?.hidden).toBe(true);
    touchGuildMember(db2, G, 'legacy');
    expect(whoOwns(db2, G, 10, 30, 25)).toEqual([]);

    setExcludedGames(db2, 'legacy', [{ appid: 10, name: 'Factorio' }]);
    expect(getExcludedAppids(db2, 'legacy')).toEqual(new Set([10]));
    db2.close();
  });
});

/* ------------------------------------------------------------------ *
 * The checklist screen itself
 * ------------------------------------------------------------------ */

describe('the checklist embed', () => {
  const row = (label: string, checked: boolean, note?: string) => ({
    label,
    checked,
    ...(note === undefined ? {} : { note }),
  });

  const view = (pageRows: ReturnType<typeof row>[], over: Partial<ChecklistView> = {}) =>
    checklistEmbed({
      title: 'Choose what to import',
      intro: 'Untick anything you would rather I did not store.',
      pageRows,
      offset: 0,
      page: 0,
      pages: 1,
      checked: pageRows.filter((r) => r.checked).length,
      total: pageRows.length,
      checkedMeans: 'imported',
      uncheckedMeans: 'not stored',
      ...over,
    }).toJSON();

  it('renders a box per row so state is visible off the open dropdown', () => {
    const d = view([row('Factorio', true, '83 h played'), row('Secret Game', false)])
      .description!;
    expect(d).toContain('☑');
    expect(d).toContain('☐');
    expect(d).toMatch(/☐.*Secret Game/);
    expect(d).toMatch(/☑.*Factorio/);
  });

  it('escapes game names, so a title cannot restyle the rest of the list', () => {
    const d = view([row('*Hell*_divers_', true)]).description!;
    expect(d).toContain('\\*Hell\\*\\_divers\\_');
  });

  it('stays inside every Discord limit with 25 pathological names', () => {
    const evil = '*'.repeat(300) + '_Game_';
    const e = view(
      Array.from({ length: 25 }, () => row(evil, true, '999 h played')),
      { pages: 40, page: 12, offset: 300, total: 1000, checked: 998 },
    );
    expect((e.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);
    expect((e.title ?? '').length).toBeLessThanOrEqual(LIMITS.title);
    expect((e.footer?.text ?? '').length).toBeLessThanOrEqual(LIMITS.footer);
  });

  it('spells out what each state means, since the words differ per screen', () => {
    const e = view([row('Factorio', true)], {
      checkedMeans: 'teised näevad',
      uncheckedMeans: 'ainult sinule',
    });
    expect(e.footer?.text).toContain('linnuke = teised näevad');
    expect(e.footer?.text).toContain('ilma = ainult sinule');
  });
});
