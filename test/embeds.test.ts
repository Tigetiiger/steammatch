/**
 * Pure-function tests. Nothing here opens a socket, a database or a Discord
 * connection -- src/ui/embeds.ts imports only discord.js builders and the shared
 * types, which is exactly why it can be tested like this.
 */

import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  escapeMd,
  fmtMinutes,
  fmtTotalHours,
  gameName,
  joinLines,
  leaderboardEmbed,
  libraryEmbed,
  looksLikeSteamToken,
  matchEmbed,
  profileStateMessage,
  sharedEmbed,
  truncate,
  whoEmbed,
} from '../src/ui/embeds.js';
import type { GameRow, LeaderRow, MatchRow, ProfileState, SharedRow } from '../src/types.js';

/* -------------------------------------------------------------------------- */

describe('fmtMinutes', () => {
  it('renders sub-hour playtime in bare minutes', () => {
    expect(fmtMinutes(45)).toBe('45m');
    expect(fmtMinutes(0)).toBe('0m');
    expect(fmtMinutes(59)).toBe('59m');
  });

  it('switches to one decimal hour at exactly 60 minutes', () => {
    expect(fmtMinutes(60)).toBe('1.0 h');
    expect(fmtMinutes(90)).toBe('1.5 h');
    expect(fmtMinutes(5999)).toBe('100.0 h');
  });

  it('drops the decimal from 100 hours up', () => {
    // 24720 minutes is the prototype's Deep Rock Galactic row.
    expect(fmtMinutes(24720)).toBe('412 h');
    expect(fmtMinutes(6000)).toBe('100 h');
  });

  it('adds a thousands separator to huge playtimes', () => {
    expect(fmtMinutes(60 * 1234)).toBe('1,234 h');
  });

  it('never produces NaN or negative output', () => {
    expect(fmtMinutes(Number.NaN)).toBe('0m');
    expect(fmtMinutes(-10)).toBe('0m');
  });

  it('formats aggregate totals as whole hours', () => {
    expect(fmtTotalHours(60 * 3847)).toBe('3,847 h');
    expect(fmtTotalHours(0)).toBe('0 h');
  });
});

/* -------------------------------------------------------------------------- */

