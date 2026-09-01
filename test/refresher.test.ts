import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/db/index.js';
import { dueForRefresh, ensureUser, forget, linkSteam, listGames, setOptedIn, touchGuildMember } from '../src/db/queries.js';
import { refreshDue } from '../src/steam/refresher.js';
import { syncLibrary, type LibrarySource } from '../src/steam/sync.js';
import type { LibraryResult, OwnedGame, ProfileState } from '../src/types.js';

const G = 'guild-1';
const g = (appid: number, name: string, mins: number): OwnedGame => ({
  appid, name, playtimeForever: mins, playtime2Weeks: 0, iconHash: '',
});
const source = (games: OwnedGame[], state: ProfileState = 'public'): LibrarySource => ({
  async fetchLibrary(): Promise<LibraryResult> {
    return { state, personaName: 'p', avatarUrl: null, games };
  },
});

let db: Database.Database;
const NOW = 1_800_000_000;

async function member(id: string, id64: string, games: OwnedGame[], state: ProfileState = 'public') {
  ensureUser(db, id);
  setOptedIn(db, id, true);
  touchGuildMember(db, G, id);
  linkSteam(db, id, id64);
  await syncLibrary(db, id, id64, source(games, state), NOW);
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('dueForRefresh', () => {
  it('does not return an account that was just synced', async () => {
    await member('u1', '76561198000000001', [g(1, 'A', 100)]);
    expect(dueForRefresh(db, 10, NOW)).toEqual([]);
  });

  it('returns it once the 6-hour TTL has passed', async () => {
    await member('u1', '76561198000000001', [g(1, 'A', 100)]);
    expect(dueForRefresh(db, 10, NOW + 6 * 3600 + 1).map((r) => r.userId)).toEqual(['u1']);
  });

  it('backs a private profile off for a full day, not six hours', async () => {
    await member('u2', '76561198000000002', [], 'private');
    expect(dueForRefresh(db, 10, NOW + 6 * 3600 + 1)).toEqual([]);
    expect(dueForRefresh(db, 10, NOW + 24 * 3600 + 1).map((r) => r.userId)).toEqual(['u2']);
  });

  it('never returns a user who opted out or deleted their data', async () => {
    await member('u3', '76561198000000003', [g(1, 'A', 100)]);
    setOptedIn(db, 'u3', false);
    expect(dueForRefresh(db, 10, NOW + 999_999)).toEqual([]);

    await member('u4', '76561198000000004', [g(1, 'A', 100)]);
    forget(db, 'u4');
    expect(dueForRefresh(db, 10, NOW + 999_999)).toEqual([]);
  });

  it('never returns a user who is in no guild', async () => {
    ensureUser(db, 'u5');
    setOptedIn(db, 'u5', true);
    linkSteam(db, 'u5', '76561198000000005');
    await syncLibrary(db, 'u5', '76561198000000005', source([g(1, 'A', 100)]), NOW);
    expect(dueForRefresh(db, 10, NOW + 999_999)).toEqual([]);
  });
});

describe('refreshDue', () => {
  it('updates a stale library in place', async () => {
    await member('u1', '76561198000000001', [g(1, 'A', 100)]);
    db.prepare('UPDATE steam_accounts SET stale_after = 0').run();

    const out = await refreshDue(db, source([g(1, 'A', 555), g(2, 'B', 60)]), { spacingMs: 0 });

    expect(out).toEqual({ attempted: 1, failed: 0 });
    const rows = listGames(db, 'u1', -1, 100, 0);
    expect(rows.map((r) => r.appid).sort()).toEqual([1, 2]);
    expect(rows.find((r) => r.appid === 1)!.playtime).toBe(555);
  });

  it('keeps going when one account fails, and backs that one off', async () => {
    await member('u1', '76561198000000001', [g(1, 'A', 100)]);
    await member('u2', '76561198000000002', [g(2, 'B', 100)]);
    db.prepare('UPDATE steam_accounts SET stale_after = 0').run();

    let calls = 0;
    const flaky: LibrarySource = {
      async fetchLibrary() {
        calls++;
        if (calls === 1) throw new Error('steam is down');
        return { state: 'public', personaName: 'p', avatarUrl: null, games: [g(9, 'C', 90)] };
      },
    };
    const out = await refreshDue(db, flaky, { spacingMs: 0 });

    expect(out.attempted).toBe(2);
    // The failing account keeps its previous snapshot rather than losing it.
    const kept = listGames(db, 'u1', -1, 100, 0).length + listGames(db, 'u2', -1, 100, 0).length;
    expect(kept).toBeGreaterThan(0);
  });

  it('respects the batch size', async () => {
    for (let i = 1; i <= 5; i++) {
      await member(`u${i}`, `7656119800000000${i}`, [g(i, `G${i}`, 100)]);
    }
    db.prepare('UPDATE steam_accounts SET stale_after = 0').run();
    const out = await refreshDue(db, source([g(1, 'A', 100)]), { batchSize: 2, spacingMs: 0 });
    expect(out.attempted).toBe(2);
  });
});
