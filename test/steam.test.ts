import { describe, it, expect, vi } from 'vitest';

import { SteamUserError } from '../src/types.js';
import {
  parseSteamInput,
  resolveToId64,
  accountIdFromId64,
  toSteam2,
  toSteam3,
  STEAM_ID64_BASE,
} from '../src/steam/resolve.js';
import {
  fetchLibrary,
  getOwnedGames,
  getPlayerSummaries,
  steamJsonRequest,
  SteamApiError,
} from '../src/steam/client.js';
import { foldName, sanitizeName, iconUrl, headerUrl, storeUrl } from '../src/steam/sync.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/**
 * An internally consistent triple:
 *   accountid 27664202 -> STEAM_1:0:13832101 -> [U:1:27664202]
 *   id64 = 27664202 + 76561197960265728 = 76561197987929930
 */
const ID64 = '76561197987929930';
const ACCOUNT_ID = 27664202n;
const STEAM2 = 'STEAM_1:0:13832101';
const STEAM3 = '[U:1:27664202]';

/** An odd account id, so the low bit (Y) is exercised too. */
const ODD_ID64 = '76561197987929931';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

/** Steam answers *every* error with an HTML page, never JSON. */
function html(status: number, message = 'Unauthorized'): Response {
  return new Response(
    `<html><head><title>${status}</title></head><body><h1>${message}</h1></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=UTF-8' } },
  );
}

/** Routes stubbed responses by substring of the request URL. */
function stubFetch(routes: Array<[match: string, make: () => Response]>) {
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [match, make] of routes) {
      if (url.includes(match)) return make();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return impl as unknown as typeof fetch & typeof impl;
}

const SUMMARIES = 'GetPlayerSummaries';
const OWNED = 'GetOwnedGames';

const publicSummary = {
  response: {
    players: [
      {
        steamid: ID64,
        personaname: 'Tester',
        communityvisibilitystate: 3,
        avatarfull: 'https://avatars.example/full.jpg',
      },
    ],
  },
};

const privateSummary = {
  response: {
    players: [
      {
        steamid: ID64,
        personaname: 'Hidden',
        communityvisibilitystate: 1,
        avatarfull: 'https://avatars.example/full.jpg',
      },
    ],
  },
};

/** The literal body Steam returns when the library is not visible. */
const HIDDEN_LIBRARY = JSON.parse('{"response":{}}') as unknown;

const twoGames = {
  response: {
    game_count: 2,
    games: [
      { appid: 440, name: 'Team Fortress 2', playtime_forever: 1200, img_icon_url: 'abc123' },
      // playtime_2weeks absent on purpose: Steam omits it rather than sending 0.
      { appid: 570, name: 'Dota 2', playtime_forever: 0, img_icon_url: '' },
    ],
  },
};

const allZeroPlaytime = {
  response: {
    game_count: 2,
    games: [
      { appid: 440, name: 'Team Fortress 2', playtime_forever: 0, img_icon_url: 'abc123' },
      { appid: 570, name: 'Dota 2', playtime_forever: 0, img_icon_url: 'def456' },
    ],
  },
};

const emptyLibrary = { response: { game_count: 0, games: [] } };

/** No limiter, no retries, no real sleeping. */
const FAST = { maxAttempts: 1, sleep: async () => {}, random: () => 0.5 };

// ---------------------------------------------------------------------------
// parseSteamInput
// ---------------------------------------------------------------------------

describe('parseSteamInput', () => {
  it('accepts profile URLs in every shape', () => {
    for (const raw of [
      `https://steamcommunity.com/profiles/${ID64}`,
      `http://steamcommunity.com/profiles/${ID64}`,
      `https://www.steamcommunity.com/profiles/${ID64}/`,
      `steamcommunity.com/profiles/${ID64}`,
      `https://steamcommunity.com/profiles/${ID64}/games/?tab=all`,
    ]) {
      expect(parseSteamInput(raw), raw).toEqual({ kind: 'id64', id64: ID64 });
    }
  });

  it('accepts vanity URLs in every shape', () => {
    for (const raw of [
      'https://steamcommunity.com/id/gabelogannewell',
      'http://www.steamcommunity.com/id/gabelogannewell/',
      'steamcommunity.com/id/gabelogannewell',
      'https://steamcommunity.com/id/gabelogannewell/games/?tab=all',
    ]) {
      expect(parseSteamInput(raw), raw).toEqual({ kind: 'vanity', vanity: 'gabelogannewell' });
    }
  });

  it('accepts a bare vanity name and lowercases it', () => {
    expect(parseSteamInput('GabeLoganNewell')).toEqual({
      kind: 'vanity',
      vanity: 'gabelogannewell',
    });
    expect(parseSteamInput('  some_user-1 ')).toEqual({ kind: 'vanity', vanity: 'some_user-1' });
  });

  it('accepts a bare 17-digit id64', () => {
    expect(parseSteamInput(ID64)).toEqual({ kind: 'id64', id64: ID64 });
  });

  it('accepts steam3 with and without brackets', () => {
    expect(parseSteamInput(STEAM3)).toEqual({ kind: 'id64', id64: ID64 });
    expect(parseSteamInput('U:1:27664202')).toEqual({ kind: 'id64', id64: ID64 });
  });

  it('accepts steam2 and treats universe 0 and 1 as identical', () => {
    expect(parseSteamInput(STEAM2)).toEqual({ kind: 'id64', id64: ID64 });
    expect(parseSteamInput('STEAM_0:0:13832101')).toEqual({ kind: 'id64', id64: ID64 });
    // The universe digit must never enter the arithmetic.
    expect(parseSteamInput('STEAM_0:0:13832101')).toEqual(parseSteamInput('STEAM_1:0:13832101'));
  });

  it('uses the Y bit, not the universe digit, for odd account ids', () => {
    expect(parseSteamInput('STEAM_1:1:13832101')).toEqual({ kind: 'id64', id64: ODD_ID64 });
    expect(parseSteamInput('[U:1:27664203]')).toEqual({ kind: 'id64', id64: ODD_ID64 });
  });

  it('rejects a friend-invite link rather than treating it as a vanity', () => {
    expect(() => parseSteamInput('https://steamcommunity.com/user/abcd-efgh')).toThrow(
      SteamUserError,
    );
    expect(() => parseSteamInput('steamcommunity.com/user/abcd-efgh')).toThrow(/invite/i);
    expect(() => parseSteamInput('https://s.team/p/abcd-efgh')).toThrow(SteamUserError);
  });

  it('rejects groups', () => {
    expect(() => parseSteamInput('https://steamcommunity.com/groups/valve')).toThrow(
      SteamUserError,
    );
  });

  it('rejects garbage', () => {
    for (const raw of [
      '',
      '   ',
      '!!!',
      'not a steam id at all',
      'https://example.com/id/foo',
      '123',
      '12345678901234567', // 17 digits but not the individual prefix
      'STEAM_1:2:13832101', // Y must be 0 or 1
    ]) {
      expect(() => parseSteamInput(raw), raw).toThrow(SteamUserError);
    }
  });

  it('rejects a group id64 (isValid would accept it, isValidIndividual must not)', () => {
    // 103582791429521408 is the base of the clan/group ID space.
    expect(() => parseSteamInput('https://steamcommunity.com/profiles/103582791429521408')).toThrow(
      SteamUserError,
    );
  });
});

