/**
 * The import checklist and per-game visibility (/steam change).
 *
 * These are the two places a user gets to say "no" about a specific game, and
 * they mean different things:
 *   - NOT TICKED: no row, and nothing recorded about the refusal either.
 *   - HIDDEN:     written, still yours, withheld from everyone else.
 * Most of what follows exists to prove the two never bleed into each other.
 *
 * The checklist's answer reaches the database as the LIST ITSELF: syncLibrary is
 * handed only the ticked games and deletes every other Steam-sourced row. These
 * tests call it the way the command does -- `curated(...)` is a library that has
 * already been through the screen.
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
  guildCatalog,
  guildGameMeta,
  leaderboard,
  linkSteam,
  listAllUserGames,
  listGames,
  searchGamesForAutocomplete,
  setHiddenGames,
  steamAppids,
  setOptedIn,
  sharedGames,
  touchGuildMember,
  unlink,
  upsertManualGame,
  whoOwns,
} from '../src/db/queries.js';
import { LIMITS, checklistHeaderText, checklistRowText, type ChecklistView } from '../src/ui/embeds.js';
import {
  CHECKLIST_PAGE,
  checklistComponents,
  countComponents,
  type ChecklistItem,
} from '../src/ui/checklist.js';
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
 * The import checklist
 * ------------------------------------------------------------------ */

/** A library as it looks after the user has ticked a subset of it. */
const curated = (games: OwnedGame[]) => source(games);
const CURATED = { curated: true } as const;

describe('the import checklist', () => {
  it('never writes a game the user unticked', async () => {
    ensureUser(db, A);
    linkSteam(db, A, A_ID);

    const out = await syncLibrary(db, A, A_ID, curated([LIBRARY[0]!, LIBRARY[1]!]), undefined, CURATED);

    expect(out.written).toBe(2);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20]);
  });

  it('stores nothing at all about the refusal', async () => {
    ensureUser(db, A);
    linkSteam(db, A, A_ID);
    await syncLibrary(db, A, A_ID, curated([LIBRARY[0]!]), undefined, CURATED);

    // The table this used to be recorded in is gone, and migrate() drops it.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain('excluded_games');
    // Nor is the refusal hiding anywhere else: appid 30 leaves no trace.
    expect(db.prepare('SELECT COUNT(*) AS n FROM games WHERE appid = 30').get()).toEqual({ n: 0 });
  });

  it('removes a game that was already imported when it is unticked later', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    expect(listGames(db, A, -1, 50, 0)).toHaveLength(3);

    const out = await syncLibrary(db, A, A_ID, curated([LIBRARY[0]!, LIBRARY[1]!]), undefined, CURATED);

    expect(out.removed).toBe(1);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20]);
  });

  it('re-ticking a game imports it again, with nothing to clear first', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    await syncLibrary(db, A, A_ID, curated([LIBRARY[0]!]), undefined, CURATED);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toEqual([10]);

    await syncLibrary(db, A, A_ID, curated(LIBRARY), undefined, CURATED);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([10, 20, 30]);
  });

  it('unticking everything empties the library, because the user meant it', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    // An empty list straight from Steam is treated as a glitch and ignored --
    // that guard exists because a malformed response once wiped a real library.
    await syncLibrary(db, A, A_ID, source([]));
    expect(listGames(db, A, -1, 50, 0)).toHaveLength(3);

    // The same empty list from the checklist is a deliberate answer.
    await syncLibrary(db, A, A_ID, curated([]), undefined, CURATED);
    expect(listGames(db, A, -1, 50, 0)).toHaveLength(0);
  });

  it("does not let one user's choices affect another's import", async () => {
    ensureUser(db, A);
    linkSteam(db, A, A_ID);
    await syncLibrary(db, A, A_ID, curated([LIBRARY[0]!]), undefined, CURATED);

    await joinGuild(B, B_ID, LIBRARY);
    expect(listGames(db, B, -1, 50, 0)).toHaveLength(3);
  });

  it('leaves manual games alone -- they are not Steam appids', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);

    await syncLibrary(db, A, A_ID, curated([LIBRARY[0]!]), undefined, CURATED);

    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toContain(mc);
  });
});

