/**
 * Every SQL statement in the app lives here.
 *
 * Two invariants hold across this file:
 *
 *  1. THRESHOLDS ARE STRICT. The product rule is "MORE than N minutes", so every
 *     comparison is `playtime_forever > ?`, never `>=`. A game with exactly the
 *     threshold's playtime is excluded.
 *
 *  2. ANYTHING THAT EXPOSES ANOTHER PERSON GOES THROUGH `eligible_members`.
 *     That view is the one place where opted_in + discoverable + guild-visible +
 *     not-soft-deleted are ANDed together. No public query re-implements those
 *     predicates, so none of them can accidentally omit one. The single
 *     deliberate exception is listGames(), which shows a user their OWN library:
 *     hiding yourself from other people must not hide you from yourself.
 *
 *  3. ANYTHING THAT EXPOSES A GAME READS `visible_user_games`, NEVER
 *     `user_games`. That view is to per-game visibility (/steam change) what
 *     eligible_members is to per-user visibility: the single place the
 *     `hidden = 0` predicate is written. The exceptions are the same in
 *     spirit -- listGames() and userManualGames() show you your own rows, and
 *     guildCatalog's "do I already have this" probe must see a hidden game so
 *     the panel does not offer it back to you.
 */
import type { Database, Statement } from 'better-sqlite3';
import {
  DEFAULT_MIN_PLAYTIME,
  type GameRow,
  type LeaderRow,
  type MatchRow,
  type Minutes,
  type OwnerRow,
  type SharedRow,
} from '../types.js';
import { inTransaction } from './index.js';
import { foldName, sanitizeName } from '../text.js';

/* ------------------------------------------------------------------ *
 * Prepared statement cache
 * ------------------------------------------------------------------ */

const cache = new WeakMap<Database, Map<string, Statement>>();

/** Prepare `sql` once per (database, sql) pair and reuse it forever after. */
function prep(db: Database, sql: string): Statement {
  let forDb = cache.get(db);
  if (forDb === undefined) {
    forDb = new Map();
    cache.set(db, forDb);
  }
  let stmt = forDb.get(sql);
  if (stmt === undefined) {
    stmt = db.prepare(sql);
    forDb.set(sql, stmt);
  }
  return stmt;
}

/** SQLite has no boolean type; the schema stores INTEGER 0/1 and the driver rejects JS booleans. */
const bit = (value: boolean): number => (value ? 1 : 0);

/* ------------------------------------------------------------------ *
 * Read queries
 * ------------------------------------------------------------------ */

const SQL_LIST_GAMES = `
  SELECT ug.appid AS appid, g.name AS name, ug.playtime_forever AS playtime,
         ug.playtime_tracked AS tracked, ug.hidden AS hidden
  FROM user_games ug
  JOIN games g ON g.appid = ug.appid
  WHERE ug.user_id = ? AND (ug.playtime_tracked = 0 OR ug.playtime_forever > ?)
  -- Untracked (manual) games have no playtime to rank by, so they sort after
  -- everything with a real number rather than pretending to be 0-minute games.
  ORDER BY ug.playtime_tracked DESC, ug.playtime_forever DESC, g.name ASC
  LIMIT ? OFFSET ?
`;

/**
 * The caller's own library, most-played first.
 *
 * Index: idx_user_games_user_pt (user_id, playtime_forever DESC, appid) serves
 * both the equality on user_id and the ORDER BY, so no sort is needed; `games`
 * is reached by primary key.
 *
 * NOT filtered through eligible_members, on purpose: a user who has opted out,
 * turned off discoverability, or hidden themselves in a guild can still read
 * their own list. Privacy settings hide you from OTHERS.
 */
export function listGames(
  db: Database,
  userId: string,
  minPlaytime: Minutes,
  limit: number,
  offset: number,
): GameRow[] {
  return (prep(db, SQL_LIST_GAMES).all(userId, minPlaytime, limit, offset) as RawGameRow[]).map(
    (r) => ({ ...r, tracked: r.tracked === 1, hidden: r.hidden === 1 }),
  );
}

const SQL_SHARED_GAMES = `
  SELECT a.appid AS appid,
         g.name  AS name,
         a.playtime_forever AS mine,
         b.playtime_forever AS theirs,
         MIN(a.playtime_tracked, b.playtime_tracked) AS tracked
  FROM visible_user_games a
  JOIN visible_user_games b ON b.appid = a.appid AND b.user_id = @other
  JOIN games g ON g.appid = a.appid
  WHERE a.user_id = @me
    AND (a.playtime_tracked = 0 OR a.playtime_forever > @min)
    AND (b.playtime_tracked = 0 OR b.playtime_forever > @min)
    AND EXISTS (SELECT 1 FROM eligible_members em
                WHERE em.user_id = @other AND em.guild_id = @guild)
  ORDER BY MIN(a.playtime_forever, b.playtime_forever) DESC, g.name ASC
`;

