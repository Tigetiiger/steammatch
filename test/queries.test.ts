import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/db/index.js';
import {
  ensureUser,
  findMatches,
  isVisibleInGuild,
  setHiddenGames,
  forget,
  getGuildMinPlaytime,
  leaderboard,
  linkSteam,
  listGames,
  searchGamesForAutocomplete,
  setDiscoverable,
  setGuildVisible,
  setOptedIn,
  sharedGames,
  touchGuildMember,
  unlink,
  whoOwns,
} from '../src/db/queries.js';
import { DEFAULT_MIN_PLAYTIME } from '../src/types.js';

/* ------------------------------------------------------------------ *
 * Fixture
 *
 * Two guilds, six users, deliberately awkward:
 *   alice  - normal, in BOTH guilds
 *   bob    - normal in G1, HIDDEN in G2 (visible = 0)
 *   frank  - normal, G1 only, small library
 *   carol  - OPTED OUT, G1, huge playtimes so any leak is obvious
 *   dave   - SOFT DELETED, G1, huge playtimes for the same reason
 *   erin   - normal, G2 only -- proves G1 queries never see her
 *
 * Playtimes are chosen so that 30 (excluded at minPlaytime=30) and 31
 * (included) sit right on the strict-`>` boundary.
 * ------------------------------------------------------------------ */

const G1 = 'guild-1';
const G2 = 'guild-2';

const ALICE = 'U_alice';
const BOB = 'U_bob';
const CAROL = 'U_carol';
const DAVE = 'U_dave';
const ERIN = 'U_erin';
const FRANK = 'U_frank';

const ALPHA = 10;
const BETA = 20;
const GAMMA = 30;
const DELTA = 40;
const OJ = 50; // "100% Orange Juice" -- literal % in the name
const SUNSETS = 60; // "1000 Sunsets"    -- would match a naive "100%" LIKE
const EPSILON = 70;
const ZETA = 80;
const CAROL_ONLY = 90;
const HALF_LIFE = 100; // "Half_Life"  -- literal _ in the name
const HALFALIFE = 110; // "HalfaLife"  -- would match a naive "half_life" LIKE

type DB = Database.Database;

