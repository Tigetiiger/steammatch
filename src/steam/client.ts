/**
 * Steam Web API client.
 *
 * Three things make this API hostile and drive most of the code below:
 *  1. It answers errors with an HTML error page, HTTP status only, no JSON. Parsing
 *     without checking status + content-type yields `Unexpected token '<'`.
 *  2. It signals "you may not see this" with HTTP 200 and an EMPTY object.
 *  3. It has an undocumented rate limit, returns 429 with no Retry-After, and will
 *     start 5xx-ing under load. So: token bucket + capped backoff with jitter.
 */

import type { LibraryResult, OwnedGame, ProfileState } from '../types.js';

const API = 'https://api.steampowered.com';

/** Steam's own cap for GetPlayerSummaries. Exceeding it fails the whole call. */
export const MAX_SUMMARY_IDS = 100;

/** Strips the API key out of a Steam request URL. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]key=)[^&]*/gi, '$1REDACTED');
}

export class SteamApiError extends Error {
  readonly url?: string;
  /** Forces retryable regardless of status (e.g. HTTP 200 serving a maintenance page). */
  readonly transient: boolean = false;

  constructor(
    message: string,
    readonly status: number | null,
    url?: string,
    transient = false,
  ) {
    super(message);
    this.name = 'SteamApiError';
    this.transient = transient;
    // The request URL carries `key=<STEAM_API_KEY>`. console.error(err) prints own
    // enumerable properties via util.inspect, which would put the key in the logs
    // on every Steam outage. Keep it redacted AND non-enumerable.
    if (url !== undefined) {
      Object.defineProperty(this, 'url', {
        value: redactUrl(url),
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }

  /** 429 and 5xx are transient; 4xx (bad key, forbidden) is not. */
  get retryable(): boolean {
    if (this.transient) return true;
    if (this.status === null) return true; // network error / timeout
    return this.status === 429 || this.status >= 500;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Token bucket + concurrency gate. Sustained rate is one request per
 * `minIntervalMs`; short bursts up to `burst` tokens are allowed, and never more
 * than `maxConcurrent` requests are in flight at once.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly minIntervalMs = 1000,
    private readonly burst = 2,
    private readonly maxConcurrent = 2,
  ) {
    this.tokens = burst;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    if (this.minIntervalMs <= 0) {
      this.tokens = this.burst;
      this.lastRefill = now;
      return;
    }
    const gained = elapsed / this.minIntervalMs;
    if (gained >= 1) {
      this.tokens = Math.min(this.burst, this.tokens + Math.floor(gained));
      // Keep the fractional remainder so slow drips still accumulate.
      this.lastRefill = now - (elapsed % this.minIntervalMs);
    }
  }

  /** Resolves when it is this caller's turn; call the returned function when done. */
  async acquire(): Promise<() => void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1 && this.inFlight < this.maxConcurrent) {
        this.tokens -= 1;
        this.inFlight += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inFlight -= 1;
          const next = this.waiters.shift();
          if (next) next();
        };
      }
      const waitForToken =
        this.tokens < 1 && this.minIntervalMs > 0
          ? Math.max(1, Math.ceil((1 - this.tokens) * this.minIntervalMs))
          : 0;
      if (waitForToken > 0) {
        await delay(waitForToken);
      } else {
        // Blocked on concurrency only: park until a slot is released.
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

export interface SteamRequestOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  /** Total attempts including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Injectable sleep so tests do not actually wait for backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for deterministic jitter in tests. */
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * GET a Steam Web API endpoint and parse JSON, defending against the HTML error
 * pages Steam serves for every failure mode.
 */
export async function steamJsonRequest<T>(url: string, opts: SteamRequestOptions = {}): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const limiter = opts.limiter;
  const sleep = opts.sleep ?? delay;
  const random = opts.random ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: SteamApiError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const release = limiter ? await limiter.acquire() : null;
    let error: SteamApiError | null = null;
    try {
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });

      if (!res.ok) {
        // Body here is an HTML error page. Read a little of it for the log only.
        const snippet = await safeSnippet(res);
        error = new SteamApiError(
          `Steam API ${res.status}${snippet ? `: ${snippet}` : ''}`,
          res.status,
          url,
        );
      } else {
        const ctype = res.headers.get('content-type') ?? '';
        if (!ctype.toLowerCase().includes('json')) {
          // 200 + HTML happens too (maintenance pages, captive portals).
          const snippet = await safeSnippet(res);
          error = new SteamApiError(
            `Steam API returned non-JSON (${ctype || 'no content-type'})${snippet ? `: ${snippet}` : ''}`,
            res.status,
            url,
            true, // transient: a maintenance page is the most retryable failure there is
          );
        } else {
          const body = await res.text();
          try {
            return JSON.parse(body) as T;
          } catch {
            error = new SteamApiError('Steam API returned malformed JSON', res.status, url);
          }
        }
      }
    } catch (err) {
      if (err instanceof SteamApiError) {
        error = err;
      } else {
        const name = err instanceof Error ? err.name : '';
        const msg = err instanceof Error ? err.message : String(err);
        error = new SteamApiError(
          name === 'TimeoutError' || name === 'AbortError'
            ? `Steam API request timed out after ${timeoutMs}ms`
            : `Steam API request failed: ${msg}`,
          null,
          url,
        );
      }
    } finally {
      if (release) release();
    }