/**
 * Games both people have played past the threshold.
 *
 * Index: idx_user_games_user_pt drives the `a` side; the `b` side is a primary
 * key probe on user_games (user_id, appid), which is a WITHOUT ROWID table so
 * the probe hits the table itself.
 *
 * The threshold is applied to BOTH sides -- a game I have 900 minutes in but
 * they have 4 minutes in is not something we share.
 *
 * ORDER BY the weaker link, MIN(mine, theirs): the top of the list should be
 * what the two of them can actually sit down and play, which is bounded by
 * whichever of them knows the game less.
 *
 * The other person is validated against eligible_members IN THIS GUILD, so a
 * user who has hidden themselves here is not comparable even if they are
 * visible in some other guild the caller cannot see.
 */
export function sharedGames(
  db: Database,
  guildId: string,
  userId: string,
  otherId: string,
  minPlaytime: Minutes,
): SharedRow[] {
  return (prep(db, SQL_SHARED_GAMES).all({
    guild: guildId,
    me: userId,
    other: otherId,
    min: minPlaytime,
  }) as RawSharedRow[]).map((r) => ({ ...r, tracked: r.tracked === 1 }));
}

const SQL_WHO_OWNS = `
  SELECT em.user_id AS userId,
         ug.playtime_forever AS playtime,
         -- Only for a real Steam app. A negative appid is a hand-added game
         -- (Minecraft and friends), and printing "Steam: someone" beside a game
         -- that never came from Steam claims a connection that does not exist:
         -- the person may not even have a Steam account linked. Done in the SQL
         -- rather than the embed so no future caller of whoOwns can leak it.
         CASE WHEN @appid > 0 THEN sa.persona_name END AS personaName,
         sa.added_by AS addedBy
  FROM eligible_members em
  JOIN visible_user_games ug ON ug.user_id = em.user_id AND ug.appid = @appid
  LEFT JOIN steam_accounts sa ON sa.user_id = em.user_id
  WHERE em.guild_id = @guild
    AND (ug.playtime_tracked = 0 OR ug.playtime_forever > @min)
  ORDER BY ug.playtime_forever DESC, em.user_id ASC
  LIMIT @limit
`;

/**
 * Who in this guild has actually played a given game.
 *
 * Index: guild_members' primary key (guild_id, user_id) enumerates the guild,
 * then each candidate is a primary key probe into user_games (user_id, appid).
 * For very large guilds SQLite may instead drive from
 * idx_user_games_appid (appid, playtime_forever DESC); both are indexed paths.
 */
export function whoOwns(
  db: Database,
  guildId: string,
  appid: number,
  minPlaytime: Minutes,
  limit: number,
): OwnerRow[] {
  return prep(db, SQL_WHO_OWNS).all({
    guild: guildId,
    appid,
    min: minPlaytime,
    limit,
  }) as OwnerRow[];
}

const SQL_GUILD_GAME_META = `
  SELECT g.name AS name, g.icon_hash AS iconHash
  FROM games g
  WHERE g.appid = @appid
    AND EXISTS (
      SELECT 1
      FROM visible_user_games ug
      JOIN eligible_members em ON em.user_id = ug.user_id AND em.guild_id = @guild
      WHERE ug.appid = g.appid
    )
`;

/**
 * A game's display details, but ONLY if somebody in this guild visibly has it.
 *
 * `games` is a GLOBAL table -- one row per appid for the whole bot -- so looking
 * a name up there answers "does this app exist", not "may this guild see it".
 * /games who resolved its appid that way and would then render the title, icon
 * and store link of a game the only local owner had hidden with /steam change.
 * The owner list was correctly empty; the game was still on screen.
 *
 * Deliberately NOT filtered by playtime: "nobody here has played it past 30
 * minutes" is a real answer about a game the guild really does own, and must
 * stay distinguishable from "no such game here".
 */
export function guildGameMeta(
  db: Database,
  guildId: string,
  appid: number,
): { name: string; iconHash: string } | null {
  const row = prep(db, SQL_GUILD_GAME_META).get({ guild: guildId, appid }) as
    | { name: string; iconHash: string | null }
    | undefined;
  if (row === undefined) return null;
  return { name: row.name, iconHash: row.iconHash ?? '' };
}