function seed(): DB {
  const db = new Database(':memory:');
  applySchema(db);

  const user = db.prepare(
    'INSERT INTO users (user_id, opted_in, discoverable, deleted_at) VALUES (?, ?, ?, ?)',
  );
  user.run(ALICE, 1, 1, null);
  user.run(BOB, 1, 1, null);
  user.run(FRANK, 1, 1, null);
  user.run(CAROL, 0, 1, null); // opted out
  user.run(DAVE, 1, 1, 1700000000); // soft deleted
  user.run(ERIN, 1, 1, null);

  const member = db.prepare(
    'INSERT INTO guild_members (guild_id, user_id, visible) VALUES (?, ?, ?)',
  );
  member.run(G1, ALICE, 1);
  member.run(G1, BOB, 1);
  member.run(G1, FRANK, 1);
  member.run(G1, CAROL, 1);
  member.run(G1, DAVE, 1);
  member.run(G2, ALICE, 1);
  member.run(G2, BOB, 0); // same user, hidden here but visible in G1
  member.run(G2, ERIN, 1);

  const game = db.prepare('INSERT INTO games (appid, name, name_folded) VALUES (?, ?, ?)');
  game.run(ALPHA, 'Alpha', 'alpha');
  game.run(BETA, 'Beta', 'beta');
  game.run(GAMMA, 'Gamma', 'gamma');
  game.run(DELTA, 'Delta', 'delta');
  game.run(OJ, '100% Orange Juice', '100% orange juice');
  game.run(SUNSETS, '1000 Sunsets', '1000 sunsets');
  game.run(EPSILON, 'Epsilon', 'epsilon');
  game.run(ZETA, 'Zeta', 'zeta');
  game.run(CAROL_ONLY, 'Carol Only Game', 'carol only game');
  game.run(HALF_LIFE, 'Half_Life', 'half_life');
  game.run(HALFALIFE, 'HalfaLife', 'halfalife');

  const own = db.prepare(
    'INSERT INTO user_games (user_id, appid, playtime_forever) VALUES (?, ?, ?)',
  );
  // alice
  own.run(ALICE, ALPHA, 1000);
  own.run(ALICE, BETA, 700);
  own.run(ALICE, GAMMA, 30); // exactly at the boundary
  own.run(ALICE, DELTA, 31); // one minute over it
  own.run(ALICE, OJ, 500);
  own.run(ALICE, SUNSETS, 100);
  // zero-playtime entries: invisible to every threshold query (0 > 0 is false)
  // but still real ownership, so autocomplete can find them.
  own.run(ALICE, HALF_LIFE, 0);
  own.run(ALICE, HALFALIFE, 0);
  // bob
  own.run(BOB, ALPHA, 800);
  own.run(BOB, BETA, 20);
  own.run(BOB, DELTA, 900);
  own.run(BOB, OJ, 50);
  own.run(BOB, EPSILON, 600);
  // frank
  own.run(FRANK, ALPHA, 400);
  own.run(FRANK, BETA, 300);
  own.run(FRANK, GAMMA, 200);
  own.run(FRANK, ZETA, 50);
  // carol (opted out) -- would top every chart if she leaked
  own.run(CAROL, ALPHA, 5000);
  own.run(CAROL, BETA, 5000);
  own.run(CAROL, GAMMA, 5000);
  own.run(CAROL, DELTA, 5000);
  own.run(CAROL, CAROL_ONLY, 5000);
  // dave (soft deleted) -- likewise
  own.run(DAVE, ALPHA, 4000);
  own.run(DAVE, BETA, 4000);
  own.run(DAVE, DELTA, 4000);
  own.run(DAVE, OJ, 4000);
  // erin (guild 2 only)
  own.run(ERIN, ALPHA, 3000);
  own.run(ERIN, BETA, 3000);
  own.run(ERIN, DELTA, 3000);
  own.run(ERIN, OJ, 3000);

  db.prepare('INSERT INTO guild_settings (guild_id, default_min_playtime) VALUES (?, ?)').run(
    G1,
    45,
  );

  return db;
}

let db: DB;
beforeEach(() => {
  db = seed();
});

const ids = (rows: { appid: number }[]): number[] => rows.map((r) => r.appid);
const users = (rows: { userId: string }[]): string[] => rows.map((r) => r.userId);

/* ------------------------------------------------------------------ */

describe('listGames', () => {
  it('returns the caller library, playtime DESC, at threshold 0', () => {
    expect(ids(listGames(db, ALICE, 0, 100, 0))).toEqual([
      ALPHA, // 1000
      BETA, // 700
      OJ, // 500
      SUNSETS, // 100
      DELTA, // 31
      GAMMA, // 30
    ]);
  });

  it('applies the threshold strictly at 30 and at 600', () => {
    expect(ids(listGames(db, ALICE, 30, 100, 0))).toEqual([ALPHA, BETA, OJ, SUNSETS, DELTA]);
    expect(ids(listGames(db, ALICE, 600, 100, 0))).toEqual([ALPHA, BETA]);
  });

  it('honours limit and offset', () => {
    expect(ids(listGames(db, ALICE, 0, 2, 1))).toEqual([BETA, OJ]);
  });

  it('still shows opted-out, hidden and deleted users their OWN library', () => {
    // These three are invisible to everyone else (asserted below) but must
    // never be locked out of their own data.
    expect(listGames(db, CAROL, 0, 100, 0)).toHaveLength(5);
    expect(listGames(db, DAVE, 0, 100, 0)).toHaveLength(4);
    expect(ids(listGames(db, BOB, 30, 100, 0))).toEqual([DELTA, ALPHA, EPSILON, OJ]);
  });
});