    // Unreachable unless the try block neither returned nor set `error`.
    if (error === null) break;
    lastError = error;
    if (!error.retryable || attempt === maxAttempts - 1) break;

    // Exponential backoff with full-ish jitter; Steam sends no Retry-After.
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    await sleep(Math.round(ceiling * (0.5 + random() * 0.5)));
  }

  throw lastError ?? new SteamApiError('Steam API request failed', null, url);
}

async function safeSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    // Proxies, captive portals and custom error pages echo the request URI --
    // which carries key=<STEAM_API_KEY> -- into their body. This snippet ends up
    // in err.message, which IS printed by console.error, so redact it here too.
    return redactUrl(text.replace(/\s+/g, ' ').trim()).slice(0, 120);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface PlayerSummary {
  steamid: string;
  personaname: string;
  /** 1 = private/friends-only, 3 = public. Anything else is treated as not public. */
  communityvisibilitystate: number;
  profileurl?: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
}

interface SummariesEnvelope {
  response?: { players?: PlayerSummary[] };
}

interface OwnedGamesEnvelope {
  response?: {
    game_count?: number;
    games?: Array<{
      appid: number;
      name?: string;
      playtime_forever?: number;
      playtime_2weeks?: number;
      img_icon_url?: string;
    }>;
  };
}

/** What Steam told us about a library, before it is interpreted into a ProfileState. */
export interface OwnedGamesResult {
  /**
   * False when the response was `{"response":{}}` -- i.e. no `game_count` key.
   * That is Steam's silent "you may not see this", not an error.
   */
  visible: boolean;
  gameCount: number;
  games: OwnedGame[];
}

/**
 * Fetch summaries for up to any number of ids (chunked at 100).
 * Nonexistent / deleted ids are silently omitted by Steam, so the result is a Map
 * keyed by steamid -- never zip the response with the request by index.
 */
export async function getPlayerSummaries(
  ids: readonly string[],
  apiKey: string,
  opts: SteamRequestOptions = {},
): Promise<Map<string, PlayerSummary>> {
  const out = new Map<string, PlayerSummary>();
  for (let i = 0; i < ids.length; i += MAX_SUMMARY_IDS) {
    const chunk = ids.slice(i, i + MAX_SUMMARY_IDS);
    if (chunk.length === 0) continue;
    const url =
      `${API}/ISteamUser/GetPlayerSummaries/v2/` +
      `?key=${encodeURIComponent(apiKey)}&steamids=${chunk.map(encodeURIComponent).join(',')}`;
    const body = await steamJsonRequest<SummariesEnvelope>(url, opts);
    for (const player of body.response?.players ?? []) {
      if (player && typeof player.steamid === 'string') out.set(player.steamid, player);
    }
  }
  return out;
}

/** Null when Steam has no such account (omitted from `players`, not an error). */
export async function getPlayerSummary(
  id64: string,
  apiKey: string,
  opts: SteamRequestOptions = {},
): Promise<PlayerSummary | null> {
  const summaries = await getPlayerSummaries([id64], apiKey, opts);
  return summaries.get(id64) ?? null;
}

