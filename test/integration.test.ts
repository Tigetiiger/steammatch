import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/db/index.js';
import {
  ensureUser, findMatches, leaderboard, linkSteam, listGames,
  searchGamesForAutocomplete, setOptedIn, sharedGames, touchGuildMember, whoOwns,
} from '../src/db/queries.js';
import { syncLibrary, type LibrarySource } from '../src/steam/sync.js';
import { libraryEmbed, sharedEmbed, whoEmbed, matchEmbed, LIMITS } from '../src/ui/embeds.js';
import type { LibraryResult, OwnedGame, ProfileState } from '../src/types.js';

/**
 * End-to-end: a stubbed Steam response goes through the real sync transaction,
 * the real queries, and the real embed builders. The three layers were written
 * in parallel by separate agents, so this exercises the seams between them --
 * unit tests on each layer in isolation cannot catch a contract mismatch.
 */

const G = 'guild-1';
const ALICE = 'U_alice', BOB = 'U_bob', CARA = 'U_cara';

const g = (appid: number, name: string, mins: number): OwnedGame => ({
  appid, name, playtimeForever: mins, playtime2Weeks: 0, iconHash: 'a'.repeat(40),
});

function source(games: OwnedGame[], state: ProfileState = 'public', persona = 'p'): LibrarySource {
  return {
    async fetchLibrary(): Promise<LibraryResult> {
      return { state, personaName: persona, avatarUrl: null, games };
    },
  };
}

let db: Database.Database;

async function join(userId: string, id64: string, games: OwnedGame[]) {
  ensureUser(db, userId);
  setOptedIn(db, userId, true);
  touchGuildMember(db, G, userId);
  linkSteam(db, userId, id64);
  return syncLibrary(db, userId, id64, source(games));
}

beforeEach(async () => {
  db = new Database(':memory:');
  applySchema(db);
  await join(ALICE, '76561197960287930', [
    g(10, 'Deep Rock Galactic', 24720), g(20, 'Factorio', 17280),
    g(30, 'Terraria', 5820), g(40, 'Portal 2', 30), g(50, 'Superhot', 31),
  ]);
  await join(BOB, '76561197960287931', [
    g(10, 'Deep Rock Galactic', 18600), g(20, 'Factorio', 900),
    g(60, 'Valheim', 4200), g(40, 'Portal 2', 5000),
  ]);
  await join(CARA, '76561197960287932', [
    g(10, 'Deep Rock Galactic', 100), g(70, 'Celeste', 1440),
  ]);
});