describe('minPlaytime boundary', () => {
  it('excludes a 30-minute game at minPlaytime=30 and includes a 31-minute one', () => {
    const at29 = ids(listGames(db, ALICE, 29, 100, 0));
    expect(at29).toContain(GAMMA);
    expect(at29).toContain(DELTA);

    const at30 = ids(listGames(db, ALICE, 30, 100, 0));
    expect(at30).not.toContain(GAMMA); // 30 is NOT more than 30
    expect(at30).toContain(DELTA); // 31 is

    const at31 = ids(listGames(db, ALICE, 31, 100, 0));
    expect(at31).not.toContain(DELTA); // and 31 is not more than 31
  });

  it('applies the boundary on both sides of sharedGames', () => {
    // frank has Gamma at 200, alice at exactly 30.
    expect(ids(sharedGames(db, G1, ALICE, FRANK, 29))).toContain(GAMMA);
    expect(ids(sharedGames(db, G1, ALICE, FRANK, 30))).not.toContain(GAMMA);
  });

  it('applies the boundary in whoOwns and leaderboard', () => {
    expect(users(whoOwns(db, G1, GAMMA, 29, 10))).toEqual([FRANK, ALICE]); // 200, 30
    expect(users(whoOwns(db, G1, GAMMA, 30, 10))).toEqual([FRANK]);

    const board29 = leaderboard(db, G1, 29, 2, 50).find((r) => r.appid === GAMMA);
    expect(board29?.owners).toBe(2);
    expect(leaderboard(db, G1, 30, 2, 50).some((r) => r.appid === GAMMA)).toBe(false);
  });
});

describe('sharedGames', () => {
  it('orders by the weaker link, MIN(mine, theirs)', () => {
    // alice/bob overlap at threshold 0: Alpha min 800, OJ min 50, Delta min 31, Beta min 20.
    expect(ids(sharedGames(db, G1, ALICE, BOB, 0))).toEqual([ALPHA, OJ, DELTA, BETA]);
  });

  it('applies the threshold to BOTH sides', () => {
    // Beta drops out at 30 because BOB has 20 minutes, even though alice has 700.
    const rows = sharedGames(db, G1, ALICE, BOB, 30);
    expect(ids(rows)).toEqual([ALPHA, OJ, DELTA]);
    expect(rows[0]).toMatchObject({ appid: ALPHA, mine: 1000, theirs: 800 });

    expect(ids(sharedGames(db, G1, ALICE, BOB, 600))).toEqual([ALPHA]);
  });

  it('refuses to expose an ineligible user', () => {
    expect(sharedGames(db, G1, ALICE, CAROL, 0)).toEqual([]); // opted out
    expect(sharedGames(db, G1, ALICE, DAVE, 0)).toEqual([]); // soft deleted
  });

  it('is scoped per guild for a user hidden in one but visible in another', () => {
    // bob is visible in G1 and hidden in G2. Asking from G1 works; asking from
    // G2 must reveal nothing, even though he is eligible elsewhere.
    expect(sharedGames(db, G1, ALICE, BOB, 0).length).toBeGreaterThan(0);
    expect(sharedGames(db, G2, ALICE, BOB, 0)).toEqual([]);
  });

  it('refuses a user who is not a member of the calling guild at all', () => {
    // erin is in G2 only; a G1 caller must not be able to compare against her.
    expect(sharedGames(db, G1, ALICE, ERIN, 0)).toEqual([]);
  });
});

describe('whoOwns', () => {
  it('lists eligible owners playtime DESC at each threshold', () => {
    expect(whoOwns(db, G1, ALPHA, 0, 10)).toEqual([
      { userId: ALICE, playtime: 1000, personaName: null, addedBy: null },
      { userId: BOB, playtime: 800, personaName: null, addedBy: null },
      { userId: FRANK, playtime: 400, personaName: null, addedBy: null },
    ]);
    expect(users(whoOwns(db, G1, ALPHA, 30, 10))).toEqual([ALICE, BOB, FRANK]);
    expect(users(whoOwns(db, G1, ALPHA, 600, 10))).toEqual([ALICE, BOB]);
  });

  it('never exposes opted-out, hidden or deleted users', () => {
    const owners = users(whoOwns(db, G1, ALPHA, 0, 50));
    expect(owners).not.toContain(CAROL);
    expect(owners).not.toContain(DAVE);
    expect(whoOwns(db, G1, CAROL_ONLY, 0, 50)).toEqual([]);

    // bob is hidden in G2 only.
    expect(users(whoOwns(db, G2, ALPHA, 0, 50))).toEqual([ERIN, ALICE]);
    expect(users(whoOwns(db, G2, ALPHA, 0, 50))).not.toContain(BOB);
  });

  it('is guild scoped: guild 2 members never leak into guild 1', () => {
    expect(users(whoOwns(db, G1, ALPHA, 0, 50))).not.toContain(ERIN);
    expect(users(whoOwns(db, G2, ALPHA, 0, 50))).not.toContain(FRANK);
  });

  it('honours the limit', () => {
    expect(whoOwns(db, G1, ALPHA, 0, 1)).toEqual([
      { userId: ALICE, playtime: 1000, personaName: null, addedBy: null },
    ]);
  });
});