export async function getOwnedGames(
  id64: string,
  apiKey: string,
  opts: SteamRequestOptions = {},
): Promise<OwnedGamesResult> {
  const url =
    `${API}/IPlayerService/GetOwnedGames/v1/` +
    `?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(id64)}` +
    `&include_appinfo=true&include_played_free_games=true&format=json`;
  const body = await steamJsonRequest<OwnedGamesEnvelope>(url, opts);
  const response = body.response ?? {};

  // The whole diagnosis hinges on this: a hidden library is `{"response":{}}`.
  if (!('game_count' in response)) {
    return { visible: false, gameCount: 0, games: [] };
  }

  const games: OwnedGame[] = (response.games ?? []).map((g) => ({
    appid: g.appid,
    name: typeof g.name === 'string' && g.name.length > 0 ? g.name : `App ${g.appid}`,
    playtimeForever: g.playtime_forever ?? 0,
    // ABSENT (not 0) when the game was not played in the last two weeks.
    playtime2Weeks: g.playtime_2weeks ?? 0,
    // Bare SHA1 hash, may legitimately be ''.
    iconHash: typeof g.img_icon_url === 'string' ? g.img_icon_url : '',
  }));

  return { visible: true, gameCount: response.game_count ?? games.length, games };
}

// ---------------------------------------------------------------------------
// Library diagnosis
// ---------------------------------------------------------------------------

/**
 * Fetch summary + owned games in parallel and classify the outcome.
 *
 * The important distinction: a PUBLIC profile does not imply visible game details.
 * They are two separate privacy settings, which is why 'private' and
 * 'game_details_private' are different states with different advice.
 */
export async function fetchLibrary(
  id64: string,
  apiKey: string,
  opts: SteamRequestOptions = {},
): Promise<LibraryResult> {
  const [summaryRes, gamesRes] = await Promise.allSettled([
    getPlayerSummary(id64, apiKey, opts),
    getOwnedGames(id64, apiKey, opts),
  ]);

  const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  const personaName = summary?.personaname ?? null;
  const avatarUrl = summary?.avatarfull ?? summary?.avatarmedium ?? summary?.avatar ?? null;

  if (gamesRes.status === 'rejected') {
    return { state: 'error', personaName, avatarUrl, games: [] };
  }

  const owned = gamesRes.value;

  if (!owned.visible) {
    // No game_count key. Which privacy knob is responsible? Without the summary
    // we cannot tell, and guessing 'private' would send a user whose profile is
    // already public to change a setting that is not the problem.
    if (summaryRes.status === 'rejected') {
      return { state: 'error', personaName, avatarUrl, games: [] };
    }
    const state: ProfileState =
      summary && summary.communityvisibilitystate === 3 ? 'game_details_private' : 'private';
    return { state, personaName, avatarUrl, games: [] };
  }

  // Only trust the list when Steam agrees with itself. Under load it returns a
  // game_count with a missing or truncated games array; treating that as
  // authoritative deletes rows the user still owns.
  if (owned.games.length < owned.gameCount) {
    if (owned.gameCount === 0) {
      return { state: 'empty', personaName, avatarUrl, games: [] };
    }
    return { state: 'error', personaName, avatarUrl, games: [] };
  }

  if (owned.games.length === 0) {
    return { state: 'empty', personaName, avatarUrl, games: [] };
  }

  // "Always keep my total playtime private" leaves the list visible but zeroes it.
  const anyPlaytime = owned.games.some((g) => g.playtimeForever > 0);
  return {
    state: anyPlaytime ? 'public' : 'playtime_hidden',
    personaName,
    avatarUrl,
    games: owned.games,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SteamClientOptions extends SteamRequestOptions {
  /** Sustained request spacing in ms. Default 1000 (~1 req/sec). */
  minIntervalMs?: number;
  maxConcurrent?: number;
}

/** Holds the API key and ONE shared limiter so all calls share the same budget. */
export class SteamClient {
  private readonly opts: SteamRequestOptions;

  constructor(
    private readonly apiKey: string,
    options: SteamClientOptions = {},
  ) {
    const { minIntervalMs, maxConcurrent, ...rest } = options;
    this.opts = {
      ...rest,
      limiter:
        options.limiter ??
        new RateLimiter(minIntervalMs ?? 1000, Math.max(1, maxConcurrent ?? 2), maxConcurrent ?? 2),
    };
  }

  getPlayerSummary(id64: string): Promise<PlayerSummary | null> {
    return getPlayerSummary(id64, this.apiKey, this.opts);
  }

  getPlayerSummaries(ids: readonly string[]): Promise<Map<string, PlayerSummary>> {
    return getPlayerSummaries(ids, this.apiKey, this.opts);
  }

  getOwnedGames(id64: string): Promise<OwnedGamesResult> {
    return getOwnedGames(id64, this.apiKey, this.opts);
  }

  fetchLibrary(id64: string): Promise<LibraryResult> {
    return fetchLibrary(id64, this.apiKey, this.opts);
  }
}