// ---------------------------------------------------------------------------
// BigInt conversion
// ---------------------------------------------------------------------------

describe('id64 arithmetic', () => {
  it('round-trips id64 <-> steam2 <-> steam3', () => {
    expect(accountIdFromId64(ID64)).toBe(ACCOUNT_ID);
    expect(toSteam2(ID64)).toBe(STEAM2);
    expect(toSteam3(ID64)).toBe(STEAM3);
    expect(parseSteamInput(toSteam2(ID64))).toEqual({ kind: 'id64', id64: ID64 });
    expect(parseSteamInput(toSteam3(ID64))).toEqual({ kind: 'id64', id64: ID64 });
  });

  it('is exact where Number would corrupt the low digits', () => {
    // The proof that BigInt is required: the base alone is past 2^53.
    expect(STEAM_ID64_BASE > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect((ACCOUNT_ID + STEAM_ID64_BASE).toString()).toBe(ID64);
    // Doing the same sum in float64 does not even reproduce the string.
    expect(String(Number(STEAM_ID64_BASE) + Number(ACCOUNT_ID))).not.toBe(ID64);
  });

  it('keeps every digit for a large modern account id', () => {
    // accountid 1234567890 -> 76561199194833618
    expect(parseSteamInput('[U:1:1234567890]')).toEqual({
      kind: 'id64',
      id64: '76561199194833618',
    });
    expect(toSteam2('76561199194833618')).toBe('STEAM_1:0:617283945');
    expect(toSteam3('76561199194833618')).toBe('[U:1:1234567890]');
  });
});

// ---------------------------------------------------------------------------
// ResolveVanityURL
// ---------------------------------------------------------------------------

describe('resolveToId64', () => {
  it('returns the id64 directly without an API call', async () => {
    const fetchImpl = stubFetch([]);
    await expect(resolveToId64(ID64, 'key', fetchImpl)).resolves.toBe(ID64);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a vanity name on success === 1', async () => {
    const fetchImpl = stubFetch([
      ['ResolveVanityURL', () => json({ response: { steamid: ID64, success: 1 } })],
    ]);
    await expect(resolveToId64('someone', 'key', fetchImpl, FAST)).resolves.toBe(ID64);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('vanityurl=someone');
    expect(url).toContain('key=key');
  });

  it('treats success === 42 (HTTP 200, "No match") as a user error', async () => {
    const fetchImpl = stubFetch([
      ['ResolveVanityURL', () => json({ response: { success: 42, message: 'No match' } })],
    ]);
    await expect(resolveToId64('nobody', 'key', fetchImpl, FAST)).rejects.toThrow(SteamUserError);
  });

  it('does not accept a non-1 success code that carries a steamid', async () => {
    const fetchImpl = stubFetch([
      ['ResolveVanityURL', () => json({ response: { steamid: ID64, success: 2 } })],
    ]);
    await expect(resolveToId64('weird', 'key', fetchImpl, FAST)).rejects.toThrow(SteamUserError);
  });

  it('never calls the API for an invite link', async () => {
    const fetchImpl = stubFetch([]);
    await expect(resolveToId64('steamcommunity.com/user/abcd', 'key', fetchImpl)).rejects.toThrow(
      SteamUserError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP hardening
// ---------------------------------------------------------------------------

describe('steamJsonRequest', () => {
  it('throws a typed error carrying the status instead of parsing HTML', async () => {
    const fetchImpl = stubFetch([['', () => html(401)]]);
    const err = await steamJsonRequest('https://api.steampowered.com/x', {
      fetchImpl,
      ...FAST,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SteamApiError);
    expect((err as SteamApiError).status).toBe(401);
    expect((err as SteamApiError).message).not.toContain('Unexpected token');
    expect((err as SteamApiError).retryable).toBe(false);
  });

  it('rejects a 200 that is not JSON', async () => {
    const fetchImpl = stubFetch([['', () => html(200, 'maintenance')]]);
    await expect(
      steamJsonRequest('https://api.steampowered.com/x', { fetchImpl, ...FAST }),
    ).rejects.toBeInstanceOf(SteamApiError);
  });

  it('retries 429 with backoff and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? html(429, 'Too Many Requests') : json({ ok: true });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    await expect(
      steamJsonRequest<{ ok: boolean }>('https://api.steampowered.com/x', {
        fetchImpl,
        maxAttempts: 3,
        random: () => 0.5,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]!).toBeGreaterThan(0);
  });

  it('does not retry a non-retryable status', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return html(403);
    }) as unknown as typeof fetch;
    await expect(
      steamJsonRequest('https://api.steampowered.com/x', {
        fetchImpl,
        maxAttempts: 3,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(SteamApiError);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Endpoint shaping
// ---------------------------------------------------------------------------

describe('getPlayerSummaries', () => {
  it('keys by steamid so omitted (nonexistent) ids cannot shift results', async () => {
    const missing = '76561197987929999';
    const fetchImpl = stubFetch([[SUMMARIES, () => json(publicSummary)]]);
    const map = await getPlayerSummaries([missing, ID64], 'key', { fetchImpl, ...FAST });
    expect(map.size).toBe(1);
    expect(map.get(missing)).toBeUndefined();
    expect(map.get(ID64)?.personaname).toBe('Tester');
  });

  it('chunks at 100 ids per request', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(BigInt(ID64) + BigInt(i)));
    const fetchImpl = stubFetch([[SUMMARIES, () => json({ response: { players: [] } })]]);
    await getPlayerSummaries(ids, 'key', { fetchImpl, ...FAST });
    expect(fetchImpl.mock.calls).toHaveLength(3);
  });
});

describe('getOwnedGames', () => {
  it('normalizes minutes and treats an absent playtime_2weeks as 0', async () => {
    const fetchImpl = stubFetch([[OWNED, () => json(twoGames)]]);
    const owned = await getOwnedGames(ID64, 'key', { fetchImpl, ...FAST });
    expect(owned.visible).toBe(true);
    expect(owned.gameCount).toBe(2);
    expect(owned.games[0]).toEqual({
      appid: 440,
      name: 'Team Fortress 2',
      playtimeForever: 1200,
      playtime2Weeks: 0,
      iconHash: 'abc123',
    });
    // An empty icon hash is legitimate and must survive as ''.
    expect(owned.games[1]?.iconHash).toBe('');
  });

  it('detects {"response":{}} as not visible rather than as an empty library', async () => {
    const fetchImpl = stubFetch([[OWNED, () => json(HIDDEN_LIBRARY)]]);
    const owned = await getOwnedGames(ID64, 'key', { fetchImpl, ...FAST });
    expect(owned.visible).toBe(false);
    expect(owned.gameCount).toBe(0);
  });

  it('requests appinfo and free games', async () => {
    const fetchImpl = stubFetch([[OWNED, () => json(emptyLibrary)]]);
    await getOwnedGames(ID64, 'key', { fetchImpl, ...FAST });
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('include_appinfo=true');
    expect(url).toContain('include_played_free_games=true');
  });
});

// ---------------------------------------------------------------------------
// fetchLibrary: all six ProfileStates
// ---------------------------------------------------------------------------

describe('fetchLibrary', () => {
  const run = (summary: unknown, owned: () => Response) =>
    fetchLibrary(ID64, 'key', {
      fetchImpl: stubFetch([
        [SUMMARIES, () => json(summary)],
        [OWNED, owned],
      ]),
      ...FAST,
    });

  it('public: games with playtime', async () => {
    const res = await run(publicSummary, () => json(twoGames));
    expect(res.state).toBe('public');
    expect(res.games).toHaveLength(2);
    expect(res.personaName).toBe('Tester');
    expect(res.avatarUrl).toBe('https://avatars.example/full.jpg');
  });

  it('playtime_hidden: games present but every playtime_forever is 0', async () => {
    const res = await run(publicSummary, () => json(allZeroPlaytime));
    expect(res.state).toBe('playtime_hidden');
    expect(res.games).toHaveLength(2);
  });

  it('empty: game_count 0 with a games key', async () => {
    const res = await run(publicSummary, () => json(emptyLibrary));
    expect(res.state).toBe('empty');
    expect(res.games).toEqual([]);
  });

  it('private: no game_count and the profile is not public', async () => {
    const res = await run(privateSummary, () => json(HIDDEN_LIBRARY));
    expect(res.state).toBe('private');
    expect(res.personaName).toBe('Hidden');
  });

  it('game_details_private: no game_count even though the profile IS public', async () => {
    const res = await run(publicSummary, () => json(HIDDEN_LIBRARY));
    expect(res.state).toBe('game_details_private');
    expect(res.games).toEqual([]);
  });

  it('error: the owned-games call fails with an HTML 401', async () => {
    const res = await run(publicSummary, () => html(401));
    expect(res.state).toBe('error');
    expect(res.games).toEqual([]);
    // The summary still succeeded, so the error message can still name the user.
    expect(res.personaName).toBe('Tester');
  });

  it('error: everything fails', async () => {
    const res = await fetchLibrary(ID64, 'key', {
      fetchImpl: stubFetch([['', () => html(500)]]),
      ...FAST,
    });
    expect(res.state).toBe('error');
    expect(res.personaName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sync helpers
// ---------------------------------------------------------------------------

describe('url helpers', () => {
  it('never builds an icon URL from an empty hash', () => {
    expect(iconUrl(440, '')).toBeNull();
    expect(iconUrl(440, 'abc123')).toBe(
      'https://media.steampowered.com/steamcommunity/public/images/apps/440/abc123.jpg',
    );
  });

  it('builds header and store URLs', () => {
    expect(headerUrl(440)).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg');
    expect(storeUrl(440)).toBe('https://store.steampowered.com/app/440');
  });
});

describe('name folding', () => {
  it('strips accents and folds case beyond ASCII', () => {
    expect(foldName('Pokémon')).toBe('pokemon');
    expect(foldName('Poke\u0301mon')).toBe('pokemon'); // already-decomposed form
    expect(foldName('ÖRTEL')).toBe('ortel');
    expect(foldName('ＤＯＯＭ')).toBe('doom'); // NFKC fullwidth -> ascii
    expect(foldName('  Half-Life   2 ')).toBe('half-life 2');
  });

  it('removes zero-width and direction-override characters', () => {
    // U+200B zero-width space, U+202E right-to-left override.
    const nasty = 'Half\u200bLife\u202e evil';
    expect(sanitizeName(nasty)).toBe('HalfLife evil');
    expect(foldName(nasty)).toBe('halflife evil');
    expect(sanitizeName('a\u200bb')).toBe('ab');
  });
});
