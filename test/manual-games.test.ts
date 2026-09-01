import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema, openDb } from '../src/db/index.js';
import {
  addUserGame, ensureUser, findMatches, guildCatalog, leaderboard, linkSteam,
  listGames, removeUserGame, searchGamesForAutocomplete, searchGuildCatalog,
  setHiddenGames, setOptedIn, sharedGames,
  touchGuildMember, unlink, upsertManualGame, userManualGames, whoOwns, forget,
} from '../src/db/queries.js';
import { syncLibrary, type LibrarySource } from '../src/steam/sync.js';
import { passesPlaytimeFilter } from '../src/commands/games.js';
import { QUICK_ADD_GAMES, panelComponents } from '../src/commands/add-panel.js';
import type { LibraryResult, OwnedGame } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const G = 'guild-1';
const A = 'U_a';
const B = 'U_b';

const g = (appid: number, name: string, mins: number): OwnedGame => ({
  appid, name, playtimeForever: mins, playtime2Weeks: 0, iconHash: '',
});
const source = (games: OwnedGame[]): LibrarySource => ({
  async fetchLibrary(): Promise<LibraryResult> {
    // A real fetchLibrary never reports 'public' with an empty list -- that
    // shape is classified 'empty' (or 'error'), so mirror it here.
    return {
      state: games.length === 0 ? 'empty' : 'public',
      personaName: 'p',
      avatarUrl: null,
      games,
    };
  },
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  for (const u of [A, B]) {
    ensureUser(db, u);
    setOptedIn(db, u, true);
    touchGuildMember(db, G, u);
  }
});

describe('the manual game catalogue', () => {
  it('gives manual games negative ids so they cannot collide with Steam appids', () => {
    const mc = upsertManualGame(db, 'Minecraft');
    expect(mc.appid).toBeLessThan(0);
    expect(upsertManualGame(db, 'Terraria').appid).toBeLessThan(mc.appid);
  });

  it('deduplicates on the folded name so everyone shares one entry', () => {
    const a = upsertManualGame(db, 'Minecraft');
    const b = upsertManualGame(db, '  MINECRAFT  ');
    const c = upsertManualGame(db, 'minecraft');
    expect(new Set([a.appid, b.appid, c.appid]).size).toBe(1);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
  });
});

describe('manual games ignore every playtime filter', () => {
  let mc: number;
  beforeEach(() => {
    mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    addUserGame(db, B, mc);
  });

  it('shows in /games list at any threshold', () => {
    for (const min of [0, 30, 600, 100_000]) {
      expect(listGames(db, A, min, 50, 0).map((r) => r.appid)).toContain(mc);
    }
  });

  it('marks the row as untracked so the UI can say why it has no hours', () => {
    const row = listGames(db, A, 0, 50, 0).find((r) => r.appid === mc)!;
    expect(row.tracked).toBe(false);
    expect(row.playtime).toBe(0);
  });

  it('shows in /games who, /games shared, /match and the leaderboard', () => {
    expect(whoOwns(db, G, mc, 100_000, 10).map((r) => r.userId).sort()).toEqual([A, B]);
    expect(sharedGames(db, G, A, B, 100_000).map((r) => r.appid)).toContain(mc);
    expect(leaderboard(db, G, 100_000, 2, 10).map((r) => r.appid)).toContain(mc);

    for (let i = 1; i <= 3; i++) {
      const x = upsertManualGame(db, `Game ${i}`).appid;
      addUserGame(db, A, x);
      addUserGame(db, B, x);
    }
    const m = findMatches(db, G, A, 100_000, 10);
    expect(m.map((r) => r.userId)).toContain(B);
  });

  it('sorts after games that have real playtime', async () => {
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 5000)]));
    const rows = listGames(db, A, -1, 50, 0);
    expect(rows[0]!.name).toBe('Factorio');
    expect(rows[rows.length - 1]!.appid).toBe(mc);
  });
});

describe('Steam sync and manual games coexist', () => {
  it('a Steam sync does not delete manually added games', async () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    linkSteam(db, A, '76561198000000001');

    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 500)]));
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([mc, 10].sort());

    // Two confirming empty answers are needed before Steam rows are cleared
    // (one bad response must never wipe a library) -- and Minecraft, being
    // untracked, must survive even that.
    await syncLibrary(db, A, '76561198000000001', source([]));
    await syncLibrary(db, A, '76561198000000001', source([]));
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toEqual([mc]);
  });

  it('adding a game you already own from Steam never clobbers real playtime', async () => {
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 5000)]));

    expect(addUserGame(db, A, 10)).toBe(false); // already present
    const row = listGames(db, A, -1, 50, 0).find((r) => r.appid === 10)!;
    expect(row.playtime).toBe(5000);
    expect(row.tracked).toBe(true);
  });
});