const SQL_LEADERBOARD = `
  SELECT ug.appid AS appid,
         g.name   AS name,
         COUNT(*) AS owners,
         SUM(ug.playtime_forever) AS guildMinutes
  FROM eligible_members em
  JOIN visible_user_games ug ON ug.user_id = em.user_id
  JOIN games g ON g.appid = ug.appid
  WHERE em.guild_id = @guild
    AND (ug.playtime_tracked = 0 OR ug.playtime_forever > @min)
    -- @subject is '' for the whole-guild board, or a user id to restrict the
    -- board to games that person has: "how many people here share THEIR games".
    -- Through the view, so a game they hid does not appear on a public board.
    AND (@subject = '' OR EXISTS (
      SELECT 1 FROM visible_user_games s
      WHERE s.user_id = @subject AND s.appid = ug.appid
    ))
    -- The subject used to be the caller and only the caller, so their own
    -- visibility never needed checking. Now that anyone can be the subject it
    -- does: without this, naming somebody who has hidden themselves in this
    -- guild would read their library back out through the board.
    -- Viewing your OWN board still works while hidden -- hiding yourself from
    -- other people must not hide you from yourself.
    AND (@subject = '' OR @subject = @viewer OR EXISTS (
      SELECT 1 FROM eligible_members sm
      WHERE sm.user_id = @subject AND sm.guild_id = @guild
    ))
  GROUP BY ug.appid, g.name
  HAVING COUNT(*) >= @minOwners
  ORDER BY owners DESC, guildMinutes DESC, g.name ASC
  LIMIT @limit
`;

/**
 * The guild's most widely-played games.
 *
 * Index: guild_members PK (guild_id, user_id) enumerates the guild, then
 * idx_user_games_user_pt (user_id, playtime_forever DESC, appid) scans each
 * member's above-threshold games as a covering range. The GROUP BY still costs
 * a sort/hash on appid; guild libraries are small enough that this is fine.
 *
 * minOwners is inclusive (>=) -- unlike playtime, "at least N owners" is not
 * the "more than" rule.
 */
export function leaderboard(
  db: Database,
  guildId: string,
  minPlaytime: Minutes,
  minOwners: number,
  limit: number,
  /**
   * Whose point of view. Null is the whole-guild board; a user id ranks only
   * the games THAT person has, by how many people here share them. The counts
   * still include everyone, so `4 inimest` means four people including them.
   *
   * Anyone may be the subject, so unless they are also the viewer they must be
   * visible in this guild -- enforced in the SQL above, not by the caller.
   */
  subjectUserId: string | null = null,
  /** Who is asking. Only ever used to let someone see their own board. */
  viewerUserId: string | null = null,
): LeaderRow[] {
  return prep(db, SQL_LEADERBOARD).all({
    guild: guildId,
    min: minPlaytime,
    minOwners,
    limit,
    subject: subjectUserId ?? '',
    viewer: viewerUserId ?? '',
  }) as LeaderRow[];
}

const SQL_IS_VISIBLE_HERE = `
  SELECT 1 AS ok FROM eligible_members WHERE guild_id = ? AND user_id = ?
`;

/**
 * Is this person discoverable in this guild?
 *
 * Only for choosing the right MESSAGE -- the leaderboard query enforces the
 * same rule itself, so a caller that forgets this leaks nothing. It exists
 * because "they are hidden here" and "you two share nothing" are different
 * answers and an empty board cannot tell them apart.
 */
export function isVisibleInGuild(db: Database, guildId: string, userId: string): boolean {
  return prep(db, SQL_IS_VISIBLE_HERE).get(guildId, userId) !== undefined;
}

/** A user must share at least this many games before they are a "match" at all. */
export const MIN_OVERLAP_FOR_MATCH = 3;

const SQL_FIND_MATCHES = `
  WITH mine AS (
    SELECT appid FROM visible_user_games
    WHERE user_id = @me AND (playtime_tracked = 0 OR playtime_forever > @min)
  ),
  theirs AS (
    SELECT em.user_id AS uid, ug.appid AS appid
    FROM eligible_members em
    JOIN visible_user_games ug ON ug.user_id = em.user_id
    WHERE em.guild_id = @guild
      AND em.user_id <> @me
      AND (ug.playtime_tracked = 0 OR ug.playtime_forever > @min)
  )
  SELECT t.uid AS userId,
         (SELECT sa.persona_name FROM steam_accounts sa WHERE sa.user_id = t.uid) AS personaName,
         (SELECT sa.added_by FROM steam_accounts sa WHERE sa.user_id = t.uid) AS addedBy,
         SUM(m.appid IS NOT NULL) AS overlap,
         COUNT(*) AS theirTotal,
         CAST(SUM(m.appid IS NOT NULL) AS REAL)
           / ((SELECT COUNT(*) FROM mine) + COUNT(*) - SUM(m.appid IS NOT NULL)) AS jaccard
  FROM theirs t
  LEFT JOIN mine m ON m.appid = t.appid
  GROUP BY t.uid
  HAVING overlap >= @minOverlap
  ORDER BY
    CASE WHEN @byOverlap = 1 THEN overlap END DESC,
    CASE WHEN @byOverlap = 1 THEN jaccard END DESC,
    CASE WHEN @byOverlap = 0 THEN jaccard END DESC,
    CASE WHEN @byOverlap = 0 THEN overlap END DESC,
    t.uid ASC
  LIMIT @limit
`;

