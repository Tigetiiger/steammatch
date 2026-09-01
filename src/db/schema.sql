PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  opted_in     INTEGER NOT NULL DEFAULT 0,
  discoverable INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS steam_accounts (
  steam_id64     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  persona_name   TEXT,
  profile_state  TEXT NOT NULL DEFAULT 'unknown',
  linked_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_synced_at INTEGER,
  stale_after    INTEGER,
  last_error     TEXT,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  -- Discord ID of the moderator who linked this account on someone else's
  -- behalf. NULL means the user linked it themselves and consented directly.
  added_by       TEXT
) STRICT;

-- Steam apps use their real (positive) appid. Manually added games -- Minecraft
-- and anything else off-Steam -- get a synthetic NEGATIVE id, so the two id
-- spaces can never collide and `appid > 0` still means "this is a Steam app".
CREATE TABLE IF NOT EXISTS games (
  appid        INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  name_folded  TEXT NOT NULL,
  icon_hash    TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'steam',
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

-- NOTE: the partial unique index on manual game names lives in migrate() in
-- db/index.ts, NOT here. It references games.source, and on a database created
-- before that column existed this file runs BEFORE the column is added -- so
-- putting it here makes opening an existing database fail outright.

CREATE INDEX IF NOT EXISTS idx_games_name_folded ON games(name_folded);

CREATE TABLE IF NOT EXISTS user_games (
  user_id          TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  appid            INTEGER NOT NULL REFERENCES games(appid) ON DELETE CASCADE,
  playtime_forever INTEGER NOT NULL DEFAULT 0,
  playtime_2weeks  INTEGER NOT NULL DEFAULT 0,
  -- 0 for manually added games, where no playtime exists. Those rows must pass
  -- every playtime filter rather than be hidden by one: a 0 in playtime_forever
  -- means "unknown", not "never played".
  playtime_tracked INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, appid)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_user_games_appid ON user_games(appid, playtime_forever DESC);
CREATE INDEX IF NOT EXISTS idx_user_games_user_pt ON user_games(user_id, playtime_forever DESC, appid);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  visible   INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (guild_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_guild_members_user ON guild_members(user_id);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id             TEXT PRIMARY KEY,
  default_min_playtime INTEGER NOT NULL DEFAULT 30
) STRICT;

CREATE VIEW IF NOT EXISTS eligible_members AS
SELECT gm.guild_id, gm.user_id
FROM guild_members gm
JOIN users u ON u.user_id = gm.user_id
WHERE gm.visible = 1 AND u.opted_in = 1 AND u.discoverable = 1 AND u.deleted_at IS NULL;

-- Steam appids the user unchecked on the post-sync checklist. Sync consults
-- this table itself rather than trusting its caller to pass a filter, for the
-- same reason eligible_members is a view: a predicate that lives in one place
-- cannot be forgotten by a new call site.
--
-- `name` is denormalised on purpose. An excluded game has no user_games row,
-- and if nobody else in any guild owns it there is no `games` row either -- so
-- without the name here the checklist could not list back what was excluded.
-- There is deliberately NO foreign key to games(appid) for the same reason.
CREATE TABLE IF NOT EXISTS excluded_games (
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  appid       INTEGER NOT NULL,
  name        TEXT NOT NULL,
  excluded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, appid)
) STRICT, WITHOUT ROWID;

-- NOTE: the `visible_user_games` view lives in migrate() in db/index.ts, NOT
-- here. It references user_games.hidden, which is a migrated column, and this
-- file runs BEFORE migrate().

/* ====================================================================== *
 * Reaction roles
 *
 * A SELF-CONTAINED feature. It shares the database file and nothing else:
 * no foreign key into `users`, no reference to `eligible_members`, no
 * playtime. Deliberately so -- `users.opted_in` is a record of consent to
 * store Steam data, and handing someone a Discord role has nothing to do
 * with that. A role panel must keep working for a member who has never
 * touched /games and never will.
 * ====================================================================== */

CREATE TABLE IF NOT EXISTS role_panels (
  message_id  TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- 1 = picking one role in this panel drops the others in it.
  exclusive   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX IF NOT EXISTS idx_role_panels_guild ON role_panels(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reaction_roles (
  message_id TEXT NOT NULL REFERENCES role_panels(message_id) ON DELETE CASCADE,
  -- Custom emoji: the snowflake id. Unicode emoji: the character itself, with
  -- the variation selector stripped, so U+2764 U+FE0F and bare U+2764 are the
  -- same key. Gateway events and command input MUST be keyed identically.
  emoji_key  TEXT NOT NULL,
  -- What to render and what to react with: '⛏️' or '<:name:12345>'.
  emoji_raw  TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, emoji_key)
) STRICT, WITHOUT ROWID;

-- One emoji per role per panel: two emoji granting the same role means the
-- second removal takes away a role the first is still showing as held.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reaction_roles_role
  ON reaction_roles(message_id, role_id);