describe('the server catalogue', () => {
  it('offers games other people have that you do not, and drops them once you do', () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, B, mc);

    expect(guildCatalog(db, G, A).map((c) => c.name)).toEqual(['Minecraft']);
    expect(guildCatalog(db, G, A)[0]!.owners).toBe(1);

    addUserGame(db, A, mc);
    expect(guildCatalog(db, G, A)).toEqual([]);
    expect(guildCatalog(db, G, B)).toEqual([]);
  });

  it('never offers games from another guild, or from hidden members', () => {
    const other = upsertManualGame(db, 'Other Guild Game').appid;
    ensureUser(db, 'U_far');
    setOptedIn(db, 'U_far', true);
    touchGuildMember(db, 'guild-2', 'U_far');
    addUserGame(db, 'U_far', other);

    expect(guildCatalog(db, G, A)).toEqual([]);

    const hidden = upsertManualGame(db, 'Hidden Game').appid;
    addUserGame(db, B, hidden);
    setOptedIn(db, B, false);
    expect(guildCatalog(db, G, A)).toEqual([]);
  });
});

describe('removing manual games', () => {
  it('lists and removes only hand-added games', async () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 500)]));

    expect(userManualGames(db, A).map((x) => x.name)).toEqual(['Minecraft']);

    expect(removeUserGame(db, A, mc)).toBe(true);
    expect(removeUserGame(db, A, mc)).toBe(false);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toEqual([10]);
  });

  it('refuses to delete a Steam row, whatever appid it is handed', async () => {
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 500)]));

    // The panel offers manual games only, but the appid arrives in a select
    // value: the predicate that makes the promise true belongs in the SQL.
    expect(removeUserGame(db, A, 10)).toBe(false);
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toEqual([10]);
  });

  it('rejects a non-integer appid instead of handing it to the driver', () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    expect(addUserGame(db, A, 1.5)).toBe(false);
    expect(addUserGame(db, A, Number.NaN)).toBe(false);
    expect(removeUserGame(db, A, 1.5)).toBe(false);
    expect(addUserGame(db, A, mc)).toBe(true);
  });
});

describe('the /games list threshold buttons', () => {
  // The list is pulled once and re-filtered in memory, so this predicate is a
  // second copy of the SQL rule. It is the copy that had the bug: hand-added
  // games survived the query and were then dropped by the 30-minute default.
  const manual = { playtime: 0, tracked: false };
  const steam = { playtime: 45, tracked: true };

  it('keeps hand-added games at every threshold', () => {
    for (const min of [-1, 0, 30, 60, 600, 100000]) {
      expect(passesPlaytimeFilter(manual, min)).toBe(true);
    }
  });

  it('still applies the threshold to Steam rows, strictly', () => {
    expect(passesPlaytimeFilter(steam, 30)).toBe(true);
    expect(passesPlaytimeFilter(steam, 45)).toBe(false);
    expect(passesPlaytimeFilter(steam, 60)).toBe(false);
    expect(passesPlaytimeFilter({ playtime: 0, tracked: true }, -1)).toBe(true);
  });
});

describe('a hand-added game shows no Steam name', () => {
  it('omits the persona on /games who, even for a linked user', async () => {
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 500)]));
    db.prepare('UPDATE steam_accounts SET persona_name = ? WHERE user_id = ?').run('tigetiger', A);

    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);

    // The Steam game still names the account it came from...
    expect(whoOwns(db, G, 10, -1, 25)[0]?.personaName).toBe('tigetiger');
    // ...the hand-added one does not. It never came from Steam, and the person
    // listed might not have a Steam account at all.
    expect(whoOwns(db, G, mc, -1, 25)[0]?.personaName).toBeNull();
  });

  it('still lists the person, and still marks a moderator-added entry', async () => {
    linkSteam(db, B, '76561198000000002', 'U_mod');
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, B, mc);

    const row = whoOwns(db, G, mc, -1, 25)[0]!;
    expect(row.userId).toBe(B);
    expect(row.addedBy).toBe('U_mod');
  });
});

