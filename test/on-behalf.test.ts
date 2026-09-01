import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema, openDb } from '../src/db/index.js';
import {
  ensureUser, findMatches, linkSteam, listGames, setOptedIn,
  touchGuildMember, unlink, whoOwns,
} from '../src/db/queries.js';
import { syncLibrary, type LibrarySource } from '../src/steam/sync.js';
import { addedMark, steamTag, whoEmbed, ADDED_MARK, ADDED_FOOTNOTE } from '../src/ui/embeds.js';
import type { LibraryResult, OwnedGame } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const G = 'guild-1';
const MOD = 'U_mod';
const FRIEND = 'U_friend';
const APP = 10;

const g = (appid: number, name: string, mins: number): OwnedGame => ({
  appid, name, playtimeForever: mins, playtime2Weeks: 0, iconHash: '',
});
const source = (games: OwnedGame[], persona: string): LibrarySource => ({
  async fetchLibrary(): Promise<LibraryResult> {
    return { state: 'public', personaName: persona, avatarUrl: null, games };
  },
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('registering a Steam account for someone else', () => {
  it('records who added it, and leaves a self-link unmarked', async () => {
    ensureUser(db, MOD);
    ensureUser(db, FRIEND);

    expect(linkSteam(db, MOD, '76561198000000001')).toEqual({ ok: true, wiped: false });
    expect(linkSteam(db, FRIEND, '76561198000000002', MOD)).toEqual({ ok: true, wiped: false });

    const rows = db
      .prepare('SELECT user_id, added_by FROM steam_accounts ORDER BY user_id')
      .all() as { user_id: string; added_by: string | null }[];
    expect(rows).toEqual([
      { user_id: FRIEND, added_by: MOD },
      { user_id: MOD, added_by: null },
    ]);
  });

  it('still refuses to attach a Steam ID that someone else already claimed', () => {
    ensureUser(db, MOD);
    ensureUser(db, FRIEND);
    linkSteam(db, MOD, '76561198000000001');
    // Even a moderator acting on behalf cannot move another user's claim.
    expect(linkSteam(db, FRIEND, '76561198000000001', MOD)).toEqual({
      ok: false,
      reason: 'claimed_by_other',
    });
  });

  it('makes the added person matchable and shows their Steam name', async () => {
    for (const [u, id, persona, games] of [
      [MOD, '76561198000000001', 'ModSteam', [g(APP, 'Deep Rock Galactic', 500)]],
      [FRIEND, '76561198000000002', 'FriendSteam', [g(APP, 'Deep Rock Galactic', 900)]],
    ] as const) {
      ensureUser(db, u);
      setOptedIn(db, u, true);
      touchGuildMember(db, G, u);
      linkSteam(db, u, id, u === FRIEND ? MOD : null);
      await syncLibrary(db, u, id, source([...games], persona));
    }

    const owners = whoOwns(db, G, APP, 30, 10);
    expect(owners.map((o) => o.userId)).toEqual([FRIEND, MOD]);

    const friend = owners.find((o) => o.userId === FRIEND)!;
    expect(friend.personaName).toBe('FriendSteam');
    expect(friend.addedBy).toBe(MOD);

    const mod = owners.find((o) => o.userId === MOD)!;
    expect(mod.personaName).toBe('ModSteam');
    expect(mod.addedBy).toBeNull();
  });

  it('carries the Steam name and flag into /match rows too', async () => {
    for (const [u, id, persona] of [
      [MOD, '76561198000000001', 'ModSteam'],
      [FRIEND, '76561198000000002', 'FriendSteam'],
    ] as const) {
      ensureUser(db, u);
      setOptedIn(db, u, true);
      touchGuildMember(db, G, u);
      linkSteam(db, u, id, u === FRIEND ? MOD : null);
      await syncLibrary(
        db, u, id,
        source([g(1, 'A', 100), g(2, 'B', 200), g(3, 'C', 300)], persona),
      );
    }
    const rows = findMatches(db, G, MOD, 30, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(FRIEND);
    expect(rows[0]!.personaName).toBe('FriendSteam');
    expect(rows[0]!.addedBy).toBe(MOD);
  });

  it('lets the added person remove themselves', async () => {
    ensureUser(db, FRIEND);
    setOptedIn(db, FRIEND, true);
    touchGuildMember(db, G, FRIEND);
    linkSteam(db, FRIEND, '76561198000000002', MOD);
    await syncLibrary(db, FRIEND, '76561198000000002', source([g(APP, 'DRG', 900)], 'FriendSteam'));
    expect(listGames(db, FRIEND, -1, 10, 0)).toHaveLength(1);

    unlink(db, FRIEND);
    setOptedIn(db, FRIEND, false);
    expect(listGames(db, FRIEND, -1, 10, 0)).toHaveLength(0);
    expect(whoOwns(db, G, APP, 0, 10)).toEqual([]);
  });
});

describe('listing markers', () => {
  it('renders the Steam name next to the mention', () => {
    expect(steamTag('FriendSteam')).toBe(' · FriendSteam');
    expect(steamTag(null)).toBe('');
  });

  it('marks only moderator-added entries', () => {
    expect(addedMark(MOD)).toContain(ADDED_MARK);
    expect(addedMark(null)).toBe('');
  });

  it('explains the marker in the footer only when one is present', () => {
    const base = {
      appid: APP, name: 'Deep Rock Galactic', filter: 30,
      iconUrl: null, storeUrl: 'https://store.steampowered.com/app/10/',
    };
    const withAdded = whoEmbed({
      ...base,
      owners: [{ userId: FRIEND, playtime: 900, personaName: 'FriendSteam', addedBy: MOD }],
    }).toJSON();
    expect(withAdded.footer?.text).toContain(ADDED_FOOTNOTE);
    expect(withAdded.description).toContain('FriendSteam');

    const selfOnly = whoEmbed({
      ...base,
      owners: [{ userId: MOD, playtime: 500, personaName: 'ModSteam', addedBy: null }],
    }).toJSON();
    expect(selfOnly.footer?.text ?? '').not.toContain(ADDED_MARK);
  });
});

describe('migration', () => {
  it('adds added_by to a database created before the column existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steammatch-'));
    const path = join(dir, 'old.sqlite');

    // Simulate the old schema: same table, without added_by.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE users (user_id TEXT PRIMARY KEY, opted_in INTEGER NOT NULL DEFAULT 0,
        discoverable INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at INTEGER) STRICT;
      CREATE TABLE steam_accounts (steam_id64 TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
        persona_name TEXT, profile_state TEXT NOT NULL DEFAULT 'unknown',
        linked_at INTEGER NOT NULL DEFAULT (unixepoch()), last_synced_at INTEGER,
        stale_after INTEGER, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0) STRICT;
    `);
    old.prepare('INSERT INTO users (user_id, opted_in) VALUES (?, 1)').run('legacy');
    old.prepare('INSERT INTO steam_accounts (steam_id64, user_id) VALUES (?, ?)')
      .run('76561198000000009', 'legacy');
    old.close();

    const migrated = openDb(path);
    const cols = (migrated.pragma('table_info(steam_accounts)') as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('added_by');
    // Existing rows survive and default to "self-linked".
    const row = migrated
      .prepare('SELECT user_id, added_by FROM steam_accounts')
      .get() as { user_id: string; added_by: string | null };
    expect(row).toEqual({ user_id: 'legacy', added_by: null });
    migrated.close();
  });
});
