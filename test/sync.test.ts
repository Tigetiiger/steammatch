/**
 * Coverage for src/steam/sync.ts: the library snapshot writer.
 *
 * Everything here runs against the real schema in an in-memory database and a
 * stubbed LibrarySource -- no network, no fake timers (`now` is injectable).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/db/index.js';
import { ensureUser, linkSteam, setOptedIn } from '../src/db/queries.js';
import {
  headerUrl,
  iconUrl,
  storeUrl,
  syncLibrary,
  type LibrarySource,
} from '../src/steam/sync.js';
import type { LibraryResult, OwnedGame, ProfileState } from '../src/types.js';

const USER = 'user-1';
const ID64 = '76561197960287930';
const NOW = 1_800_000_000;
const HOUR = 3600;

let db: Database.Database;

const game = (appid: number, name: string, mins: number, recent = 0): OwnedGame => ({
  appid,
  name,
  playtimeForever: mins,
  playtime2Weeks: recent,
  iconHash: '',
});

/** A source that always answers with the given library. */
const source = (
  games: OwnedGame[],
  state: ProfileState = 'public',
  personaName: string | null = 'Persona',
): LibrarySource => ({
  async fetchLibrary(): Promise<LibraryResult> {
    return { state, personaName, avatarUrl: null, games };
  },
});

const throwingSource = (message = 'ETIMEDOUT'): LibrarySource => ({
  async fetchLibrary(): Promise<LibraryResult> {
    throw new Error(message);
  },
});

interface UserGameRow {
  appid: number;
  playtime_forever: number;
  playtime_2weeks: number;
  updated_at: number;
}

function userGames(user = USER): UserGameRow[] {
  return db
    .prepare(
      'SELECT appid, playtime_forever, playtime_2weeks, updated_at FROM user_games WHERE user_id = ? ORDER BY appid',
    )
    .all(user) as UserGameRow[];
}

interface AccountRow {
  persona_name: string | null;
  profile_state: string;
  last_synced_at: number | null;
  stale_after: number | null;
  last_error: string | null;
  fail_count: number;
}

function account(id64 = ID64): AccountRow {
  return db.prepare('SELECT * FROM steam_accounts WHERE steam_id64 = ?').get(id64) as AccountRow;
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  ensureUser(db, USER);
  setOptedIn(db, USER, true);
  const linked = linkSteam(db, USER, ID64);
  expect(linked.ok).toBe(true);
});

describe('syncLibrary: first write', () => {
  it('inserts games and user_games, storing playtime in minutes unchanged', async () => {
    const out = await syncLibrary(
      db,
      USER,
      ID64,
      source([game(10, 'Counter-Strike', 4321, 90), game(20, 'Portal', 0)]),
      NOW,
    );

    expect(out).toMatchObject({ state: 'public', written: 2, removed: 0, failCount: 0, error: null });
    expect(userGames()).toEqual([
      { appid: 10, playtime_forever: 4321, playtime_2weeks: 90, updated_at: NOW },
      { appid: 20, playtime_forever: 0, playtime_2weeks: 0, updated_at: NOW },
    ]);
    // 4321 minutes is 72.0h -- if anything converted units this would not survive.
    expect(
      db.prepare('SELECT name, name_folded FROM games WHERE appid = 10').get(),
    ).toEqual({ name: 'Counter-Strike', name_folded: 'counter-strike' });
  });

  it('records persona_name and profile_state on the steam account', async () => {
    await syncLibrary(db, USER, ID64, source([game(10, 'A', 1)], 'playtime_hidden', 'Gabe N'), NOW);

    expect(account()).toMatchObject({
      persona_name: 'Gabe N',
      profile_state: 'playtime_hidden',
      last_synced_at: NOW,
      last_error: null,
      fail_count: 0,
    });
  });
});