/**
 * Rank the other eligible members of a guild by taste similarity to the caller.
 *
 * Index: the `mine` CTE and the per-member scan in `theirs` both ride
 * idx_user_games_user_pt (user_id, playtime_forever DESC, appid), which covers
 * them entirely; guild enumeration is the guild_members PK.
 *
 * Returns overlap AND theirTotal so the caller can show "12 games in common"
 * alongside the ratio, and jaccard = overlap / (mine + theirs - overlap) is
 * computed in SQL so the ordering and the displayed number can never disagree.
 *
 * The overlap >= 3 floor exists because Jaccard is degenerate on tiny
 * libraries: someone whose entire above-threshold library is one game we both
 * own would otherwise score 1.0 and sit permanently at the top of the chart.
 *
 * The caller is excluded explicitly (em.user_id <> @me); the denominator is
 * always positive because overlap >= 3 forces both library counts above zero.
 */
export function findMatches(
  db: Database,
  guildId: string,
  userId: string,
  minPlaytime: Minutes,
  limit: number,
  /**
   * Must match the sort the caller will display. The LIMIT is applied in SQL, so
   * ordering by jaccard and then re-sorting by overlap in JS would truncate away
   * the genuinely top-overlap members in a guild with more matches than `limit`.
   */
  sort: 'overlap' | 'taste' = 'overlap',
): MatchRow[] {
  return prep(db, SQL_FIND_MATCHES).all({
    guild: guildId,
    me: userId,
    min: minPlaytime,
    minOverlap: MIN_OVERLAP_FOR_MATCH,
    limit,
    byOverlap: sort === 'overlap' ? 1 : 0,
  }) as MatchRow[];
}

/* ------------------------------------------------------------------ *
 * Autocomplete
 * ------------------------------------------------------------------ */

export interface AutocompleteRow {
  appid: number;
  name: string;
  owners: number;
}

/**
 * Escape the LIKE metacharacters `%`, `_` and the escape character itself so
 * user input is matched literally. Pairs with `ESCAPE '\'` in the SQL.
 * Without this, a search for "100%" would match every game name starting "100".
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Fold a user's search text the same way games.name_folded is stored.
 * Kept deliberately simple (case fold + diacritic strip + whitespace collapse)
 * so that it is cheap and deterministic.
 */
export function foldForSearch(input: string): string {
  return foldName(input);
}

const SQL_AUTOCOMPLETE_SEARCH = `
  SELECT g.appid AS appid, g.name AS name, COUNT(*) AS owners
  FROM games g
  JOIN visible_user_games ug ON ug.appid = g.appid
  JOIN eligible_members em ON em.user_id = ug.user_id AND em.guild_id = @guild
  WHERE g.name_folded LIKE @pattern ESCAPE '\\'
  GROUP BY g.appid, g.name
  ORDER BY owners DESC, g.name ASC
  LIMIT @limit
`;

const SQL_AUTOCOMPLETE_TOP = `
  SELECT g.appid AS appid, g.name AS name, COUNT(*) AS owners
  FROM games g
  JOIN visible_user_games ug ON ug.appid = g.appid
  JOIN eligible_members em ON em.user_id = ug.user_id AND em.guild_id = @guild
  GROUP BY g.appid, g.name
  ORDER BY owners DESC, g.name ASC
  LIMIT @limit
`;

/**
 * Suggestions for Discord autocomplete.
 *
 * Discord gives autocomplete a hard 3-second deadline and it CANNOT be
 * deferred, so this is one synchronous indexed query and touches nothing else:
 * no Steam API call, no network, no cross-table fan-out beyond the guild's own
 * library.
 *
 * Index: idx_games_name_folded (name_folded) serves the prefix portion of the
 * pattern; the candidate set is further bounded because only games actually
 * owned inside this guild can join through eligible_members. An empty query
 * skips the LIKE entirely and returns the guild's most-owned games.
 *
 * No playtime threshold applies here -- this picks a game to ask about, and
 * the query that answers the question does its own filtering.
 */