describe('escapeMd', () => {
  it('neutralises every markdown character that could leak into the embed', () => {
    expect(escapeMd('*bold*')).toBe('\\*bold\\*');
    expect(escapeMd('_under_')).toBe('\\_under\\_');
    expect(escapeMd('~~strike~~')).toBe('\\~\\~strike\\~\\~');
    expect(escapeMd('`code`')).toBe('\\`code\\`');
    expect(escapeMd('||spoiler||')).toBe('\\|\\|spoiler\\|\\|');
    expect(escapeMd('> quote')).toBe('\\> quote');
  });

  it('escapes the backslash itself first so nothing double-unescapes', () => {
    expect(escapeMd('a\\*b')).toBe('a\\\\\\*b');
  });

  it('leaves ordinary game names untouched', () => {
    expect(escapeMd("Baldur's Gate 3")).toBe("Baldur's Gate 3");
    expect(escapeMd('Counter-Strike 2')).toBe('Counter-Strike 2');
  });

  it('is total over odd input', () => {
    expect(escapeMd('')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('never exceeds the limit, ellipsis included', () => {
    const out = truncate('x'.repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles degenerate limits', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', 1)).toBe('…');
  });
});

describe('joinLines', () => {
  it('drops whole trailing lines rather than cutting one in half', () => {
    const out = joinLines(['aaa', 'bbb', 'ccc'], 7);
    expect(out).toBe('aaa\nbbb');
  });

  it('still returns something when the very first line is oversized', () => {
    const out = joinLines(['y'.repeat(50)], 10);
    expect(out).toHaveLength(10);
  });

  it('defaults to the description limit', () => {
    const out = joinLines(Array.from({ length: 500 }, () => 'z'.repeat(50)));
    expect(out.length).toBeLessThanOrEqual(LIMITS.description);
  });
});

/* -------------------------------------------------------------------------- */

describe('defensive truncation against Discord limits', () => {
  const evil = '*'.repeat(300) + '_Game_';

  const gameRows = (n: number): GameRow[] =>
    Array.from({ length: n }, (_, i) => ({
      appid: i + 1,
      name: evil,
      playtime: 24720 - i,
      tracked: true,
    }));

  it('keeps a library page description under 4096 even with pathological names', () => {
    const e = libraryEmbed({
      displayName: evil,
      pageRows: gameRows(25),
      offset: 0,
      page: 0,
      pages: 3,
      matching: 25,
      matchingMinutes: 999_999,
      ownedTotal: 412,
      filter: 30,
      syncedAgo: '2 h ago',
    }).toJSON();
    expect((e.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);
    expect((e.title ?? '').length).toBeLessThanOrEqual(LIMITS.title);
    expect((e.footer?.text ?? '').length).toBeLessThanOrEqual(LIMITS.footer);
  });

  it('clips a single game name well inside the 1024 field-value limit', () => {
    const clipped = gameName('q'.repeat(5000));
    expect(clipped.length).toBeLessThanOrEqual(LIMITS.fieldValue);
    expect(clipped.length).toBeLessThanOrEqual(80);
    expect(truncate('q'.repeat(5000), LIMITS.fieldValue)).toHaveLength(LIMITS.fieldValue);
  });

  it('escapes game names so a title cannot italicise the rest of the embed', () => {
    const e = libraryEmbed({
      displayName: 'artur',
      pageRows: [{ appid: 1, name: '*Hell*_divers_', playtime: 4800 , tracked: true }],
      offset: 0,
      page: 0,
      pages: 1,
      matching: 1,
      matchingMinutes: 4800,
      ownedTotal: 1,
      filter: 30,
      syncedAgo: null,
    }).toJSON();
    expect(e.description).toContain('\\*Hell\\*\\_divers\\_');
  });

  it('keeps the other screens inside their limits too', () => {
    const shared: SharedRow[] = Array.from({ length: 25 }, (_, i) => ({
      appid: i,
      name: evil,
      mine: 24720,
      theirs: 18600,
      tracked: true,
    }));
    const s = sharedEmbed({
      meName: evil,
      themName: evil,
      pageRows: shared,
      offset: 0,
      page: 0,
      pages: 4,
      total: 100,
      myLibrarySize: 142,
      theirLibrarySize: 96,
      filter: 60,
    }).toJSON();
    expect((s.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);
    expect((s.title ?? '').length).toBeLessThanOrEqual(LIMITS.title);

    const w = whoEmbed({
      appid: 548430,
      name: evil,
      owners: Array.from({ length: 25 }, (_, i) => ({ userId: String(i), playtime: 100 * i, personaName: null, addedBy: null })),
      filter: 30,
      iconUrl: null,
      storeUrl: 'https://store.steampowered.com/app/548430',
    }).toJSON();
    expect((w.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);
    expect((w.title ?? '').length).toBeLessThanOrEqual(LIMITS.title);

    const matches: MatchRow[] = Array.from({ length: 25 }, (_, i) => ({
      userId: String(i),
      overlap: 68 - i,
      theirTotal: 96,
      jaccard: 0.3,
      personaName: null,
      addedBy: null,
    }));
    const m = matchEmbed({
      displayName: evil,
      pageRows: matches,
      offset: 0,
      page: 0,
      pages: 3,
      memberCount: 11,
      filter: 30,
      sort: 'overlap',
    }).toJSON();
    expect((m.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);

    const board: LeaderRow[] = Array.from({ length: 25 }, (_, i) => ({
      appid: i,
      name: evil,
      owners: 9 - (i % 8),
      guildMinutes: 128_400,
    }));
    const l = leaderboardEmbed({
      guildName: evil,
      pageRows: board,
      offset: 0,
      page: 0,
      pages: 5,
      memberCount: 11,
      distinctGames: 1204,
      filter: 30,
    }).toJSON();
    expect((l.description ?? '').length).toBeLessThanOrEqual(LIMITS.description);
    expect((l.title ?? '').length).toBeLessThanOrEqual(LIMITS.title);
  });
});

/* -------------------------------------------------------------------------- */

describe('matchEmbed', () => {
  it('shows BOTH overlap and taste on every row, whichever sort is active', () => {
    const rows: MatchRow[] = [{ userId: '42', overlap: 68, theirTotal: 96, jaccard: 0.32, personaName: null, addedBy: null }];
    for (const sort of ['overlap', 'taste'] as const) {
      const desc = matchEmbed({
        displayName: 'artur',
        pageRows: rows,
        offset: 0,
        page: 0,
        pages: 1,
        memberCount: 11,
        filter: 30,
        sort,
      }).toJSON().description;
      expect(desc).toContain('68 games');
      expect(desc).toContain('32%');
      expect(desc).toContain('<@42>');
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('looksLikeSteamToken', () => {
  const token =
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSJ9.eyJpc3MiOiJyOnBob2VuaXgiLCJzdWIiOiI3NjU2MTE5ODAwMDAwMDAwMSJ9.aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcdefg';

  it('catches a bare webapi_token', () => {
    expect(looksLikeSteamToken(token)).toBe(true);
  });

  it('catches one buried in a sentence or a query string', () => {
    expect(looksLikeSteamToken(`here you go: ${token} thanks`)).toBe(true);
    expect(looksLikeSteamToken(`https://example.test/?webapi_token=${token}`)).toBe(true);
  });

  it('catches a long bare eyJ blob with no dots', () => {
    expect(looksLikeSteamToken(`eyJ${'A'.repeat(80)}`)).toBe(true);
  });

  it('does not fire on ordinary command input', () => {
    expect(looksLikeSteamToken('https://steamcommunity.com/id/artur')).toBe(false);
    expect(looksLikeSteamToken('76561198000000001')).toBe(false);
    expect(looksLikeSteamToken('Deep Rock Galactic')).toBe(false);
    expect(looksLikeSteamToken('eyJ')).toBe(false);
    expect(looksLikeSteamToken('')).toBe(false);
  });

  it('is total over non-strings', () => {
    expect(looksLikeSteamToken(undefined)).toBe(false);
    expect(looksLikeSteamToken(null)).toBe(false);
    expect(looksLikeSteamToken(12345)).toBe(false);
    expect(looksLikeSteamToken({})).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('profileStateMessage', () => {
  const states: ProfileState[] = [
    'public',
    'private',
    'game_details_private',
    'playtime_hidden',
    'empty',
    'error',
  ];

  it('gives every ProfileState a non-empty title and description', () => {
    for (const s of states) {
      const m = profileStateMessage(s, 'arturplays', 30);
      expect(m.title.length, s).toBeGreaterThan(0);
      expect(m.description.length, s).toBeGreaterThan(0);
      expect(m.title.length, s).toBeLessThanOrEqual(LIMITS.title);
      expect(m.description.length, s).toBeLessThanOrEqual(LIMITS.description);
    }
  });

  it('gives every ProfileState a DISTINCT message', () => {
    const titles = new Set(states.map((s) => profileStateMessage(s, null, 30).title));
    const bodies = new Set(states.map((s) => profileStateMessage(s, null, 30).description));
    expect(titles.size).toBe(states.length);
    expect(bodies.size).toBe(states.length);
  });

  it('never collapses private and game_details_private -- different fixes', () => {
    const priv = profileStateMessage('private', 'arturplays', 30);
    const details = profileStateMessage('game_details_private', 'arturplays', 30);

    expect(priv.title).toBe('Your Steam profile is private');
    expect(priv.description).toContain('My profile');
    expect(priv.description).toContain('Public');
    expect(priv.description).not.toContain('Game details');

    expect(details.title).toBe("Your profile is public, but your game details aren't");
    expect(details.description).toContain('Game details');
    expect(details.description).toContain('Always keep my total playtime private');
  });

  it('offers the privacy-settings link only where it actually helps', () => {
    expect(profileStateMessage('private', null, 30).privacyHelp).toBe(true);
    expect(profileStateMessage('game_details_private', null, 30).privacyHelp).toBe(true);
    expect(profileStateMessage('playtime_hidden', null, 30).privacyHelp).toBe(true);
    expect(profileStateMessage('error', null, 30).privacyHelp).toBe(false);
    expect(profileStateMessage('empty', null, 30).privacyHelp).toBe(false);
  });

  it('escapes the persona name it interpolates', () => {
    const m = profileStateMessage('private', '*evil*', 30);
    expect(m.description).toContain('\\*evil\\*');
  });

  it('reports the active threshold in the game-details fix', () => {
    expect(profileStateMessage('game_details_private', null, 600).description).toContain('10.0 h');
  });
});