describe('syncLibrary: second write', () => {
  it('updates playtimes that changed and leaves the rest alone', async () => {
    await syncLibrary(db, USER, ID64, source([game(10, 'A', 100), game(20, 'B', 5)]), NOW);
    const out = await syncLibrary(
      db,
      USER,
      ID64,
      source([game(10, 'A', 175, 75), game(20, 'B', 5)]),
      NOW + HOUR,
    );

    expect(out).toMatchObject({ written: 2, removed: 0 });
    expect(userGames()).toEqual([
      { appid: 10, playtime_forever: 175, playtime_2weeks: 75, updated_at: NOW + HOUR },
      { appid: 20, playtime_forever: 5, playtime_2weeks: 0, updated_at: NOW + HOUR },
    ]);
  });

  it('deletes appids missing from the new response and keeps the ones present', async () => {
    await syncLibrary(
      db,
      USER,
      ID64,
      source([game(10, 'Kept', 10), game(20, 'Refunded', 20), game(30, 'AlsoKept', 30)]),
      NOW,
    );

    const out = await syncLibrary(
      db,
      USER,
      ID64,
      source([game(10, 'Kept', 10), game(30, 'AlsoKept', 31)]),
      NOW + HOUR,
    );

    expect(out).toMatchObject({ written: 2, removed: 1 });
    expect(userGames().map((r) => r.appid)).toEqual([10, 30]);
    // The games catalogue row survives the refund; only ownership is dropped.
    expect(db.prepare('SELECT COUNT(*) AS n FROM games').get()).toEqual({ n: 3 });
  });

  it('handles a huge library and a mass refund without hitting the SQLite parameter limit', async () => {
    // 33000 > SQLITE_MAX_VARIABLE_NUMBER (32766), so a `NOT IN (?,?,...)` delete
    // would throw "too many SQL variables" here. The temp staging table must not.
    const N = 33_000;
    const big = Array.from({ length: N }, (_, i) => game(1000 + i, `Game ${i}`, i));
    const first = await syncLibrary(db, USER, ID64, source(big), NOW);
    expect(first.written).toBe(N);
    expect(userGames()).toHaveLength(N);

    const survivors = big.slice(0, 3);
    const second = await syncLibrary(db, USER, ID64, source(survivors), NOW + HOUR);

    expect(second).toMatchObject({ written: 3, removed: N - 3 });
    expect(userGames().map((r) => r.appid)).toEqual([1000, 1001, 1002]);
  });

  it('is idempotent for a repeated identical response', async () => {
    const lib = [game(10, 'A', 10), game(20, 'B', 20)];
    await syncLibrary(db, USER, ID64, source(lib), NOW);
    const out = await syncLibrary(db, USER, ID64, source(lib), NOW + 60);

    expect(out.removed).toBe(0);
    expect(userGames().map((r) => r.appid)).toEqual([10, 20]);
  });
});

describe('syncLibrary: freshness windows', () => {
  it('gives a public profile a 6h stale_after', async () => {
    const out = await syncLibrary(db, USER, ID64, source([game(10, 'A', 1)]), NOW);
    expect(out.staleAfter).toBe(NOW + 6 * HOUR);
    expect(account().stale_after).toBe(NOW + 6 * HOUR);
  });

  it('backs a private profile off to 24h', async () => {
    const out = await syncLibrary(db, USER, ID64, source([], 'private'), NOW);
    expect(out.staleAfter).toBe(NOW + 24 * HOUR);
    expect(account().stale_after).toBe(NOW + 24 * HOUR);
  });

  it('backs a game_details_private profile off to 24h', async () => {
    const out = await syncLibrary(db, USER, ID64, source([], 'game_details_private'), NOW);
    expect(out.staleAfter).toBe(NOW + 24 * HOUR);
    expect(account().stale_after).toBe(NOW + 24 * HOUR);
  });
});