export function searchGamesForAutocomplete(
  db: Database,
  guildId: string,
  query: string,
  limit = 25,
): AutocompleteRow[] {
  const folded = foldForSearch(query);
  if (folded === '') {
    return prep(db, SQL_AUTOCOMPLETE_TOP).all({
      guild: guildId,
      limit,
    }) as AutocompleteRow[];
  }
  return prep(db, SQL_AUTOCOMPLETE_SEARCH).all({
    guild: guildId,
    pattern: `%${escapeLike(folded)}%`,
    limit,
  }) as AutocompleteRow[];
}

/* ------------------------------------------------------------------ *
 * Writes and lifecycle
 * ------------------------------------------------------------------ */

const SQL_ENSURE_USER = `INSERT INTO users (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`;

/** Create the users row if it does not exist. Never resurrects a soft-deleted user's flags. */
export function ensureUser(db: Database, userId: string): void {
  prep(db, SQL_ENSURE_USER).run(userId);
}

// Clearing deleted_at matters: /privacy -> "delete everything" soft-deletes the
// row, and eligible_members requires deleted_at IS NULL. Without this, a user who
// deletes their data and then re-links is silently invisible to every query while
// the bot cheerfully reports them as discoverable.
const SQL_SET_OPTED_IN = `
  UPDATE users
  SET opted_in = @on, deleted_at = CASE WHEN @on = 1 THEN NULL ELSE deleted_at END
  WHERE user_id = @user
`;
const SQL_SET_DISCOVERABLE = `UPDATE users SET discoverable = ? WHERE user_id = ?`;

/** Opting in is what makes a user visible to every guild-scoped query. */
export function setOptedIn(db: Database, userId: string, value: boolean): void {
  ensureUser(db, userId);
  prep(db, SQL_SET_OPTED_IN).run({ on: bit(value), user: userId });
}

/** Global "do not surface me in matching" switch, independent of opt-in. */
export function setDiscoverable(db: Database, userId: string, value: boolean): void {
  ensureUser(db, userId);
  prep(db, SQL_SET_DISCOVERABLE).run(bit(value), userId);
}

const SQL_SET_GUILD_VISIBLE = `
  INSERT INTO guild_members (guild_id, user_id, visible) VALUES (@guild, @user, @visible)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET visible = excluded.visible
`;

/** Per-guild hide/show. A user can be visible in one server and hidden in another. */
export function setGuildVisible(
  db: Database,
  guildId: string,
  userId: string,
  value: boolean,
): void {
  ensureUser(db, userId);
  prep(db, SQL_SET_GUILD_VISIBLE).run({ guild: guildId, user: userId, visible: bit(value) });
}

const SQL_TOUCH_GUILD_MEMBER = `
  INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)
  ON CONFLICT(guild_id, user_id) DO NOTHING
`;

/**
 * Record that this user has used the bot in this guild.
 *
 * Called on every command; it is what populates guild scoping at all. Uses DO
 * NOTHING rather than an upsert so that it can never resurrect a user who has
 * deliberately hidden themselves here (visible = 0 survives).
 */
export function touchGuildMember(db: Database, guildId: string, userId: string): void {
  ensureUser(db, userId);
  prep(db, SQL_TOUCH_GUILD_MEMBER).run(guildId, userId);
}

const SQL_GET_STEAM_ID = `SELECT steam_id64 AS id64 FROM steam_accounts WHERE user_id = ?`;
const SQL_DELETE_STEAM_BY_USER = `DELETE FROM steam_accounts WHERE user_id = ?`;
const SQL_GET_STEAM_OWNER = `SELECT user_id FROM steam_accounts WHERE steam_id64 = ?`;
const SQL_DELETE_STEAM_BY_ID = `DELETE FROM steam_accounts WHERE steam_id64 = ?`;
const SQL_DELETE_USER_GAMES = `DELETE FROM user_games WHERE user_id = ?`;
// Steam-derived rows ONLY. Hand-added games (playtime_tracked = 0) never came
// from a Steam account, so unlinking or relinking one must not take them: they
// are the whole point of the "add another game" panel and a person can own them
// without ever having linked Steam at all. Full erasure (/privacy -> forget me)
// is the one place that still deletes everything.
const SQL_DELETE_STEAM_USER_GAMES = `
  DELETE FROM user_games WHERE user_id = ? AND playtime_tracked = 1
`;
const SQL_INSERT_STEAM = `INSERT INTO steam_accounts (steam_id64, user_id, added_by) VALUES (?, ?, ?)`;

