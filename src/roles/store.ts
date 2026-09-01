/**
 * Every SQL statement for the reaction-role feature.
 *
 * Kept out of db/queries.ts on purpose. That file's whole discipline is that
 * anything exposing a person goes through `eligible_members`; nothing here
 * exposes anyone, and mixing the two invites someone to reach for a Steam
 * predicate from a role query or, worse, to skip one over there because "the
 * roles code doesn't need it".
 */

import type { Database, Statement } from 'better-sqlite3';
import { inTransaction } from '../db/index.js';

const cache = new WeakMap<Database, Map<string, Statement>>();

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

export interface RolePanel {
  messageId: string;
  guildId: string;
  channelId: string;
  title: string;
  description: string;
  exclusive: boolean;
  createdBy: string;
}

export interface Binding {
  emojiKey: string;
  emojiRaw: string;
  roleId: string;
}

/** The maximum bindings on one panel. Discord stops showing reactions past 20. */
export const MAX_BINDINGS = 20;

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

const SQL_CREATE_PANEL = `
  INSERT INTO role_panels (message_id, guild_id, channel_id, title, description, exclusive, created_by)
  VALUES (@messageId, @guildId, @channelId, @title, @description, @exclusive, @createdBy)
`;

export function createPanel(db: Database, p: RolePanel): void {
  prep(db, SQL_CREATE_PANEL).run({
    messageId: p.messageId,
    guildId: p.guildId,
    channelId: p.channelId,
    title: p.title,
    description: p.description,
    exclusive: p.exclusive ? 1 : 0,
    createdBy: p.createdBy,
  });
}

const SQL_GET_PANEL = `
  SELECT message_id AS messageId, guild_id AS guildId, channel_id AS channelId,
         title, description, exclusive, created_by AS createdBy
  FROM role_panels WHERE message_id = ?
`;

type RawPanel = Omit<RolePanel, 'exclusive'> & { exclusive: number };

export function getPanel(db: Database, messageId: string): RolePanel | null {
  const row = prep(db, SQL_GET_PANEL).get(messageId) as RawPanel | undefined;
  return row === undefined ? null : { ...row, exclusive: row.exclusive === 1 };
}

const SQL_LIST_PANELS = `
  SELECT message_id AS messageId, guild_id AS guildId, channel_id AS channelId,
         title, description, exclusive, created_by AS createdBy
  -- rowid breaks the tie: created_at has one-second resolution, so two panels
  -- made in the same second would otherwise come back in an arbitrary order and
  -- newestPanel would pick whichever one SQLite felt like.
  FROM role_panels WHERE guild_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
`;

export function listPanels(db: Database, guildId: string, limit = 25): RolePanel[] {
  return (prep(db, SQL_LIST_PANELS).all(guildId, limit) as RawPanel[]).map((r) => ({
    ...r,
    exclusive: r.exclusive === 1,
  }));
}

/**
 * The panel a bare `/roles add` should target: the newest in this guild.
 *
 * Guessing at all is a deliberate convenience -- the common case is one panel,
 * and making every command carry a message id would be miserable. Every command
 * that uses it says which panel it acted on, so a wrong guess is visible
 * immediately rather than silently editing the wrong message.
 */
export function newestPanel(db: Database, guildId: string): RolePanel | null {
  return listPanels(db, guildId, 1)[0] ?? null;
}

const SQL_SET_EXCLUSIVE = `UPDATE role_panels SET exclusive = ? WHERE message_id = ?`;

export function setExclusive(db: Database, messageId: string, exclusive: boolean): void {
  prep(db, SQL_SET_EXCLUSIVE).run(exclusive ? 1 : 0, messageId);
}

const SQL_DELETE_PANEL = `DELETE FROM role_panels WHERE message_id = ?`;

/** Bindings go with it: reaction_roles has ON DELETE CASCADE. */
export function deletePanel(db: Database, messageId: string): boolean {
  return prep(db, SQL_DELETE_PANEL).run(messageId).changes > 0;
}

/* ------------------------------------------------------------------ *
 * Bindings
 * ------------------------------------------------------------------ */

const SQL_ADD_BINDING = `
  INSERT INTO reaction_roles (message_id, emoji_key, emoji_raw, role_id, position)
  VALUES (@messageId, @emojiKey, @emojiRaw, @roleId,
          (SELECT COALESCE(MAX(position), -1) + 1 FROM reaction_roles WHERE message_id = @messageId))
  ON CONFLICT(message_id, emoji_key) DO UPDATE SET
    emoji_raw = excluded.emoji_raw,
    role_id   = excluded.role_id
`;