describe('syncLibrary: failures', () => {
  it('leaves the previous snapshot completely intact when the source throws', async () => {
    await syncLibrary(db, USER, ID64, source([game(10, 'A', 10), game(20, 'B', 20)]), NOW);
    const before = userGames();

    const out = await syncLibrary(db, USER, ID64, throwingSource('socket hang up'), NOW + HOUR);

    expect(out).toMatchObject({ state: 'error', written: 0, removed: 0, failCount: 1 });
    expect(out.error).toBe('socket hang up');
    expect(userGames()).toEqual(before);
    expect(account()).toMatchObject({
      // profile_state keeps the last KNOWN GOOD value. A transient fetch failure
      // does not mean the profile is broken, and callers need to tell those
      // apart -- fail_count and last_error carry the failure instead.
      profile_state: 'public',
      last_error: 'socket hang up',
      fail_count: 1,
      // A failure must not claim the library was re-synced.
      last_synced_at: NOW,
    });
  });

  it("writes nothing to user_games for state 'error'", async () => {
    await syncLibrary(db, USER, ID64, source([game(10, 'A', 10)]), NOW);
    const out = await syncLibrary(db, USER, ID64, source([game(99, 'Ghost', 1)], 'error'), NOW + HOUR);

    expect(out).toMatchObject({ state: 'error', written: 0, removed: 0, failCount: 1 });
    expect(userGames().map((r) => r.appid)).toEqual([10]);
    expect(account().last_error).toBe('Steam API request failed');
  });

  it('backs consecutive failures off 6h, 12h, 24h, 24h', async () => {
    const src = throwingSource();
    const seen: Array<{ failCount: number; hours: number }> = [];
    for (let i = 0; i < 4; i++) {
      const out = await syncLibrary(db, USER, ID64, src, NOW);
      seen.push({ failCount: out.failCount, hours: (out.staleAfter - NOW) / HOUR });
    }

    expect(seen).toEqual([
      { failCount: 1, hours: 6 },
      { failCount: 2, hours: 12 },
      { failCount: 3, hours: 24 },
      { failCount: 4, hours: 24 },
    ]);
    expect(account().fail_count).toBe(4);
  });

  it('resets fail_count and clears last_error on the next success', async () => {
    await syncLibrary(db, USER, ID64, throwingSource(), NOW);
    await syncLibrary(db, USER, ID64, throwingSource(), NOW);
    expect(account().fail_count).toBe(2);

    await syncLibrary(db, USER, ID64, source([game(10, 'A', 10)]), NOW + HOUR);

    expect(account()).toMatchObject({
      fail_count: 0,
      last_error: null,
      profile_state: 'public',
      last_synced_at: NOW + HOUR,
    });
  });

  it('truncates a very long error message to fit the column', async () => {
    await syncLibrary(db, USER, ID64, throwingSource('x'.repeat(900)), NOW);
    expect(account().last_error).toHaveLength(500);
  });
});

describe("syncLibrary: state 'empty' regression guard", () => {
  it('does NOT delete an existing library when Steam answers empty', async () => {
    await syncLibrary(db, USER, ID64, source([game(10, 'A', 10), game(20, 'B', 20)]), NOW);
    const before = userGames();

    const out = await syncLibrary(db, USER, ID64, source([], 'empty'), NOW + HOUR);

    // The snapshot is what matters: a malformed "empty" response once wiped users.
    expect(userGames()).toEqual(before);
    expect(out).toMatchObject({ state: 'empty', written: 0, removed: 0 });
    // The account is still marked synced, so we do not hammer Steam over it.
    expect(account()).toMatchObject({ profile_state: 'empty', last_synced_at: NOW + HOUR });
  });

  it('accepts an empty library for a user who genuinely has none', async () => {
    const out = await syncLibrary(db, USER, ID64, source([], 'empty'), NOW);
    expect(out).toMatchObject({ state: 'empty', written: 0, removed: 0 });
    expect(userGames()).toEqual([]);
  });
});

describe('syncLibrary: input hardening', () => {
  it('ignores duplicate appids in one response and counts each once', async () => {
    const out = await syncLibrary(
      db,
      USER,
      ID64,
      source([game(10, 'A', 10), game(10, 'A again', 999)]),
      NOW,
    );

    expect(out.written).toBe(1);
    expect(userGames()).toEqual([
      { appid: 10, playtime_forever: 10, playtime_2weeks: 0, updated_at: NOW },
    ]);
  });

  it('clamps negative and fractional playtimes to non-negative integers', async () => {
    await syncLibrary(
      db,
      USER,
      ID64,
      source([
        { appid: 10, name: 'A', playtimeForever: -5, playtime2Weeks: 12.9, iconHash: '' },
      ]),
      NOW,
    );

    expect(userGames()[0]).toMatchObject({ playtime_forever: 0, playtime_2weeks: 12 });
  });

  it('falls back to "App <id>" when the name sanitises to nothing', async () => {
    await syncLibrary(db, USER, ID64, source([game(77, '​ ​', 1)]), NOW);
    expect(db.prepare('SELECT name FROM games WHERE appid = 77').get()).toEqual({ name: 'App 77' });
  });
});

describe('URL helpers', () => {
  it('returns null rather than a URL built from an empty icon hash', () => {
    expect(iconUrl(440, '')).toBeNull();
  });

  it('builds the community icon URL from appid and hash', () => {
    expect(iconUrl(440, 'abc123')).toBe(
      'https://media.steampowered.com/steamcommunity/public/images/apps/440/abc123.jpg',
    );
  });

  it('builds header and store URLs from the appid', () => {
    expect(headerUrl(440)).toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg',
    );
    expect(storeUrl(440)).toBe('https://store.steampowered.com/app/440');
  });
});