describe('sync -> query -> embed', () => {
  it('imports a library and applies the strict > threshold', () => {
    // Portal 2 has exactly 30 minutes: excluded at 30, included at 29.
    const at30 = listGames(db, ALICE, 30, 100, 0).map((r) => r.appid);
    expect(at30).not.toContain(40);
    expect(at30).toContain(50); // 31 minutes
    expect(listGames(db, ALICE, 29, 100, 0).map((r) => r.appid)).toContain(40);
  });

  it('orders a library by playtime descending', () => {
    expect(listGames(db, ALICE, 0, 3, 0).map((r) => r.name))
      .toEqual(['Deep Rock Galactic', 'Factorio', 'Terraria']);
  });

  it('sorts shared games by the weaker playtime, not the caller\'s', () => {
    const rows = sharedGames(db, G, ALICE, BOB, 30);
    // DRG: min(24720,18600)=18600. Factorio: min(17280,900)=900. DRG must lead.
    expect(rows.map((r) => r.name)).toEqual(['Deep Rock Galactic', 'Factorio']);
    expect(rows[0]!.mine).toBe(24720);
    expect(rows[0]!.theirs).toBe(18600);
  });

  it('reports owners of a game above the threshold only', () => {
    // Cara has 100 min in DRG, so she appears at 30 but not at 600.
    expect(whoOwns(db, G, 10, 30, 10).map((r) => r.userId)).toEqual([ALICE, BOB, CARA]);
    expect(whoOwns(db, G, 10, 600, 10).map((r) => r.userId)).toEqual([ALICE, BOB]);
  });

  it('builds a guild leaderboard', () => {
    const rows = leaderboard(db, G, 30, 2, 10);
    expect(rows[0]).toMatchObject({ appid: 10, owners: 3 });
  });

  it('computes overlap and jaccard consistently', () => {
    const rows = findMatches(db, G, ALICE, 0, 10);
    const bob = rows.find((r) => r.userId === BOB);
    expect(bob).toBeDefined();
    // alice 5 games, bob 4, overlap {10,20,40} = 3 -> 3/(5+4-3) = 0.5
    expect(bob!.overlap).toBe(3);
    expect(bob!.jaccard).toBeCloseTo(0.5, 6);
  });

  it('finds games through the shared fold (accent- and case-insensitive)', () => {
    expect(searchGamesForAutocomplete(db, G, 'deep rock', 25).map((r) => r.appid)).toContain(10);
    expect(searchGamesForAutocomplete(db, G, 'DEEP ROCK', 25).map((r) => r.appid)).toContain(10);
  });

  it('removes refunded games on the next sync but keeps the rest', async () => {
    await syncLibrary(db, ALICE, '76561197960287930', source([g(10, 'Deep Rock Galactic', 24800)]));
    const rows = listGames(db, ALICE, 0, 100, 0);
    expect(rows.map((r) => r.appid)).toEqual([10]);
    expect(rows[0]!.playtime).toBe(24800); // playtime still updated
  });

  it('wipes the old library when relinking to a different Steam account', async () => {
    linkSteam(db, ALICE, '76561197960287999');
    expect(listGames(db, ALICE, 0, 100, 0)).toEqual([]);
    await syncLibrary(db, ALICE, '76561197960287999', source([g(80, 'Hades', 3240)]));
    expect(listGames(db, ALICE, 0, 100, 0).map((r) => r.appid)).toEqual([80]);
  });

  it('keeps the last good snapshot when a sync fails', async () => {
    const before = listGames(db, ALICE, 0, 100, 0);
    await syncLibrary(db, ALICE, '76561197960287930', {
      async fetchLibrary() { throw new Error('steam is down'); },
    });
    expect(listGames(db, ALICE, 0, 100, 0)).toEqual(before);
  });

  it('stores nothing for a private profile', async () => {
    ensureUser(db, 'U_priv');
    setOptedIn(db, 'U_priv', true);
    touchGuildMember(db, G, 'U_priv');
    linkSteam(db, 'U_priv', '76561197960288000');
    const out = await syncLibrary(db, 'U_priv', '76561197960288000', source([], 'private'));
    expect(out.state).toBe('private');
    expect(listGames(db, 'U_priv', 0, 100, 0)).toEqual([]);
  });
});

describe('embeds stay inside Discord limits on real query output', () => {
  const within = (e: { toJSON(): any }) => {
    const j = e.toJSON();
    const total =
      (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text?.length ?? 0) +
      (j.fields ?? []).reduce((s: number, f: any) => s + f.name.length + f.value.length, 0);
    expect(j.description?.length ?? 0).toBeLessThanOrEqual(LIMITS.description);
    expect((j.fields ?? []).length).toBeLessThanOrEqual(25);
    expect(total).toBeLessThanOrEqual(6000);
  };

  it('renders every list-shaped embed within limits', () => {
    within(libraryEmbed({
      displayName: 'artur', pageRows: listGames(db, ALICE, 0, 100, 0), offset: 0,
      page: 0, pages: 1, matching: 5, matchingMinutes: 47881, ownedTotal: 5,
      filter: 30, syncedAgo: '2 h',
    }));
    within(sharedEmbed({
      meName: 'artur', themName: 'bob', pageRows: sharedGames(db, G, ALICE, BOB, 0),
      offset: 0, page: 0, pages: 1, total: 3, myLibrarySize: 5, theirLibrarySize: 4, filter: 0,
    }));
    within(whoEmbed({
      appid: 10, name: 'Deep Rock Galactic', owners: whoOwns(db, G, 10, 0, 25),
      filter: 0, iconUrl: null, storeUrl: 'https://store.steampowered.com/app/10/',
    }));
    within(matchEmbed({
      displayName: 'artur', pageRows: findMatches(db, G, ALICE, 0, 25), offset: 0,
      page: 0, pages: 1, memberCount: 3, filter: 0, sort: 'overlap',
    }));
  });

  it('survives a hostile game name without breaking the embed', async () => {
    await join('U_evil', '76561197960288111', [
      g(900, '**__x__**'.repeat(200), 5000),
      g(901, 'RTL‮Override', 4000),
    ]);
    within(libraryEmbed({
      displayName: 'evil', pageRows: listGames(db, 'U_evil', 0, 100, 0), offset: 0,
      page: 0, pages: 1, matching: 2, matchingMinutes: 9000, ownedTotal: 2,
      filter: 0, syncedAgo: null,
    }));
  });
});

