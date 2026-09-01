/**
 * Persist a fetched Steam library into SQLite.
 *
 * One transaction per sync so a partially-written library can never be observed
 * by a concurrent query, and so a mid-sync failure leaves the previous snapshot
 * intact rather than a half-deleted one.
 */

import type { Database } from 'better-sqlite3';
import type { LibraryResult, OwnedGame, ProfileState } from '../types.js';
import { foldName, sanitizeName } from '../text.js';

// Re-exported for callers that already import these from here.
export { foldName, sanitizeName };

const HOUR = 3600;
const FRESH_TTL = 6 * HOUR;
const MAX_TTL = 24 * HOUR;

/** Anything that can produce a library; SteamClient satisfies it. */
export interface LibrarySource {
  fetchLibrary(id64: string): Promise<LibraryResult>;
}

export interface SyncOutcome {
  state: ProfileState;
  /** Rows inserted or updated in user_games. */
  written: number;
  /** Rows removed because the app is no longer in the library (refund, revoked share). */
  removed: number;
  staleAfter: number;
  failCount: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/**
 * Format characters (\p{Cf}) include zero-width joiners/spaces, the RTL override
 * U+202E and the bidi isolates. A game title carrying those can visually scramble
 * or reverse the rest of a Discord embed line, so they never reach display text.
 */

/** Display name: strip invisibles/controls, collapse whitespace, bound the length. */


// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Null for an empty hash: building the URL anyway yields a 404 that breaks the embed. */
export function iconUrl(appid: number, hash: string): string | null {
  if (!hash) return null;
  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`;
}

export function headerUrl(appid: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
}

export function storeUrl(appid: number): string {
  return `https://store.steampowered.com/app/${appid}`;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function previousState(db: Database, id64: string): string | null {
  const row = db
    .prepare('SELECT profile_state FROM steam_accounts WHERE steam_id64 = ?')
    .get(id64) as { profile_state?: string } | undefined;
  return row?.profile_state ?? null;
}

function countUserGames(db: Database, userId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM user_games WHERE user_id = ?').get(userId) as {
      n: number;
    }
  ).n;
}

/**
 * States where Steam gave us an authoritative game list (possibly empty).
 *
 * 'playtime_hidden' is deliberately NOT here. That response lists the games but
 * zeroes every playtime, so writing it would overwrite real, previously known
 * playtimes with 0 -- the same class of data loss the empty-library guard below
 * exists to prevent. We keep the last good snapshot and record the state.
 */
function hasAuthoritativeGames(state: ProfileState): boolean {
  return state === 'public' || state === 'empty';
}

/**
 * A hidden library will stay hidden until the user changes a setting, so backing
 * off to a full day stops us burning the rate limit re-checking it on every query.
 */
function ttlFor(state: ProfileState): number {
  return state === 'private' || state === 'game_details_private' ? MAX_TTL : FRESH_TTL;
}

/** 6h, 12h, 24h, 24h, ... for failCount 1, 2, 3, ... */
function backoffTtl(failCount: number): number {
  return Math.min(FRESH_TTL * 2 ** Math.max(0, failCount - 1), MAX_TTL);
}