/**
 * Link (or relink) a Discord user to a Steam account.
 *
 * SHARP EDGE: user_games is keyed by user_id, NOT by steam_id64. Nothing in the
 * row says which Steam account it came from. So if a user relinks to a
 * DIFFERENT Steam account and we only swap the steam_accounts row, the old
 * account's library stays behind and the next sync merges the new library into
 * it -- the user silently "owns" games from an account they no longer have
 * linked, forever. The delete and the swap therefore happen inside ONE
 * transaction: either the identity and the library both change, or neither does.
 *
 * Relinking to the SAME steam_id64 is a no-op and deliberately does not wipe
 * the library (a re-run of /link should not cost a full resync).
 *
 * Returns true if the library was wiped because the Steam identity changed.
 */
export type LinkOutcome =
  | { ok: true; wiped: boolean }
  | { ok: false; reason: 'claimed_by_other' };

export function linkSteam(
  db: Database,
  userId: string,
  id64: string,
  /**
   * Discord ID of the moderator linking this on someone else's behalf, or null
   * when the user linked it themselves. Recorded so listings can show that an
   * entry was not self-registered.
   */
  addedBy: string | null = null,
): LinkOutcome {
  return inTransaction(db, () => {
    ensureUser(db, userId);
    const current = prep(db, SQL_GET_STEAM_ID).get(userId) as { id64: string } | undefined;
    if (current !== undefined && current.id64 === id64) return { ok: true, wiped: false };

    // A Steam ID is public, so anyone can type anyone's. Refuse rather than
    // transfer the claim: silently unlinking the real owner would leave their
    // frozen library being served to the guild while they are told they have
    // no account linked.
    const claimed = prep(db, SQL_GET_STEAM_OWNER).get(id64) as { user_id: string } | undefined;
    if (claimed !== undefined && claimed.user_id !== userId) {
      return { ok: false, reason: 'claimed_by_other' as const };
    }

    if (current !== undefined) {
      prep(db, SQL_DELETE_STEAM_BY_USER).run(userId);
      // The library belonged to the OLD steam account. It must not survive --
      // but only the Steam half of it: manually added games are not the old
      // account's and switching Steam accounts is not a reason to lose them.
      prep(db, SQL_DELETE_STEAM_USER_GAMES).run(userId);
    }
    prep(db, SQL_INSERT_STEAM).run(id64, userId, addedBy);
    return { ok: true, wiped: current !== undefined };
  });
}

/**
 * Drop the Steam link and everything derived from it, keeping the user's
 * settings -- and keeping their manually added games, which are not derived
 * from it. Unlinking Steam is not a request to forget that they play Minecraft.
 */
export function unlink(db: Database, userId: string): void {
  inTransaction(db, () => {
    prep(db, SQL_DELETE_STEAM_BY_USER).run(userId);
    prep(db, SQL_DELETE_STEAM_USER_GAMES).run(userId);
  });
}

const SQL_DELETE_GUILD_MEMBERSHIPS = `DELETE FROM guild_members WHERE user_id = ?`;
const SQL_SOFT_DELETE_USER = `
  UPDATE users SET deleted_at = unixepoch(), opted_in = 0 WHERE user_id = ?
`;

/**
 * Full erasure request: unlink, forget every guild membership, and soft-delete
 * the user. The users row is kept (tombstoned) so that eligible_members can
 * keep excluding them and so a later re-opt-in is a deliberate act.
 */
export function forget(db: Database, userId: string): void {
  inTransaction(db, () => {
    prep(db, SQL_DELETE_STEAM_BY_USER).run(userId);
    prep(db, SQL_DELETE_USER_GAMES).run(userId);
    prep(db, SQL_DELETE_GUILD_MEMBERSHIPS).run(userId);
    prep(db, SQL_SOFT_DELETE_USER).run(userId);
  });
}

const SQL_GET_GUILD_MIN = `SELECT default_min_playtime AS min FROM guild_settings WHERE guild_id = ?`;

/** A guild's configured threshold, or the product default when unconfigured. */
export function getGuildMinPlaytime(db: Database, guildId: string): Minutes {
  const row = prep(db, SQL_GET_GUILD_MIN).get(guildId) as { min: number } | undefined;
  return row === undefined ? DEFAULT_MIN_PLAYTIME : row.min;
}

/** SQLite has no boolean type, so `tracked` arrives as 0/1 and is mapped. */
type RawGameRow = Omit<GameRow, 'tracked' | 'hidden'> & { tracked: number; hidden: number };
type RawSharedRow = Omit<SharedRow, 'tracked'> & { tracked: number };

/* ------------------------------------------------------------------ *
 * Import checklist: what is already imported
 *
 * NOTHING IS STORED ABOUT A REFUSAL. The bot used to keep an `excluded_games`
 * table so a later import could leave an unticked game unticked; that table is
 * gone and `migrate()` drops it. Its job is done instead by the absence of a
 * row: /steam update pre-ticks exactly the games already in the library, so a
 * game you declined arrives unticked next time because you do not own it here.
 *
 * The consequence worth knowing: a declined game is indistinguishable from a
 * game Steam only just started reporting. Both are "new", both arrive unticked,
 * and the screen says so.
 * ------------------------------------------------------------------ */