describe('leaderboard', () => {
  it('ranks by owners then total guild minutes at threshold 30', () => {
    expect(leaderboard(db, G1, 30, 2, 10)).toEqual([
      { appid: ALPHA, name: 'Alpha', owners: 3, guildMinutes: 2200 },
      { appid: BETA, name: 'Beta', owners: 2, guildMinutes: 1000 },
      { appid: DELTA, name: 'Delta', owners: 2, guildMinutes: 931 },
      { appid: OJ, name: '100% Orange Juice', owners: 2, guildMinutes: 550 },
    ]);
  });

  it('applies minOwners inclusively and the threshold strictly', () => {
    expect(ids(leaderboard(db, G1, 30, 3, 10))).toEqual([ALPHA]);
    // At 0, Beta picks up bob's 20 minutes -> 3 owners, 1020 minutes.
    expect(leaderboard(db, G1, 0, 3, 10)).toEqual([
      { appid: ALPHA, name: 'Alpha', owners: 3, guildMinutes: 2200 },
      { appid: BETA, name: 'Beta', owners: 3, guildMinutes: 1020 },
    ]);
    // At 600 only Alpha survives with 2 owners (alice 1000, bob 800).
    expect(leaderboard(db, G1, 600, 2, 10)).toEqual([
      { appid: ALPHA, name: 'Alpha', owners: 2, guildMinutes: 1800 },
    ]);
  });

  it('counts nobody who is opted out, hidden or deleted', () => {
    // If carol or dave counted, Alpha would have 4-5 owners and vastly more minutes.
    const alpha = leaderboard(db, G1, 0, 1, 50).find((r) => r.appid === ALPHA);
    expect(alpha).toEqual({ appid: ALPHA, name: 'Alpha', owners: 3, guildMinutes: 2200 });
    expect(leaderboard(db, G1, 0, 1, 50).some((r) => r.appid === CAROL_ONLY)).toBe(false);
  });

  it('is guild scoped', () => {
    // G2 eligibles are alice + erin only (bob is hidden there, frank is not a member).
    expect(leaderboard(db, G2, 30, 2, 10)).toEqual([
      { appid: ALPHA, name: 'Alpha', owners: 2, guildMinutes: 4000 },
      { appid: BETA, name: 'Beta', owners: 2, guildMinutes: 3700 },
      { appid: OJ, name: '100% Orange Juice', owners: 2, guildMinutes: 3500 },
      { appid: DELTA, name: 'Delta', owners: 2, guildMinutes: 3031 },
    ]);
    expect(leaderboard(db, G2, 30, 1, 50).some((r) => r.appid === ZETA)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Leaderboard from one person's point of view
 *
 * The subject used to be the caller and only the caller, so nothing ever had
 * to check whether the subject was allowed to be looked at. Now that anyone
 * can be named, that check is the whole point of these tests.
 * ------------------------------------------------------------------ */

describe("leaderboard from a named person's point of view", () => {
  it('ranks only that person\'s games, counting everyone who shares them', () => {
    // Bob has ALPHA, BETA, DELTA, OJ, EPSILON. EPSILON is his alone, so it
    // fails minOwners; the rest are ranked by how many people here share them.
    const board = leaderboard(db, G1, 0, 2, 50, BOB, ALICE);
    expect(ids(board)).toEqual([ALPHA, BETA, DELTA, OJ]);
    // Counts include Bob himself: three people have ALPHA above 0.
    expect(board.find((r) => r.appid === ALPHA)?.owners).toBe(3);
    // FRANK has GAMMA and ZETA, which Bob does not, so they are absent.
    expect(ids(board)).not.toContain(GAMMA);
    expect(ids(board)).not.toContain(ZETA);
  });

  it('is not the same board as the whole guild\'s', () => {
    const guildBoard = ids(leaderboard(db, G1, 0, 2, 50));
    const franksBoard = ids(leaderboard(db, G1, 0, 2, 50, FRANK, ALICE));
    expect(guildBoard).toContain(GAMMA);
    expect(franksBoard).toContain(GAMMA);
    // Frank does not own EPSILON or OJ, so his board cannot show them.
    expect(franksBoard).not.toContain(EPSILON);
    expect(franksBoard).not.toContain(OJ);
    expect(guildBoard).not.toEqual(franksBoard);
  });

  it('refuses a subject who is opted out, deleted, or hidden in this guild', () => {
    // Carol has huge playtimes on every game; if the guard failed her library
    // would be readable through the board by anyone who typed her name.
    expect(leaderboard(db, G1, 0, 1, 50, CAROL, ALICE)).toEqual([]);
    expect(leaderboard(db, G1, 0, 1, 50, DAVE, ALICE)).toEqual([]);
    // Bob is visible in G1 but hidden in G2. Naming him from G2 must fail even
    // though the exact same call from G1 succeeds.
    expect(leaderboard(db, G2, 0, 1, 50, BOB, ALICE)).toEqual([]);
    expect(leaderboard(db, G1, 0, 1, 50, BOB, ALICE).length).toBeGreaterThan(0);
  });

  it('still lets you see your OWN board while hidden', () => {
    // Hiding yourself from other people must not hide you from yourself --
    // the same carve-out listGames() has.
    expect(leaderboard(db, G2, 0, 1, 50, BOB, BOB).length).toBeGreaterThan(0);
    // ...and that carve-out is keyed on the viewer, so it does not help ALICE.
    expect(leaderboard(db, G2, 0, 1, 50, BOB, ALICE)).toEqual([]);
  });

  it('defaults to refusing when no viewer is supplied', () => {
    // A caller that forgets the viewer gets the safe answer, not the leaky one.
    expect(leaderboard(db, G2, 0, 1, 50, BOB)).toEqual([]);
  });

  it('omits games the subject has hidden with /steam change', () => {
    const before = ids(leaderboard(db, G1, 0, 2, 50, BOB, ALICE));
    expect(before).toContain(ALPHA);
    setHiddenGames(db, BOB, [ALPHA]);
    const after = ids(leaderboard(db, G1, 0, 2, 50, BOB, ALICE));
    expect(after).not.toContain(ALPHA);
  });
});

describe('isVisibleInGuild', () => {
  it('agrees with the guard the leaderboard query applies', () => {
    expect(isVisibleInGuild(db, G1, BOB)).toBe(true);
    expect(isVisibleInGuild(db, G2, BOB)).toBe(false); // hidden there
    expect(isVisibleInGuild(db, G1, CAROL)).toBe(false); // opted out
    expect(isVisibleInGuild(db, G1, DAVE)).toBe(false); // soft deleted
    expect(isVisibleInGuild(db, G1, ERIN)).toBe(false); // not a member of G1
  });
});

describe('findMatches', () => {
  it('computes jaccard by hand at threshold 0', () => {
    // alice  >0 : {Alpha, Beta, Gamma, Delta, OJ, Sunsets}      -> 6
    //   (Half_Life / HalfaLife sit at 0 minutes and are not "played")
    // bob    >0 : {Alpha, Beta, Delta, OJ, Epsilon}             -> 5, overlap 4
    //   jaccard = 4 / (6 + 5 - 4) = 4/7 = 0.5714...
    // frank  >0 : {Alpha, Beta, Gamma, Zeta}                    -> 4, overlap 3
    //   jaccard = 3 / (6 + 4 - 3) = 3/7 = 0.4285...
    const rows = findMatches(db, G1, ALICE, 0, 10);
    expect(users(rows)).toEqual([BOB, FRANK]);

    expect(rows[0]).toMatchObject({ userId: BOB, overlap: 4, theirTotal: 5 });
    expect(rows[0]?.jaccard).toBeCloseTo(4 / 7, 10);

    expect(rows[1]).toMatchObject({ userId: FRANK, overlap: 3, theirTotal: 4 });
    expect(rows[1]?.jaccard).toBeCloseTo(3 / 7, 10);
  });

  it('re-computes at threshold 30 and drops matches under the overlap floor', () => {
    // alice >30 : {Alpha, Beta, Delta, OJ, Sunsets}  -> 5
    // bob   >30 : {Alpha, Delta, OJ, Epsilon}        -> 4, overlap 3 -> 3/(5+4-3) = 0.5
    // frank >30 : {Alpha, Beta, Gamma, Zeta}         -> 4, overlap 2 -> below the floor of 3
    const rows = findMatches(db, G1, ALICE, 30, 10);
    expect(users(rows)).toEqual([BOB]);
    expect(rows[0]).toMatchObject({ overlap: 3, theirTotal: 4 });
    expect(rows[0]?.jaccard).toBeCloseTo(0.5, 10);
  });

  it('returns nothing at 600 where every overlap is below the floor', () => {
    // alice >600 : {Alpha, Beta}; bob >600 : {Alpha, Delta} -> overlap 1.
    expect(findMatches(db, G1, ALICE, 600, 10)).toEqual([]);
  });

  it('excludes the caller, and every opted-out / hidden / deleted user', () => {
    const everyone = users(findMatches(db, G1, ALICE, 0, 50));
    expect(everyone).not.toContain(ALICE);
    expect(everyone).not.toContain(CAROL);
    expect(everyone).not.toContain(DAVE);
  });

  it('is guild scoped, and respects per-guild hiding', () => {
    expect(users(findMatches(db, G1, ALICE, 0, 50))).not.toContain(ERIN);
    // In G2 bob is hidden, so only erin can match.
    expect(users(findMatches(db, G2, ALICE, 0, 50))).toEqual([ERIN]);
    expect(users(findMatches(db, G2, ALICE, 0, 50))).not.toContain(BOB);
  });

  it('honours the limit', () => {
    expect(findMatches(db, G1, ALICE, 0, 1)).toHaveLength(1);
  });
});

describe('searchGamesForAutocomplete', () => {
  it('ranks matches by owner count in the guild, then name', () => {
    const rows = searchGamesForAutocomplete(db, G1, 'a');
    const alpha = rows.find((r) => r.appid === ALPHA);
    expect(alpha).toEqual({ appid: ALPHA, name: 'Alpha', owners: 3 });
    expect(rows[0]?.owners).toBeGreaterThanOrEqual(rows[rows.length - 1]?.owners ?? 0);
  });

  it('returns the most-owned games in the guild for an empty query', () => {
    const rows = searchGamesForAutocomplete(db, G1, '');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.appid).toBe(ALPHA); // 3 owners, sorts before Beta on name
    expect(rows.map((r) => r.owners)).toEqual([...rows.map((r) => r.owners)].sort((a, b) => b - a));
  });

  it('treats % in the query as a literal, not a wildcard', () => {
    // Unescaped, "100%" would LIKE-match "1000 sunsets" as well.
    const rows = searchGamesForAutocomplete(db, G1, '100%');
    expect(ids(rows)).toEqual([OJ]);

    // Sanity check that the fixture really would be ambiguous:
    expect(ids(searchGamesForAutocomplete(db, G1, '100'))).toEqual([OJ, SUNSETS]);
  });

  it('treats _ in the query as a literal, not a single-character wildcard', () => {
    expect(ids(searchGamesForAutocomplete(db, G1, 'half_life'))).toEqual([HALF_LIFE]);
    expect(ids(searchGamesForAutocomplete(db, G1, 'half'))).toEqual([HALF_LIFE, HALFALIFE]);
  });

  it('does not blow up on a lone backslash', () => {
    expect(searchGamesForAutocomplete(db, G1, '\\')).toEqual([]);
  });

  it('is case insensitive and guild scoped, and hides ineligible owners', () => {
    expect(ids(searchGamesForAutocomplete(db, G1, 'ALPHA'))).toEqual([ALPHA]);
    // Zeta is owned only by frank, who is in G1 only.
    expect(searchGamesForAutocomplete(db, G2, 'zeta')).toEqual([]);
    // Carol is opted out, so her exclusive game is not suggestible at all.
    expect(searchGamesForAutocomplete(db, G1, 'carol')).toEqual([]);
    // Epsilon is bob's alone; he is hidden in G2.
    expect(searchGamesForAutocomplete(db, G2, 'epsilon')).toEqual([]);
    expect(ids(searchGamesForAutocomplete(db, G1, 'epsilon'))).toEqual([EPSILON]);
  });

  it('honours the limit, defaulting to 25', () => {
    expect(searchGamesForAutocomplete(db, G1, '', 2)).toHaveLength(2);
    expect(searchGamesForAutocomplete(db, G1, '').length).toBeLessThanOrEqual(25);
  });
});

/* ------------------------------------------------------------------ *
 * Writes and lifecycle
 * ------------------------------------------------------------------ */

const gamesOf = (userId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM user_games WHERE user_id = ?').get(userId) as { n: number })
    .n;

const steamOf = (userId: string): string | undefined =>
  (
    db.prepare('SELECT steam_id64 AS id FROM steam_accounts WHERE user_id = ?').get(userId) as
      | { id: string }
      | undefined
  )?.id;

/** Who eligible_members currently exposes in a guild. */
const eligible = (guild: string): string[] =>
  (db.prepare('SELECT user_id FROM eligible_members WHERE guild_id = ?').all(guild) as
    { user_id: string }[]).map((r) => r.user_id);

describe('linkSteam', () => {
  it('links a fresh user', () => {
    linkSteam(db, ALICE, '76561198000000001');
    expect(steamOf(ALICE)).toBe('76561198000000001');
    expect(gamesOf(ALICE)).toBe(8); // untouched
  });

  it('WIPES the previous library when relinking to a DIFFERENT steam account', () => {
    // The sharp edge: user_games is keyed by user_id, not steam_id64. If the
    // swap did not delete the old rows, the old account's library would merge
    // into the new one on the next sync and never be attributable again.
    linkSteam(db, ALICE, '76561198000000001');
    expect(gamesOf(ALICE)).toBe(8);

    const outcome = linkSteam(db, ALICE, '76561198000000002');

    expect(outcome).toEqual({ ok: true, wiped: true });
    expect(steamOf(ALICE)).toBe('76561198000000002');
    expect(gamesOf(ALICE)).toBe(0);
    // Only alice's library is affected.
    expect(gamesOf(BOB)).toBe(5);
    // And exactly one steam_accounts row survives for her.
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM steam_accounts WHERE user_id = ?')
          .get(ALICE) as { n: number }
      ).n,
    ).toBe(1);
  });

  it('is a no-op when relinking to the SAME steam account', () => {
    linkSteam(db, ALICE, '76561198000000001');
    const outcome = linkSteam(db, ALICE, '76561198000000001');
    expect(outcome).toEqual({ ok: true, wiped: false });
    expect(gamesOf(ALICE)).toBe(8); // a repeated /link must not cost a resync
  });

  it('REFUSES to take over a steam id already claimed by another user', () => {
    // Steam IDs are public. Transferring the claim would silently unlink the
    // real owner while their frozen library kept being served to the guild.
    linkSteam(db, ALICE, '76561198000000009');
    const outcome = linkSteam(db, BOB, '76561198000000009');

    expect(outcome).toEqual({ ok: false, reason: 'claimed_by_other' });
    expect(steamOf(ALICE)).toBe('76561198000000009'); // owner keeps it
    expect(steamOf(BOB)).toBeUndefined();
    expect(gamesOf(ALICE)).toBe(8); // and keeps their library
  });

  it('re-linking your own id after forget() makes you visible again', () => {
    // forget() soft-deletes, and eligible_members requires deleted_at IS NULL.
    // Without clearing it the user is a permanent ghost: opted in, discoverable,
    // and invisible to every query.
    linkSteam(db, ALICE, '76561198000000001');
    setOptedIn(db, ALICE, true);
    forget(db, ALICE);
    expect(eligible(G1)).not.toContain(ALICE);

    linkSteam(db, ALICE, '76561198000000001');
    setOptedIn(db, ALICE, true);
    touchGuildMember(db, G1, ALICE);
    expect(eligible(G1)).toContain(ALICE);
  });

  it('creates the user row if it does not exist yet', () => {
    linkSteam(db, 'U_new', '76561198000000123');
    expect(steamOf('U_new')).toBe('76561198000000123');
  });
});

describe('unlink and forget', () => {
  it('unlink drops the steam link and the whole library, keeping settings', () => {
    linkSteam(db, ALICE, '76561198000000001');
    unlink(db, ALICE);
    expect(steamOf(ALICE)).toBeUndefined();
    expect(gamesOf(ALICE)).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE user_id = ?').get(ALICE),
    ).toEqual({ n: 2 });
  });

  it('forget also drops guild memberships and soft-deletes the user', () => {
    linkSteam(db, ALICE, '76561198000000001');
    forget(db, ALICE);

    expect(steamOf(ALICE)).toBeUndefined();
    expect(gamesOf(ALICE)).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE user_id = ?').get(ALICE),
    ).toEqual({ n: 0 });

    const row = db.prepare('SELECT deleted_at FROM users WHERE user_id = ?').get(ALICE) as {
      deleted_at: number | null;
    };
    expect(row.deleted_at).not.toBeNull();

    // And she is gone from every query that exposes other people.
    expect(users(whoOwns(db, G1, ALPHA, 0, 50))).toEqual([BOB, FRANK]);
    expect(findMatches(db, G1, BOB, 0, 50).map((r) => r.userId)).not.toContain(ALICE);
  });
});

describe('membership and flag helpers', () => {
  it('ensureUser is idempotent and does not clobber existing flags', () => {
    ensureUser(db, ALICE);
    ensureUser(db, ALICE);
    expect(db.prepare('SELECT opted_in FROM users WHERE user_id = ?').get(ALICE)).toEqual({
      opted_in: 1,
    });
  });

  it('setOptedIn removes a user from every guild-scoped query', () => {
    setOptedIn(db, BOB, false);
    expect(users(whoOwns(db, G1, ALPHA, 0, 50))).toEqual([ALICE, FRANK]);
    // ...but not from his own list.
    expect(listGames(db, BOB, 0, 50, 0).length).toBe(5);

    setOptedIn(db, CAROL, true);
    expect(users(whoOwns(db, G1, ALPHA, 0, 50))).toContain(CAROL);
  });

  it('setDiscoverable hides a user without opting them out', () => {
    setDiscoverable(db, FRANK, false);
    expect(users(whoOwns(db, G1, ALPHA, 0, 50))).toEqual([ALICE, BOB]);
    expect(db.prepare('SELECT opted_in FROM users WHERE user_id = ?').get(FRANK)).toEqual({
      opted_in: 1,
    });
  });

  it('setGuildVisible is per guild', () => {
    setGuildVisible(db, G1, BOB, false);
    expect(users(whoOwns(db, G1, ALPHA, 0, 50))).toEqual([ALICE, FRANK]);
    setGuildVisible(db, G2, BOB, true);
    expect(users(whoOwns(db, G2, ALPHA, 0, 50))).toContain(BOB);
  });

  it('touchGuildMember records a new membership and never un-hides an existing one', () => {
    touchGuildMember(db, 'guild-3', 'U_brand_new');
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ? AND user_id = ?')
        .get('guild-3', 'U_brand_new'),
    ).toEqual({ n: 1 });

    // bob is deliberately hidden in G2; using a command there must not reveal him.
    touchGuildMember(db, G2, BOB);
    expect(users(whoOwns(db, G2, ALPHA, 0, 50))).not.toContain(BOB);
  });
});

describe('getGuildMinPlaytime', () => {
  it('returns the configured value', () => {
    expect(getGuildMinPlaytime(db, G1)).toBe(45);
  });

  it('falls back to DEFAULT_MIN_PLAYTIME for an unconfigured guild', () => {
    expect(getGuildMinPlaytime(db, G2)).toBe(DEFAULT_MIN_PLAYTIME);
    expect(getGuildMinPlaytime(db, 'never-seen')).toBe(30);
  });
});