describe('unlinking Steam keeps hand-added games', () => {
  it('/steam unlink drops the Steam library but not the manual one', async () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 500)]));
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid).sort()).toEqual([-1, 10]);

    unlink(db, A);

    expect(db.prepare('SELECT 1 FROM steam_accounts WHERE user_id = ?').get(A)).toBeUndefined();
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toEqual([mc]);
    expect(userManualGames(db, A).map((x) => x.name)).toEqual(['Minecraft']);
  });

  it('relinking to a different Steam account keeps them too', async () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    linkSteam(db, A, '76561198000000001');
    await syncLibrary(db, A, '76561198000000001', source([g(10, 'Factorio', 500)]));

    const out = linkSteam(db, A, '76561198000000002');
    expect(out).toEqual({ ok: true, wiped: true });

    // The old account's library is gone; the hand-added game is not.
    expect(listGames(db, A, -1, 50, 0).map((r) => r.appid)).toEqual([mc]);
  });

  it('forget me still deletes everything, manual games included', () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    forget(db, A);
    expect(listGames(db, A, -1, 50, 0)).toEqual([]);
  });
});

describe('migration onto an existing database', () => {
  it('adds source and playtime_tracked, defaulting old rows to Steam-tracked', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sm-')), 'old.sqlite');
    const old = new Database(path);
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
    // The pre-existing Steam game keeps real playtime and stays tracked.
    const row = listGames(db2, 'legacy', 30, 10, 0)[0]!;
    expect(row).toMatchObject({ appid: 10, playtime: 999, tracked: true });
    // And the new manual path works on the migrated database.
    const mc = upsertManualGame(db2, 'Minecraft').appid;
    addUserGame(db2, 'legacy', mc);
    expect(listGames(db2, 'legacy', 100_000, 10, 0).map((r) => r.appid)).toEqual([mc]);
    db2.close();
  });
});

describe('the "my games" leaderboard', () => {
  it('ranks only my games, and only ones somebody else here also has', () => {
    const shared = upsertManualGame(db, 'Shared Game').appid;
    const solo = upsertManualGame(db, 'Only Mine').appid;
    const theirs = upsertManualGame(db, 'Only Theirs').appid;

    addUserGame(db, A, shared);
    addUserGame(db, B, shared);
    addUserGame(db, A, solo);
    addUserGame(db, B, theirs);

    const board = leaderboard(db, G, 0, 2, 25, A).map((r) => r.appid);
    expect(board).toEqual([shared]);
    expect(board).not.toContain(solo);   // nobody shares it
    expect(board).not.toContain(theirs); // not mine

    // The whole-server board is unaffected by the scoping.
    expect(leaderboard(db, G, 0, 2, 25).map((r) => r.appid)).toEqual([shared]);
  });

  it('counts include me, so a shared game reads as 2 people', () => {
    const x = upsertManualGame(db, 'Co-op').appid;
    addUserGame(db, A, x);
    addUserGame(db, B, x);
    expect(leaderboard(db, G, 0, 2, 25, A)[0]!.owners).toBe(2);
  });
});

