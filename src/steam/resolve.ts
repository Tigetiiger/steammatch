/**
 * Turn whatever a user pastes into a canonical 64-bit Steam ID.
 *
 * Everything here is BigInt arithmetic on purpose: the SteamID base constant
 * 76561197960265728 is larger than Number.MAX_SAFE_INTEGER (9007199254740991),
 * so doing this in `number` silently corrupts the low digits and produces a
 * plausible-looking but wrong account.
 */

import SteamID from 'steamid';
import { SteamUserError } from '../types.js';
import { steamJsonRequest, type SteamRequestOptions } from './client.js';

/** Base of the individual-account ID space: id64 = accountid + BASE. */
export const STEAM_ID64_BASE = 76561197960265728n;

export type SteamInput = { kind: 'id64'; id64: string } | { kind: 'vanity'; vanity: string };

/** Bare id64s always start with this prefix for individual accounts. */
const ID64_RE = /^7656119\d{10}$/;
/** [U:1:accountid] or U:1:accountid (the trailing :1 of an instanced form is ignored). */
const STEAM3_RE = /^\[?U:1:(\d{1,10})(?::\d+)?\]?$/i;
/** STEAM_0:Y:Z and STEAM_1:Y:Z -- universe 0 and 1 mean the same thing here. */
const STEAM2_RE = /^STEAM_([0-9]):([01]):(\d{1,10})$/i;
/** Steam vanity names: letters, digits, dash, underscore. */
const VANITY_RE = /^[A-Za-z0-9_-]{2,32}$/;
/** steamcommunity.com/<segment>/<value>, with optional scheme, subdomain, trailing path/query. */
const COMMUNITY_URL_RE =
  /^(?:https?:\/\/)?(?:[\w-]+\.)*steamcommunity\.com\/([A-Za-z]+)\/([^/?#\s]+)/i;
/** Short invite links: https://s.team/p/xxxx-yyyy */
const SHORT_INVITE_RE = /^(?:https?:\/\/)?(?:[\w-]+\.)*s\.team\/p\//i;

const INVITE_HELP =
  'See on sõbrakutse link, mitte profiili link. Ava oma profiil ja kopeeri aadressiribalt URL (kujul steamcommunity.com/id/sinunimi või steamcommunity.com/profiles/7656119...).';

/** Reject group/gameserver ids and malformed values early with one message. */
function assertIndividual(id64: string): string {
  let sid: SteamID;
  try {
    sid = new SteamID(id64);
  } catch {
    throw new SteamUserError(`"${id64}" ei ole kehtiv Steam ID.`);
  }
  // isValid() would also accept groups and game servers, which have no library.
  if (!sid.isValidIndividual()) {
    throw new SteamUserError(
      `"${id64}" ei ole isiklik Steami konto (gruppidel ja mänguserveritel ei ole mängukogu).`,
    );
  }
  return sid.getSteamID64();
}

function fromAccountId(accountId: bigint): string {
  if (accountId < 0n) throw new SteamUserError('Steami konto ID ei saa olla negatiivne.');
  return (accountId + STEAM_ID64_BASE).toString();
}

/** id64 -> account id (the "W" in [U:1:W]). */
export function accountIdFromId64(id64: string): bigint {
  return BigInt(id64) - STEAM_ID64_BASE;
}

/** id64 -> STEAM_1:Y:Z rendering, for round-trip tests and display. */
export function toSteam2(id64: string, universe: 0 | 1 = 1): string {
  const accountId = accountIdFromId64(id64);
  const y = accountId % 2n; // low bit
  const z = accountId / 2n; // integer division
  return `STEAM_${universe}:${y}:${z}`;
}

/** id64 -> [U:1:W] rendering. */
export function toSteam3(id64: string): string {
  return `[U:1:${accountIdFromId64(id64).toString()}]`;
}

/**
 * Classify raw user input. Throws SteamUserError on anything unusable --
 * notably friend-invite links, which look like vanity URLs but are not and would
 * make ResolveVanityURL answer a confusing "No match".
 */
export function parseSteamInput(raw: string): SteamInput {
  const input = (raw ?? '').trim();
  if (input === '') throw new SteamUserError('Steami profiili ei antud.');

  if (SHORT_INVITE_RE.test(input)) throw new SteamUserError(INVITE_HELP);

  const urlMatch = COMMUNITY_URL_RE.exec(input);
  if (urlMatch) {
    const segment = (urlMatch[1] ?? '').toLowerCase();
    const value = decodeURIComponent(urlMatch[2] ?? '');
    switch (segment) {
      case 'profiles':
        if (!/^\d{17,20}$/.test(value)) {
          throw new SteamUserError(`"${value}" ei ole kehtiv Steam ID.`);
        }
        return { kind: 'id64', id64: assertIndividual(value) };
      case 'id':
        if (!VANITY_RE.test(value)) {
          throw new SteamUserError(`"${value}" ei ole kehtiv Steami kohandatud nimi.`);
        }
        return { kind: 'vanity', vanity: value.toLowerCase() };
      case 'user':
        // /user/<code> is a friend INVITE link. It is NOT a vanity URL.
        throw new SteamUserError(INVITE_HELP);
      case 'groups':
      case 'gid':
        throw new SteamUserError('See on Steami grupp, mitte kasutaja profiil.');
      default:
        throw new SteamUserError(
          'See Steami link ei viita profiilile. Kasuta steamcommunity.com/id/... või /profiles/...',
        );
    }
  }

  if (ID64_RE.test(input)) return { kind: 'id64', id64: assertIndividual(input) };

  const s3 = STEAM3_RE.exec(input);
  if (s3) {
    // [U:1:W] -> id64 = W + BASE
    return { kind: 'id64', id64: assertIndividual(fromAccountId(BigInt(s3[1] ?? '0'))) };
  }

  const s2 = STEAM2_RE.exec(input);
  if (s2) {
    // STEAM_X:Y:Z -> id64 = Z*2 + Y + BASE. X (universe) is deliberately unused:
    // STEAM_0 and STEAM_1 denote the same public account.
    const y = BigInt(s2[2] ?? '0');
    const z = BigInt(s2[3] ?? '0');
    return { kind: 'id64', id64: assertIndividual(fromAccountId(z * 2n + y)) };
  }

  // A bare number that is not a valid id64 is a mistake, not a vanity name.
  if (/^\d+$/.test(input)) throw new SteamUserError(`"${input}" ei ole kehtiv Steam ID.`);

  if (VANITY_RE.test(input)) return { kind: 'vanity', vanity: input.toLowerCase() };

  throw new SteamUserError(
    `Ei suutnud "${input}" Steami profiilina lugeda. Kleebi oma profiili aadress, kohandatud nimi või 17-kohaline Steam ID.`,
  );
}

interface VanityEnvelope {
  response?: { steamid?: string; success?: number; message?: string };
}

/**
 * Resolve any accepted input to a validated id64, calling ResolveVanityURL only
 * when the input is actually a vanity name.
 */
export async function resolveToId64(
  raw: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
  opts: SteamRequestOptions = {},
): Promise<string> {
  const parsed = parseSteamInput(raw);
  if (parsed.kind === 'id64') return parsed.id64;

  const url =
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/` +
    `?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(parsed.vanity)}`;

  const body = await steamJsonRequest<VanityEnvelope>(url, {
    ...opts,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const response = body.response ?? {};
  // Failure is HTTP 200 with success === 42 ("no match"). Only 1 means success,
  // so branch strictly rather than treating "not 42" as OK.
  if (response.success !== 1 || typeof response.steamid !== 'string') {
    throw new SteamUserError(
      `Nime "${parsed.vanity}" jaoks ei leitud Steami kontot. Kontrolli õigekirja või kleebi profiili täisaadress.`,
    );
  }

  return assertIndividual(response.steamid);
}