const SQL_STEAM_APPIDS = `
  SELECT appid FROM user_games WHERE user_id = ? AND playtime_tracked = 1
`;

/**
 * The Steam appids this user currently has stored.
 *
 * playtime_tracked = 1 scopes it to Steam-sourced rows: a hand-added game has a
 * synthetic negative id that no Steam response will ever mention, and including
 * one here would mean nothing.
 */
export function steamAppids(db: Database, userId: string): Set<number> {
  const rows = prep(db, SQL_STEAM_APPIDS).all(userId) as { appid: number }[];
  return new Set(rows.map((r) => r.appid));
}

/* ------------------------------------------------------------------ *
 * Per-game visibility (/steam change)
 *
 * `hidden` is not the same as "never imported". A hidden game is still yours --
 * it stays in user_games, still shows in your own /games list, and still counts
 * as something you own -- it is simply withheld from every guild-facing query
 * by the visible_user_games view. A game left unticked at the import checklist
 * has no row at all.
 * ------------------------------------------------------------------ */

const SQL_LIST_ALL_USER_GAMES = `
  SELECT ug.appid AS appid, g.name AS name, ug.playtime_forever AS playtime,
         ug.playtime_tracked AS tracked, ug.hidden AS hidden
  FROM user_games ug
  JOIN games g ON g.appid = ug.appid
  WHERE ug.user_id = ?
  ORDER BY ug.playtime_tracked DESC, ug.playtime_forever DESC, g.name ASC
  LIMIT ?
`;

/**
 * Every game the user has, hidden ones included, for the /steam change
 * checklist. Deliberately NOT filtered by playtime: you must be able to hide a
 * game that no threshold would have shown you.
 */
export function listAllUserGames(db: Database, userId: string, limit = 5000): GameRow[] {
  return (prep(db, SQL_LIST_ALL_USER_GAMES).all(userId, limit) as RawGameRow[]).map((r) => ({
    ...r,
    tracked: r.tracked === 1,
    hidden: r.hidden === 1,
  }));
}

const SQL_UNHIDE_ALL = `UPDATE user_games SET hidden = 0 WHERE user_id = ?`;
const SQL_HIDE_ONE = `UPDATE user_games SET hidden = 1 WHERE user_id = ? AND appid = ?`;

/**
 * Replace the user's whole hidden set. Wholesale, not a merge, for the same
 * reason: the checklist submits a complete answer, so anything not named is
 * visible. Unhide-everything then hide-the-named keeps that atomic.
 */
export function setHiddenGames(
  db: Database,
  userId: string,
  hiddenAppids: readonly number[],
): void {
  inTransaction(db, () => {
    prep(db, SQL_UNHIDE_ALL).run(userId);
    const hide = prep(db, SQL_HIDE_ONE);
    for (const appid of hiddenAppids) {
      if (Number.isInteger(appid)) hide.run(userId, appid);
    }
  });
}

/**
 * Has this user given consent that is still on record?
 *
 * `opted_in` IS the persisted consent record: it is set only after the user
 * agrees, and cleared by /steam unlink and /privacy -> forget. Using "do they
 * have a steam_accounts row" instead would let someone link a DIFFERENT Steam
 * account, or restart the bot, and skip the prompt entirely.
 */
export function hasStoredConsent(db: Database, userId: string): boolean {
  const row = prep(
    db,
    `SELECT opted_in, deleted_at FROM users WHERE user_id = ?`,
  ).get(userId) as { opted_in: number; deleted_at: number | null } | undefined;
  return row !== undefined && row.opted_in === 1 && row.deleted_at === null;
}

/* ------------------------------------------------------------------ *
 * Manual (non-Steam) games
 *
 * Steam apps keep their real positive appid. Anything added by hand gets a
 * synthetic NEGATIVE id, so the id spaces cannot collide and `appid > 0` still
 * reliably means "this is a Steam app".
 *
 * These games carry NO playtime: user_games.playtime_tracked is 0, which every
 * query's filter predicate honours by letting the row through regardless of the
 * threshold. A 0 in playtime_forever here means "unknown", not "never played".
 * ------------------------------------------------------------------ */

const SQL_FIND_MANUAL_GAME = `
  SELECT appid, name FROM games WHERE source = 'manual' AND name_folded = ?
`;

const SQL_NEXT_MANUAL_ID = `
  SELECT COALESCE(MIN(appid), 0) - 1 AS next FROM games WHERE appid < 0
`;