describe('playtime is shown only in /games list', () => {
  it('renders a hand-added game as "käsitsi lisatud", never as 0 min', async () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    addUserGame(db, A, mc);
    const { libraryEmbed } = await import('../src/ui/embeds.js');
    const out = libraryEmbed({
      displayName: 'a',
      pageRows: listGames(db, A, -1, 10, 0),
      offset: 0, page: 0, pages: 1, matching: 1, matchingMinutes: 0,
      ownedTotal: 1, filter: 30, syncedAgo: null,
    }).toJSON();
    const row = (out.description ?? '').split('\n').at(-1)!;
    expect(row).toContain('käsitsi lisatud');
    // The row must not claim a measured 0 -- that would read as "never played".
    expect(row).not.toMatch(/0 min|0 h/);
  });

  it('omits playtime from shared, who and the leaderboard', async () => {
    const e = await import('../src/ui/embeds.js');
    const shared = e.sharedEmbed({
      meName: 'a', themName: 'b',
      pageRows: [{ appid: 1, name: 'Factorio', mine: 24720, theirs: 18600, tracked: true }],
      offset: 0, page: 0, pages: 1, total: 1, myLibrarySize: 5, theirLibrarySize: 5, filter: 30,
    }).toJSON();
    expect(shared.description).not.toMatch(/412 h|310 h|\d+ h`/);

    const who = e.whoEmbed({
      appid: 1, name: 'Factorio', filter: 30, iconUrl: null, storeUrl: 'https://x',
      owners: [{ userId: '1', playtime: 24720, personaName: null, addedBy: null }],
    }).toJSON();
    expect(who.description).not.toMatch(/\d+ h/);

    const board = e.leaderboardEmbed({
      guildName: 'G',
      pageRows: [{ appid: 1, name: 'Factorio', owners: 4, guildMinutes: 128400 }],
      offset: 0, page: 0, pages: 1, memberCount: 4, distinctGames: 1, filter: 30,
    }).toJSON();
    expect(board.description).toContain('4 inimest');
    expect(board.description).not.toMatch(/\d[\d ]* h/);
  });
});

/* -------------------------------------------------------------------------- */

describe('manual games are reachable from /games who', () => {
  /**
   * The synthetic appid of a manual game is NEGATIVE. Autocomplete offers the
   * game and sends that appid back as the option's value, so every step that
   * parses or renders an appid has to survive a leading minus sign.
   */
  it('parses a negative appid the way /games who does', () => {
    // The exact predicate from whoSub. A `^\d` version silently rejected every
    // manual game, fell through to a name search for the literal text "-1",
    // and told the user nobody owned the game it had just suggested.
    const parse = (raw: string) => (/^-?\d{1,10}$/.test(raw) ? Number.parseInt(raw, 10) : null);

    expect(parse('-1')).toBe(-1);
    expect(parse('-4242')).toBe(-4242);
    expect(parse('440')).toBe(440);
    // Still not an appid.
    expect(parse('minecraft')).toBeNull();
    expect(parse('-')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('offers a manual game through autocomplete, keyed by its negative appid', async () => {
    const mc = upsertManualGame(db, 'Minecraft').appid;
    expect(mc).toBeLessThan(0);
    addUserGame(db, A, mc);
    addUserGame(db, B, mc);

    const hits = searchGamesForAutocomplete(db, G, 'minecraft', 25);
    expect(hits).toEqual([{ appid: mc, name: 'Minecraft', owners: 2 }]);

    // ...and the query behind the answer finds both owners.
    expect(whoOwns(db, G, mc, 30, 25).map((o) => o.userId).sort()).toEqual([A, B].sort());
  });

  it('renders without a store link, since a manual game has no store page', async () => {
    const e = await import('../src/ui/embeds.js');
    const who = e.whoEmbed({
      appid: -1,
      name: 'Minecraft',
      filter: 30,
      iconUrl: null,
      // https://store.steampowered.com/app/-1 is a 404 wearing the game's name.
      storeUrl: null,
      owners: [{ userId: '1', playtime: 0, personaName: null, addedBy: null }],
    }).toJSON();
    expect(who.url).toBeUndefined();
    expect(who.title).toBe('Minecraft');

    // Every button is one of ours -- no link component, which is the point here.
    // Counting them would break every time a button is added, which says nothing
    // about store pages.
    const row = e.whoRow('abc12345', 1, null).toJSON();
    expect(row.components.every((c) => 'custom_id' in c)).toBe(true);
    expect(row.components.some((c) => 'url' in c)).toBe(false);

    // A Steam game still gets the link.
    const steamRow = e.whoRow('abc12345', 1, 'https://store.steampowered.com/app/440').toJSON();
    expect(steamRow.components.some((c) => 'url' in c)).toBe(true);
  });

  it('never emits an empty action row, which Discord rejects', async () => {
    const e = await import('../src/ui/embeds.js');
    // No owners and no store page: the row has nothing in it, so whoSub must
    // send `components: []` rather than a row with zero components.
    expect(e.whoRow('abc12345', 0, null).components).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Reaching the whole catalogue
 *
 * The select menu holds 25 options and stops there. These cover the two ways
 * past that ceiling: the browse checklist (which reads the catalogue with a
 * large limit) and /games add's autocomplete search.
 * ------------------------------------------------------------------ */

describe('searchGuildCatalog', () => {
  /** More games than a select menu can hold, so the 25-cap is actually crossed. */
  async function bigCatalog(): Promise<void> {
    const games: OwnedGame[] = [];
    for (let i = 1; i <= 40; i++) games.push(g(1000 + i, `Test Game ${i}`, 100 + i));
    games.push(g(2001, 'Hollow Knight', 900));
    games.push(g(2002, 'Pokémon Legends', 800));
    linkSteam(db, B, '76561198000000002');
    await syncLibrary(db, B, '76561198000000002', source(games));
  }

  it('finds a game far below the top 25, which the select menu cannot reach', async () => {
    await bigCatalog();
    // B owns 42 games; the panel's menu shows 25 of them. Hollow Knight is in
    // the catalogue either way, but only search can name it.
    expect(guildCatalog(db, G, A, 25)).toHaveLength(25);
    expect(guildCatalog(db, G, A, 1000)).toHaveLength(42);

    const hit = searchGuildCatalog(db, G, A, 'hollow', 25);
    expect(hit.map((r) => r.name)).toEqual(['Hollow Knight']);
  });

  it('folds diacritics the same way the stored name is folded', async () => {
    await bigCatalog();
    expect(searchGuildCatalog(db, G, A, 'pokemon', 25).map((r) => r.name)).toEqual([
      'Pokémon Legends',
    ]);
  });

  it('never offers a game the caller already has', async () => {
    await bigCatalog();
    expect(searchGuildCatalog(db, G, A, 'hollow', 25)).toHaveLength(1);
    addUserGame(db, A, 2001);
    expect(searchGuildCatalog(db, G, A, 'hollow', 25)).toEqual([]);
  });

  it('never offers a game its only owner has hidden', async () => {
    await bigCatalog();
    expect(searchGuildCatalog(db, G, A, 'hollow', 25)).toHaveLength(1);
    setHiddenGames(db, B, [2001]);
    expect(searchGuildCatalog(db, G, A, 'hollow', 25)).toEqual([]);
    // ...and the unfiltered catalogue agrees, so search cannot be the loose one.
    expect(guildCatalog(db, G, A, 1000).some((r) => r.appid === 2001)).toBe(false);
  });

  it('never offers a game belonging to somebody invisible here', async () => {
    await bigCatalog();
    setOptedIn(db, B, false);
    expect(searchGuildCatalog(db, G, A, 'hollow', 25)).toEqual([]);
  });

  it('matches LIKE metacharacters literally', async () => {
    linkSteam(db, B, '76561198000000002');
    await syncLibrary(db, B, '76561198000000002', source([g(3001, '100% Orange Juice', 60)]));
    expect(searchGuildCatalog(db, G, A, '100%', 25).map((r) => r.name)).toEqual([
      '100% Orange Juice',
    ]);
    // The escape is what stops this from matching "100" as a prefix wildcard.
    expect(searchGuildCatalog(db, G, A, '100%o', 25)).toEqual([]);
  });

  it('falls back to the plain catalogue when nothing is typed yet', async () => {
    await bigCatalog();
    // Discord asks for suggestions before the first keystroke; a blank menu
    // there would make the option look broken.
    expect(searchGuildCatalog(db, G, A, '', 25)).toHaveLength(25);
    expect(searchGuildCatalog(db, G, A, '   ', 25)).toHaveLength(25);
  });

  it('ranks by how many people here have it', async () => {
    linkSteam(db, B, '76561198000000002');
    await syncLibrary(db, B, '76561198000000002', source([g(10, 'Half-Life 2', 500), g(11, 'Half-Life Deathmatch', 5)]));
    ensureUser(db, 'U_c');
    touchGuildMember(db, G, 'U_c');
    setOptedIn(db, 'U_c', true);
    linkSteam(db, 'U_c', '76561198000000003');
    await syncLibrary(db, 'U_c', '76561198000000003', source([g(10, 'Half-Life 2', 300)]));

    expect(searchGuildCatalog(db, G, A, 'half', 25).map((r) => r.name)).toEqual([
      'Half-Life 2',
      'Half-Life Deathmatch',
    ]);
  });
});

describe('the /games add panel layout', () => {
  const rows = () => panelComponents('abc12345').map((r) => r.toJSON());
  const ids = () =>
    rows()
      .flatMap((r) => r.components)
      .map((c) => ('custom_id' in c ? c.custom_id : null));

  it('carries no select menu at all', () => {
    // A select menu holds 25 options because that is Discord's cap, so it could
    // only ever be a shortlist wearing a catalogue's costume. "Sirvi kõiki"
    // answers the same question without a ceiling; keeping both would be two
    // ways of doing one thing, the worse one first.
    for (const r of rows()) {
      for (const c of r.components) expect('options' in c).toBe(false);
    }
    expect(ids()).not.toContain('gp:abc12345:pick');
  });

  it('offers the browse button, which is now the only way into the catalogue', () => {
    expect(ids()).toContain('gp:abc12345:browse');
  });

  it('never puts more than five components in one action row', () => {
    // The primary actions used to share a row with the quick-add buttons under
    // a slice(0, 5); a second quick-add game would have silently eaten one.
    for (const r of rows()) expect(r.components.length).toBeLessThanOrEqual(5);
  });

  it('keeps every primary action reachable, quick-add list notwithstanding', () => {
    for (const key of ['steam', 'browse', 'manual', 'remove']) {
      expect(ids(), key).toContain(`gp:abc12345:${key}`);
    }
    // ...and the quick-add buttons still made it, on their own row.
    QUICK_ADD_GAMES.forEach((_q, i) => expect(ids()).toContain(`gp:abc12345:quick${i}`));
  });

  it('stays within the five action rows Discord allows', () => {
    expect(rows().length).toBeLessThanOrEqual(5);
  });
});