export type AddResult = 'added' | 'replaced' | 'role_taken' | 'full';

/**
 * Bind an emoji to a role on a panel.
 *
 * 'role_taken' when a DIFFERENT emoji on this panel already grants the role.
 * Allowing it would mean two reactions holding one role between them: unreact
 * from either and the role vanishes while the other still shows as chosen.
 */
export function addBinding(
  db: Database,
  messageId: string,
  b: Binding,
): AddResult {
  return inTransaction(db, () => {
    const existingForEmoji = prep(
      db,
      `SELECT role_id AS roleId FROM reaction_roles WHERE message_id = ? AND emoji_key = ?`,
    ).get(messageId, b.emojiKey) as { roleId: string } | undefined;

    const clash = prep(
      db,
      `SELECT emoji_key AS emojiKey FROM reaction_roles
        WHERE message_id = ? AND role_id = ? AND emoji_key <> ?`,
    ).get(messageId, b.roleId, b.emojiKey) as { emojiKey: string } | undefined;
    if (clash !== undefined) return 'role_taken';

    if (existingForEmoji === undefined && countBindings(db, messageId) >= MAX_BINDINGS) {
      return 'full';
    }

    prep(db, SQL_ADD_BINDING).run({ messageId, ...b });
    return existingForEmoji === undefined ? 'added' : 'replaced';
  });
}

const SQL_COUNT_BINDINGS = `SELECT COUNT(*) AS n FROM reaction_roles WHERE message_id = ?`;

export function countBindings(db: Database, messageId: string): number {
  return (prep(db, SQL_COUNT_BINDINGS).get(messageId) as { n: number }).n;
}

const SQL_LIST_BINDINGS = `
  SELECT emoji_key AS emojiKey, emoji_raw AS emojiRaw, role_id AS roleId
  FROM reaction_roles WHERE message_id = ? ORDER BY position ASC
`;

export function listBindings(db: Database, messageId: string): Binding[] {
  return prep(db, SQL_LIST_BINDINGS).all(messageId) as Binding[];
}

const SQL_FIND_BINDING = `
  SELECT rr.role_id AS roleId, rp.guild_id AS guildId, rp.exclusive AS exclusive
  FROM reaction_roles rr
  JOIN role_panels rp ON rp.message_id = rr.message_id
  WHERE rr.message_id = ? AND rr.emoji_key = ?
`;

/**
 * The hot path: one indexed primary-key probe per reaction event.
 *
 * Returns null for a reaction on a message we do not manage, which is almost
 * every reaction in the server -- so this has to be cheap and must never touch
 * the network.
 */
export function findBinding(
  db: Database,
  messageId: string,
  emojiKey: string,
): { roleId: string; guildId: string; exclusive: boolean } | null {
  const row = prep(db, SQL_FIND_BINDING).get(messageId, emojiKey) as
    | { roleId: string; guildId: string; exclusive: number }
    | undefined;
  return row === undefined ? null : { ...row, exclusive: row.exclusive === 1 };
}

const SQL_REMOVE_BY_ROLE = `DELETE FROM reaction_roles WHERE message_id = ? AND role_id = ?`;

export function removeBindingByRole(db: Database, messageId: string, roleId: string): Binding | null {
  return inTransaction(db, () => {
    const row = prep(
      db,
      `SELECT emoji_key AS emojiKey, emoji_raw AS emojiRaw, role_id AS roleId
         FROM reaction_roles WHERE message_id = ? AND role_id = ?`,
    ).get(messageId, roleId) as Binding | undefined;
    if (row === undefined) return null;
    prep(db, SQL_REMOVE_BY_ROLE).run(messageId, roleId);
    return row;
  });
}

/** Every other role on the panel, for exclusive mode. */
export function siblingRoleIds(db: Database, messageId: string, keepRoleId: string): string[] {
  const rows = prep(
    db,
    `SELECT role_id AS roleId FROM reaction_roles WHERE message_id = ? AND role_id <> ?`,
  ).all(messageId, keepRoleId) as { roleId: string }[];
  return rows.map((r) => r.roleId);
}

/**
 * Drop every binding in this guild that points at a role that no longer exists.
 * Called when a role is deleted, so a panel never offers a dead role.
 */
export function forgetRole(db: Database, guildId: string, roleId: string): number {
  return prep(
    db,
    `DELETE FROM reaction_roles
      WHERE role_id = ?
        AND message_id IN (SELECT message_id FROM role_panels WHERE guild_id = ?)`,
  ).run(roleId, guildId).changes;
}