describe('what /steam update pre-ticks', () => {
  // The command computes `initial` from steamAppids(): what is already stored.
  // Anything Steam reports that is NOT stored arrives unticked, which covers
  // both a genuinely new game and one the user declined last time. The two are
  // deliberately indistinguishable -- that is the whole point of storing
  // nothing about a refusal.
  it('reports exactly the Steam rows currently held', async () => {
    await joinGuild(A, A_ID, [LIBRARY[0]!, LIBRARY[1]!]);
    expect(steamAppids(db, A)).toEqual(new Set([10, 20]));

    const fresh = [...LIBRARY, g(40, 'Brand New Game', 10)];
    const preTicked = fresh.filter((game) => steamAppids(db, A).has(game.appid));
    const untTicked = fresh.filter((game) => !steamAppids(db, A).has(game.appid));

    expect(preTicked.map((x) => x.appid)).toEqual([10, 20]);
    // 30 was declined at the first import; 40 has never been seen. Both new.
    expect(untTicked.map((x) => x.appid)).toEqual([30, 40]);
  });

  it('excludes hand-added games, whose ids no Steam response can mention', async () => {
    await joinGuild(A, A_ID, LIBRARY);
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    expect(steamAppids(db, A)).toEqual(new Set([10, 20, 30]));
    expect(steamAppids(db, A).has(mc)).toBe(false);
  });

  it('is empty for a first import, which is why that case ticks everything', () => {
    ensureUser(db, A);
    expect(steamAppids(db, A)).toEqual(new Set());
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

  it('will not even name a hidden game on /games who', async () => {
    // The regression: `games` is a GLOBAL table, so resolving the appid there
    // found the name, and the screen rendered the title, icon and store link of
    // a game whose only local owner had just hidden it. The owner list was
    // empty, which read as "nobody plays this" rather than "not your business".
    expect(guildGameMeta(db, G, 30)).toMatchObject({ name: 'Embarrassing Game' });
    // Both members own it here, so it takes both of them hiding it -- one
    // person's choice must not blank a game somebody else is happy to show.
    setHiddenGames(db, A, [30]);
    expect(guildGameMeta(db, G, 30)).toMatchObject({ name: 'Embarrassing Game' });
    setHiddenGames(db, B, [30]);
    expect(guildGameMeta(db, G, 30)).toBeNull();
    expect(whoOwns(db, G, 30, -1, 25)).toEqual([]);
  });

  it('still names a game the guild owns but nobody has really played', () => {
    // Not the same case, and it must stay distinguishable: this game IS here,
    // the answer is just that nobody cleared the threshold. So the meta lookup
    // is deliberately not filtered by playtime.
    expect(guildGameMeta(db, G, 30)).toMatchObject({ name: 'Embarrassing Game' });
    expect(whoOwns(db, G, 30, 99999, 25)).toEqual([]);
  });

  it('does not name a game only somebody in ANOTHER guild owns', async () => {
    await joinGuild(B, B_ID, LIBRARY);
    const OTHER = 'guild-2';
    expect(guildGameMeta(db, OTHER, 10)).toBeNull();
  });

  it('does not name a game whose owners are all ineligible here', () => {
    setOptedIn(db, A, false);
    setOptedIn(db, B, false);
    expect(guildGameMeta(db, G, 10)).toBeNull();
  });

  it('is independent of the checklist: a hidden game can also be dropped', async () => {
    setHiddenGames(db, A, [30]);
    await syncLibrary(db, A, A_ID, source([LIBRARY[0]!, LIBRARY[1]!]), undefined, { curated: true });
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

    expect(steamAppids(db2, 'legacy')).toEqual(new Set([10]));
    db2.close();
  });

  it('drops an existing excluded_games table, rows and all', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sm-exc-')), 'old.sqlite');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE users (user_id TEXT PRIMARY KEY, opted_in INTEGER NOT NULL DEFAULT 0,
        discoverable INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at INTEGER) STRICT;
      CREATE TABLE excluded_games (user_id TEXT NOT NULL, appid INTEGER NOT NULL,
        name TEXT NOT NULL, excluded_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, appid)) STRICT, WITHOUT ROWID;
    `);
    old.prepare('INSERT INTO users (user_id, opted_in) VALUES (?,1)').run('legacy');
    old
      .prepare('INSERT INTO excluded_games (user_id, appid, name) VALUES (?,?,?)')
      .run('legacy', 30, 'Embarrassing Game');
    expect(old.prepare('SELECT COUNT(*) AS n FROM excluded_games').get()).toEqual({ n: 1 });
    old.close();

    const db2 = openDb(path);
    const tables = db2
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain('excluded_games');
    db2.close();
  });
});

/* ------------------------------------------------------------------ *
 * The checklist screen itself
 * ------------------------------------------------------------------ */

describe('the checklist screen', () => {
  const row = (label: string, checked: boolean, note?: string) => ({
    label,
    checked,
    ...(note === undefined ? {} : { note }),
  });

  const header = (over: Partial<ChecklistView> = {}) =>
    checklistHeaderText({
      title: 'Choose what to import',
      intro: 'Untick anything you would rather I did not store.',
      pageRows: [],
      offset: 0,
      page: 0,
      pages: 1,
      checked: 1,
      total: 2,
      checkedMeans: 'imported',
      uncheckedMeans: 'not stored',
      ...over,
    });

  it('renders a box per row, so state is readable without tracing to the button', () => {
    expect(checklistRowText(row('Factorio', true, '83 h played'), 1)).toContain('☑');
    expect(checklistRowText(row('Secret Game', false), 2)).toContain('☐');
    expect(checklistRowText(row('Factorio', true, '83 h played'), 1)).toContain('83 h played');
  });

  it('escapes game names, so a title cannot restyle the rest of the list', () => {
    expect(checklistRowText(row('*Hell*_divers_', true), 1)).toContain('\\*Hell\\*\\_divers\\_');
  });

  it('spells out what each state means, since the words differ per screen', () => {
    const h = header({ checkedMeans: 'teised näevad', uncheckedMeans: 'ainult sinule' });
    expect(h).toContain('linnuke = teised näevad');
    expect(h).toContain('ilma = ainult sinule');
  });

  it('names the page in the header, because no button is left to hold it', () => {
    expect(header({ pages: 42, page: 11 })).toContain('lk 12/42');
    // A single page says nothing -- "lk 1/1" is noise.
    expect(header({ pages: 1 })).not.toContain('lk');
  });

  /* ---------------------------------------------------------------- *
   * The budget. This is the constraint that set the page size, and it
   * is invisible in the code that draws a row -- so it gets a test.
   * ---------------------------------------------------------------- */

  const items = (n: number): ChecklistItem[] =>
    Array.from({ length: n }, (_, i) => ({
      id: String(-(i + 1)),
      label: '*'.repeat(300) + '_Game_',
      note: 'mängitud 999 h',
    }));

  const state = (n: number, page = 0) => ({
    sid: 'abc123',
    items: items(n),
    checked: new Set(items(n).map((i) => i.id)),
    page,
    title: 'Vali, mida importida',
    checkedMeans: 'salvestatakse',
    uncheckedMeans: 'ei salvestata',
    saveLabel: 'Impordi valitud',
  });

  it('fits Discord\'s 40-component budget on a full page', () => {
    const n = countComponents(checklistComponents(state(1000)));
    // 1 header + 1 container + 10 x (section + text + button) + row + 5 buttons
    expect(n).toBe(38);
    expect(n).toBeLessThanOrEqual(LIMITS.componentsV2);
  });

  it('keeps the container within its 10-child cap', () => {
    const tree = checklistComponents(state(1000)) as { toJSON(): unknown }[];
    const container = tree[1]!.toJSON() as { components: unknown[] };
    expect(container.components).toHaveLength(CHECKLIST_PAGE);
    expect(container.components.length).toBeLessThanOrEqual(LIMITS.containerChildren);
  });

  it('would blow the budget at the old page size, which is why it moved to 10', () => {
    // Not a hypothetical: 25 rows is what the select-menu version showed.
    const perRow = 3;
    expect(1 + 1 + 25 * perRow + 1 + 5).toBeGreaterThan(LIMITS.componentsV2);
  });

  it('spends exactly five buttons on navigation, the row cap', () => {
    const tree = checklistComponents(state(1000)) as { toJSON(): unknown }[];
    const nav = tree[2]!.toJSON() as { components: unknown[] };
    expect(nav.components).toHaveLength(5);
  });

  it('flips the mark-all button to clear-all once everything is ticked', () => {
    const all = checklistComponents(state(30)) as { toJSON(): unknown }[];
    const navAll = JSON.stringify(all[2]!.toJSON());
    expect(navAll).toContain('Eemalda kõik');

    const some = { ...state(30), checked: new Set(['-1']) };
    const navSome = JSON.stringify((checklistComponents(some) as { toJSON(): unknown }[])[2]!.toJSON());
    expect(navSome).toContain('Märgi kõik');
  });

  it('keeps a negative appid intact in the toggle id, sign and all', () => {
    const tree = checklistComponents(state(30)) as { toJSON(): unknown }[];
    const container = JSON.stringify(tree[1]!.toJSON());
    expect(container).toContain('cl:abc123:t:-1');
    // The handler splits on ':' and rejoins from index 3, so the sign survives.
    expect('cl:abc123:t:-1'.split(':').slice(3).join(':')).toBe('-1');
  });

  it('disables prev on the first page and next on the last', () => {
    const navOf = (page: number) =>
      ((checklistComponents(state(30, page)) as { toJSON(): unknown }[])[2]!.toJSON() as {
        components: { custom_id: string; disabled?: boolean }[];
      }).components;
    const first = navOf(0);
    expect(first.find((c) => c.custom_id.endsWith(':prev'))?.disabled).toBe(true);
    expect(first.find((c) => c.custom_id.endsWith(':next'))?.disabled).toBe(false);
    const last = checklistComponents(state(30, 2)) as { toJSON(): unknown }[];
    const nav = last[2]!.toJSON() as { components: { custom_id: string; disabled?: boolean }[] };
    expect(nav.components.find((c) => c.custom_id.endsWith(':next'))?.disabled).toBe(true);
    expect(nav.components.find((c) => c.custom_id.endsWith(':prev'))?.disabled).toBe(false);
  });
});
