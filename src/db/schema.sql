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