const SQL_INSERT_MANUAL_GAME = `
  INSERT INTO games (appid, name, name_folded, source) VALUES (?, ?, ?, 'manual')
`;

/**
 * Find or create the shared catalogue entry for a non-Steam game.
 *
 * Deduplicated on the folded name, so "Minecraft", "minecraft" and "MINECRAFT"
 * added by three people converge on one row -- which is what makes the
 * "pick from games other people added" panel useful.
 */
export function upsertManualGame(
  db: Database,
  rawName: string,
): { appid: number; name: string; created: boolean } {
  return inTransaction(db, () => {
    const name = sanitizeName(rawName);
    const folded = foldName(name);
    const existing = prep(db, SQL_FIND_MANUAL_GAME).get(folded) as
      | { appid: number; name: string }
      | undefined;
    if (existing) return { ...existing, created: false };

    const { next } = prep(db, SQL_NEXT_MANUAL_ID).get() as { next: number };
    prep(db, SQL_INSERT_MANUAL_GAME).run(next, name, folded);
    return { appid: next, name, created: true };
  });
}

const SQL_ADD_USER_GAME = `
  INSERT INTO user_games (user_id, appid, playtime_forever, playtime_tracked)
  VALUES (@user, @appid, 0, 0)
  ON CONFLICT(user_id, appid) DO NOTHING
`;

/**
 * Record that a user plays a game, with no playtime attached.
 *
 * DO NOTHING on conflict deliberately: if the user already has this game from a
 * Steam sync, its real playtime must not be clobbered with an untracked 0.
 */
export function addUserGame(db: Database, userId: string, appid: number): boolean {
  // Integer, not merely finite: appid is a rowid-shaped key and the driver
  // would otherwise be handed a float straight from a select-menu value.
  if (!Number.isInteger(appid)) return false;
  ensureUser(db, userId);
  return prep(db, SQL_ADD_USER_GAME).run({ user: userId, appid }).changes > 0;
}

// playtime_tracked = 0 is not decoration. The only caller is the /games add
// panel's "Eemalda" picker, which is documented as manual-games-only ("Steami
// mängude jaoks kasuta /steam unlink") -- so the predicate that makes that true
// belongs in the statement, not in the caller's choice of options. Without it a
// crafted select value deletes a Steam row that /steam update would then have
// to re-import.
const SQL_REMOVE_USER_GAME = `
  DELETE FROM user_games WHERE user_id = ? AND appid = ? AND playtime_tracked = 0
`;

export function removeUserGame(db: Database, userId: string, appid: number): boolean {
  if (!Number.isInteger(appid)) return false;
  return prep(db, SQL_REMOVE_USER_GAME).run(userId, appid).changes > 0;
}

const SQL_GUILD_CATALOG = `
  SELECT g.appid AS appid,
         g.name AS name,
         g.source AS source,
         COUNT(*) AS owners
  FROM eligible_members em
  JOIN visible_user_games ug ON ug.user_id = em.user_id
  JOIN games g ON g.appid = ug.appid
  WHERE em.guild_id = @guild
    -- Raw user_games, NOT the view: this asks "do I already have this", and a
    -- game I own but have hidden must not be offered back to me as new.
    AND NOT EXISTS (
      SELECT 1 FROM user_games mine
      WHERE mine.user_id = @me AND mine.appid = g.appid
    )
  GROUP BY g.appid, g.name, g.source
  ORDER BY owners DESC, g.name ASC
  LIMIT @limit
`;

export interface CatalogRow {
  appid: number;
  name: string;
  source: string;
  owners: number;
}

/**
 * Games other people in this guild already have, which the caller does not.
 *
 * This is the "pick from what's already here" panel: it turns one person's
 * effort adding a game into something everyone else can claim in one click.
 */
export function guildCatalog(
  db: Database,
  guildId: string,
  userId: string,
  limit = 25,
): CatalogRow[] {
  return prep(db, SQL_GUILD_CATALOG).all({
    guild: guildId,
    me: userId,
    limit,
  }) as CatalogRow[];
}

const SQL_USER_MANUAL_GAMES = `
  SELECT g.appid AS appid, g.name AS name
  FROM user_games ug
  JOIN games g ON g.appid = ug.appid
  WHERE ug.user_id = ? AND ug.playtime_tracked = 0
  ORDER BY g.name ASC
  LIMIT ?
`;

/** The caller's manually added games, for the "remove one" panel. */
export function userManualGames(
  db: Database,
  userId: string,
  limit = 25,
): { appid: number; name: string }[] {
  return prep(db, SQL_USER_MANUAL_GAMES).all(userId, limit) as {
    appid: number;
    name: string;
  }[];
}