describe('scale', () => {
  it('syncs a 5000-game library and paginates it', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => g(100000 + i, `Game ${i}`, i + 1));
    ensureUser(db, 'U_big');
    setOptedIn(db, 'U_big', true);
    touchGuildMember(db, G, 'U_big');
    linkSteam(db, 'U_big', '76561197960288222');
    const out = await syncLibrary(db, 'U_big', '76561197960288222', source(many));
    expect(out.written).toBe(5000);
    // playtime i+1, so exactly 4970 games have MORE than 30 minutes
    expect(listGames(db, 'U_big', 30, 10000, 0)).toHaveLength(4970);
    expect(listGames(db, 'U_big', 30, 15, 0)).toHaveLength(15);
  });

  it('deletes thousands of refunded rows without hitting a parameter limit', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => g(200000 + i, `T ${i}`, 100));
    ensureUser(db, 'U_ref');
    setOptedIn(db, 'U_ref', true);
    linkSteam(db, 'U_ref', '76561197960288333');
    await syncLibrary(db, 'U_ref', '76561197960288333', source(many));
    const out = await syncLibrary(db, 'U_ref', '76561197960288333', source([many[0]!]));
    expect(out.removed).toBe(2999);
    expect(listGames(db, 'U_ref', 0, 10, 0)).toHaveLength(1);
  });
});

describe('sync never destroys a good snapshot', () => {
  const ID = '76561197960287930';

  it('keeps real playtimes when Steam starts hiding them', async () => {
    // "Always keep my total playtime private" returns the game list with every
    // playtime zeroed. Writing that would silently destroy known playtimes.
    const before = listGames(db, ALICE, -1, 100, 0);
    expect(before.find((r) => r.appid === 10)!.playtime).toBe(24720);

    const zeroed = before.map((r) => g(r.appid, r.name, 0));
    const out = await syncLibrary(db, ALICE, ID, source(zeroed, 'playtime_hidden'));

    expect(out.state).toBe('playtime_hidden');
    expect(listGames(db, ALICE, -1, 100, 0)).toEqual(before);
  });

  it('requires two consecutive empty answers before wiping a library', async () => {
    const before = listGames(db, ALICE, -1, 100, 0);
    expect(before.length).toBeGreaterThan(0);

    // One malformed/empty answer must not delete anything.
    const first = await syncLibrary(db, ALICE, ID, source([], 'empty'));
    expect(first.removed).toBe(0);
    expect(listGames(db, ALICE, -1, 100, 0)).toEqual(before);

    // A genuine full refund confirms on the next sync, so the data can still go.
    await syncLibrary(db, ALICE, ID, source([], 'empty'));
    expect(listGames(db, ALICE, -1, 100, 0)).toEqual([]);
  });

  it('a transient failure keeps the last known good profile_state', async () => {
    await syncLibrary(db, ALICE, ID, {
      async fetchLibrary() { throw new Error('socket hang up'); },
    });
    const row = db
      .prepare('SELECT profile_state, fail_count, last_error FROM steam_accounts WHERE user_id = ?')
      .get(ALICE) as { profile_state: string; fail_count: number; last_error: string };
    expect(row.profile_state).toBe('public');
    expect(row.fail_count).toBe(1);
    expect(row.last_error).toContain('socket hang up');
  });
});