export async function syncLibrary(
  db: Database,
  userId: string,
  id64: string,
  client: LibrarySource,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SyncOutcome> {
  let result: LibraryResult;
  try {
    result = await client.fetchLibrary(id64);
  } catch (err) {
    return recordFailure(db, id64, err instanceof Error ? err.message : String(err), now);
  }

  if (result.state === 'error') {
    return recordFailure(db, id64, 'Steam API request failed', now);
  }

  const games = hasAuthoritativeGames(result.state) ? result.games : null;
  const staleAfter = now + ttlFor(result.state);

  const run = db.transaction(() => {
    let written = 0;
    let removed = 0;

    if (games !== null) {
      // A malformed Steam response once classified as an authoritative empty
      // library and wiped a real one. Require TWO consecutive empty answers
      // before deleting: a one-off glitch cannot destroy a snapshot, but a user
      // who genuinely refunded everything still gets cleaned up on the next sync.
      const wasEmpty = previousState(db, id64) === 'empty';
      if (games.length === 0 && !wasEmpty && countUserGames(db, userId) > 0) {
        removed = 0;
      } else {
        ({ written, removed } = writeGames(db, userId, games, now));
      }
    }

    db.prepare(
      `UPDATE steam_accounts
          SET persona_name   = COALESCE(?, persona_name),
              profile_state  = ?,
              last_synced_at = ?,
              stale_after    = ?,
              last_error     = NULL,
              fail_count     = 0
        WHERE steam_id64 = ?`,
    ).run(
      result.personaName === null ? null : sanitizeName(result.personaName),
      result.state,
      now,
      staleAfter,
      id64,
    );

    return { written, removed };
  });

  const { written, removed } = run();
  return { state: result.state, written, removed, staleAfter, failCount: 0, error: null };
}

function writeGames(
  db: Database,
  userId: string,
  games: readonly OwnedGame[],
  now: number,
): { written: number; removed: number } {
  const upsertGame = db.prepare(
    `INSERT INTO games (appid, name, name_folded, icon_hash, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(appid) DO UPDATE SET
       name         = excluded.name,
       name_folded  = excluded.name_folded,
       icon_hash    = excluded.icon_hash,
       last_seen_at = excluded.last_seen_at`,
  );

  const upsertUserGame = db.prepare(
    `INSERT INTO user_games (user_id, appid, playtime_forever, playtime_2weeks, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, appid) DO UPDATE SET
       playtime_forever = excluded.playtime_forever,
       playtime_2weeks  = excluded.playtime_2weeks,
       updated_at       = excluded.updated_at`,
  );

  // A staging table rather than a giant NOT IN (?,?,...): libraries routinely run
  // to thousands of appids, past SQLite's bound-parameter limit.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _sync_appids (appid INTEGER PRIMARY KEY)');
  db.exec('DELETE FROM _sync_appids');
  const stage = db.prepare('INSERT OR IGNORE INTO _sync_appids (appid) VALUES (?)');

  const seen = new Set<number>();
  for (const game of games) {
    if (!Number.isInteger(game.appid) || seen.has(game.appid)) continue;
    seen.add(game.appid);
    const name = sanitizeName(game.name) || `App ${game.appid}`;
    upsertGame.run(game.appid, name, foldName(name), game.iconHash, now);
    upsertUserGame.run(
      userId,
      game.appid,
      Math.max(0, Math.trunc(game.playtimeForever)),
      Math.max(0, Math.trunc(game.playtime2Weeks)),
      now,
    );
    stage.run(game.appid);
  }

  // Everything the user owned last time but not now: refunds, revoked family shares,
  // delisted apps. Leaving them would inflate every overlap query forever.
  const del = db
    .prepare(
      // playtime_tracked = 1 scopes this to Steam-sourced rows. Without it, a
      // Steam sync would delete every manually added game (Minecraft and
      // friends) simply because Steam has never heard of them.
      `DELETE FROM user_games
        WHERE user_id = ?
          AND playtime_tracked = 1
          AND appid NOT IN (SELECT appid FROM _sync_appids)`,
    )
    .run(userId);

  db.exec('DELETE FROM _sync_appids');

  return { written: seen.size, removed: del.changes };
}

/** Failures never touch user_games: the last good snapshot stays queryable. */
function recordFailure(db: Database, id64: string, message: string, now: number): SyncOutcome {
  const row = db
    .prepare('SELECT fail_count FROM steam_accounts WHERE steam_id64 = ?')
    .get(id64) as { fail_count?: number } | undefined;

  const failCount = (row?.fail_count ?? 0) + 1;
  const staleAfter = now + backoffTtl(failCount);

  db.prepare(
    // profile_state is NOT set to 'error': the stored snapshot is still the last
    // known good library, and callers need to tell "refresh failed" apart from
    // "this profile is broken". last_error and fail_count carry the failure.
    `UPDATE steam_accounts
        SET stale_after   = ?,
            last_error    = ?,
            fail_count    = ?
      WHERE steam_id64 = ?`,
  ).run(staleAfter, message.slice(0, 500), failCount, id64);

  return { state: 'error', written: 0, removed: 0, staleAfter, failCount, error: message };
}
