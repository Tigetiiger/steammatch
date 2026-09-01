import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { applySchema } from '../src/db/index.js';
import { ensureUser, hasStoredConsent, linkSteam, listGames, setOptedIn, forget, unlink } from '../src/db/queries.js';
import { SteamApiError, redactUrl, fetchLibrary } from '../src/steam/client.js';
import { escapeMd, safeName } from '../src/ui/embeds.js';
import { syncLibrary, type LibrarySource } from '../src/steam/sync.js';
import type { LibraryResult, OwnedGame } from '../src/types.js';

const KEY = 'AB12$&^*(CD.+?[]';

describe('the Steam API key never reaches a log line', () => {
  const url = `https://api.steampowered.com/x/?key=${encodeURIComponent(KEY)}&steamid=1`;

  it('is not an enumerable property of the error', () => {
    const e = new SteamApiError('boom', 500, url);
    expect(Object.keys(e)).not.toContain('url');
    expect(inspect(e)).not.toContain(KEY);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(e.stack ?? '').not.toContain(KEY);
  });

  it('is redacted even in the stored url', () => {
    expect(new SteamApiError('boom', 500, url).url).toContain('key=REDACTED');
  });

  it('redacts every query-string shape', () => {
    for (const u of [
      `https://x/?key=${KEY}`,
      `https://x/?a=1&key=${KEY}`,
      `https://x/?a=1&KEY=${KEY}&b=2`,
    ]) {
      expect(redactUrl(u)).not.toContain(KEY);
    }
  });

  it('a key full of regex metacharacters cannot corrupt the replacement', () => {
    // Real URLs are built with encodeURIComponent, so the value never contains a
    // bare `&` to terminate the parameter early.
    const enc = encodeURIComponent(KEY);
    expect(redactUrl(`https://x/?key=${enc}&b=2`)).toBe('https://x/?key=REDACTED&b=2');
    expect(redactUrl(`https://x/?key=${enc}&b=2`)).not.toContain(enc);
  });
});

describe('untrusted names cannot inject into an embed', () => {
  it('kills masked links', () => {
    expect(safeName('[Steam Support](https://phish.example)')).not.toMatch(/\[.*\]\(.*\)/);
  });

  it('defangs bare URLs, which Discord autolinks even when markdown is escaped', () => {
    expect(safeName('verify at https://phish.example')).not.toContain('https://');
  });

  it('escapes headings and bullets on EVERY line, not just the first', () => {
    const out = escapeMd('ok\n# HEADING\n- bullet\n1. ordered');
    expect(out).toContain('\\#');
    expect(out).toContain('\\-');
    expect(out).toContain('\\1.');
  });

  it('strips RTL overrides that would scramble the surrounding text', () => {
    expect(safeName('Bob‮drowssaP')).not.toContain('‮');
  });

  it('strips zero-width characters', () => {
    expect(safeName('Bob​Zero')).toBe('BobZero');
  });
});

const g = (appid: number, mins: number): OwnedGame => ({
  appid, name: `G${appid}`, playtimeForever: mins, playtime2Weeks: 0, iconHash: '',
});

function stubFetch(body: unknown, status = 200, contentType = 'application/json') {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    });
}

describe('a disagreeing Steam response never destroys a library', () => {
  const ID = '76561197960287930';
  let db: Database.Database;

  const source = (games: OwnedGame[], state: LibraryResult['state']): LibrarySource => ({
    async fetchLibrary() {
      return { state, personaName: 'p', avatarUrl: null, games };
    },
  });

  beforeEach(async () => {
    db = new Database(':memory:');
    applySchema(db);
    ensureUser(db, 'u');
    setOptedIn(db, 'u', true);
    linkSteam(db, 'u', ID);
    await syncLibrary(db, 'u', ID, source([g(1, 100), g(2, 200), g(3, 300)], 'public'));
    expect(listGames(db, 'u', -1, 100, 0)).toHaveLength(3);
  });

  it('classifies a truncated list as an error, not a smaller library', async () => {
    // game_count says 300 but only one game came back: Steam disagreeing with
    // itself. Trusting it would delete every other row the user owns.
    const lib = await fetchLibrary(ID, KEY, {
      fetchImpl: stubFetch({ response: { game_count: 300, games: [{ appid: 1, name: 'A', playtime_forever: 5 }] } }),
    } as never);
    expect(lib.state).toBe('error');
  });

  it('classifies game_count with no games array as an error', async () => {
    const lib = await fetchLibrary(ID, KEY, {
      fetchImpl: stubFetch({ response: { game_count: 300 } }),
    } as never);
    expect(lib.state).toBe('error');
  });

  it('keeps the snapshot on a single empty answer', async () => {
    const out = await syncLibrary(db, 'u', ID, source([], 'empty'));
    expect(out.removed).toBe(0);
    expect(listGames(db, 'u', -1, 100, 0)).toHaveLength(3);
  });

  it('still lets a genuinely emptied library clear on confirmation', async () => {
    await syncLibrary(db, 'u', ID, source([], 'empty'));
    await syncLibrary(db, 'u', ID, source([], 'empty'));
    expect(listGames(db, 'u', -1, 100, 0)).toHaveLength(0);
  });
});

describe('consent is required again after it is withdrawn', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    ensureUser(db, 'u');
  });

  it('is not on record before the user agrees', () => {
    expect(hasStoredConsent(db, 'u')).toBe(false);
  });

  it('is on record after opting in', () => {
    setOptedIn(db, 'u', true);
    expect(hasStoredConsent(db, 'u')).toBe(true);
  });

  it('is withdrawn by unlink and by forget', () => {
    setOptedIn(db, 'u', true);
    unlink(db, 'u');
    setOptedIn(db, 'u', false);
    expect(hasStoredConsent(db, 'u')).toBe(false);

    setOptedIn(db, 'u', true);
    forget(db, 'u');
    expect(hasStoredConsent(db, 'u')).toBe(false);
  });
});

describe('linkSteam refuses to take over someone else\'s account', () => {
  it('leaves the real owner untouched', () => {
    const db = new Database(':memory:');
    applySchema(db);
    ensureUser(db, 'victim');
    ensureUser(db, 'attacker');
    expect(linkSteam(db, 'victim', '76561198000000001')).toEqual({ ok: true, wiped: false });
    expect(linkSteam(db, 'attacker', '76561198000000001')).toEqual({
      ok: false,
      reason: 'claimed_by_other',
    });
    const owner = db
      .prepare('SELECT user_id FROM steam_accounts WHERE steam_id64 = ?')
      .get('76561198000000001') as { user_id: string };
    expect(owner.user_id).toBe('victim');
  });
});
