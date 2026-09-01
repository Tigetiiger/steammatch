/**
 * Command registry plus the small amount of plumbing every command shares.
 */

import { MessageFlags } from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Database } from '../db/index.js';
import type { SteamClient } from '../steam/client.js';
import { DEFAULT_MIN_PLAYTIME, type Minutes } from '../types.js';
import { getGuildMinPlaytime } from '../db/queries.js';
import { looksLikeSteamToken, tokenRefusalEmbed, familySharingRow, noticeEmbed, COLORS } from '../ui/embeds.js';

export type Db = Database;

export interface BotContext {
  db: Db;
  steam: SteamClient;
  steamApiKey: string;
}

/**
 * Query row caps. The paginator holds its rows in memory, so every list query
 * gets an explicit ceiling rather than trusting a library to be small.
 */
export const ROW_LIMITS = {
  library: 5000,
  owners: 25,
  leaderboard: 200,
  matches: 100,
  autocomplete: 25,
} as const;

/** Prototype screen 8: "Games at least 2 members have played". */
export const LEADERBOARD_MIN_OWNERS = 2;

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}



/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Screen 9. Wired only into our own command string options -- reading arbitrary
 * message content would require the privileged MessageContent intent, which this
 * bot does not request.
 *
 * Returns true when the input was refused and the interaction is already answered.
 */
export async function refuseIfSteamToken(
  interaction: ChatInputCommandInteraction,
  value: string,
): Promise<boolean> {
  if (!looksLikeSteamToken(value)) return false;
  const payload = { embeds: [tokenRefusalEmbed()], components: [familySharingRow()] };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
  return true;
}

/** The effective playtime threshold: explicit option, else the guild default. */
export function resolveMinPlaytime(
  db: Db,
  guildId: string | null,
  option: number | null,
): Minutes {
  if (option !== null && Number.isFinite(option) && option >= 0) return Math.floor(option);
  if (guildId) {
    try {
      const g = getGuildMinPlaytime(db, guildId);
      if (typeof g === 'number' && Number.isFinite(g) && g >= 0) return g;
    } catch {
      /* fall through to the shared default */
    }
  }
  return DEFAULT_MIN_PLAYTIME;
}

/** Best-effort display name; falls back to the username. */
export function displayNameOf(
  interaction: ChatInputCommandInteraction,
  userId: string,
): string {
  const member = interaction.guild?.members.cache.get(userId);
  if (member) return member.displayName;
  if (interaction.user.id === userId) return interaction.user.displayName ?? interaction.user.username;
  return 'tema';
}

export function guildOnlyEmbed() {
  return noticeEmbed(
    'Käivita see serveris',
    'See käsk võrdleb sind serveri teiste liikmetega, seega töötab ainult serveris.',
    COLORS.warn,
  );
}

/* -------------------------------------------------------------------------- */
/* Direct reads                                                                */
/* -------------------------------------------------------------------------- */
/**
 * ASSUMPTION: src/db/queries.ts exposes only the mutators and list queries named
 * in the contract, with no plain getters for "is this user linked" / "is this
 * user discoverable". Those three reads are needed by /steam update and
 * /privacy, so they are done here as read-only SELECTs against the documented
 * schema. Everything else goes through queries.ts.
 */

function readRow(db: Db, sql: string, ...params: unknown[]): Record<string, unknown> | null {
  try {
    const row = db.prepare(sql).get(...params);
    return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
  } catch (err) {
    console.error('[db] direct read failed', sql, err);
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'boolean') return v;
  return fallback;
}
function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export interface LinkInfo {
  id64: string;
  personaName: string | null;
  lastSyncedAt: number | null;
}

export function getLinkInfo(db: Db, userId: string): LinkInfo | null {
  const row = readRow(
    db,
    'SELECT steam_id64, persona_name, last_synced_at FROM steam_accounts WHERE user_id = ?',
    userId,
  );
  const id64 = row ? asString(row['steam_id64']) : null;
  if (!id64) return null;
  return {
    id64,
    personaName: row ? asString(row['persona_name']) : null,
    lastSyncedAt: row && typeof row['last_synced_at'] === 'number' ? row['last_synced_at'] : null,
  };
}

export function getPrivacyState(
  db: Db,
  userId: string,
  guildId: string | null,
): { discoverable: boolean; guildVisible: boolean; optedIn: boolean } {
  // opted_in and deleted_at matter: eligible_members excludes on both, so
  // reporting only `discoverable` told an opted-out or forgotten user they were
  // visible to the guild when they were not.
  const u = readRow(
    db,
    'SELECT discoverable, opted_in, deleted_at FROM users WHERE user_id = ?',
    userId,
  );
  const g = guildId
    ? readRow(
        db,
        'SELECT visible FROM guild_members WHERE guild_id = ? AND user_id = ?',
        guildId,
        userId,
      )
    : null;
  const optedIn = asBool(u?.['opted_in'], false) && u?.['deleted_at'] == null;
  return {
    // Not discoverable in any useful sense unless consent is still on record.
    discoverable: optedIn && asBool(u?.['discoverable'], true),
    guildVisible: asBool(g?.['visible'], true),
    optedIn,
  };
}


export function getGuildStats(db: Db, guildId: string): { members: number; distinctGames: number } {
  const m = readRow(db, 'SELECT COUNT(*) AS c FROM eligible_members WHERE guild_id = ?', guildId);
  const d = readRow(
    db,
    `SELECT COUNT(DISTINCT ug.appid) AS c
       FROM user_games ug
       JOIN eligible_members em ON em.user_id = ug.user_id
      WHERE em.guild_id = ?`,
    guildId,
  );
  return { members: asNumber(m?.['c']), distinctGames: asNumber(d?.['c']) };
}

/** Relative "2 h ago" for the /games list footer. */
export function agoLabel(unixSeconds: number | null): string | null {
  if (unixSeconds === null || !Number.isFinite(unixSeconds)) return null;
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (secs < 90) return 'just nüüd';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min tagasi`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} h tagasi`;
  return `${Math.round(hours / 24)} p tagasi`;
}
