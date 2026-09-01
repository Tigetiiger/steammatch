/**
 * Every user-facing string and embed lives here. Pure functions only -- nothing
 * in this file touches the network, the database or an interaction, which is why
 * test/embeds.test.ts can exercise all of it without a Discord connection.
 *
 * Wording, field layout, button labels and button order mirror prototype/ui.html.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type {
  GameRow,
  LeaderRow,
  MatchRow,
  Minutes,
  OwnerRow,
  ProfileState,
  SharedRow,
} from '../types.js';
import { dropLoneSurrogate, sanitizeName } from '../text.js';

/* -------------------------------------------------------------------------- */
/* Hard Discord limits. Truncate against these, never trust upstream data.      */
/* -------------------------------------------------------------------------- */

export const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  totalEmbed: 6000,
  fields: 25,
  buttonLabel: 80,
  choiceName: 100,
  choiceValue: 100,
} as const;

export const COLORS = {
  brand: 0x66c0f4, // steam blue
  ok: 0x248046,
  warn: 0xc9a35a,
  err: 0xda373c,
} as const;

export const STEAM_PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings';
export const FAMILY_SHARING_URL =
  'https://help.steampowered.com/en/faqs/view/054C-3167-DD7F-49D4';

/** Prototype screen 1 footer -- appears on every link-success embed. */
export const FAMILY_SHARING_FOOTER =
  "Steam only exposes games you purchased yourself — family-shared games can't be read by any bot.";

/* -------------------------------------------------------------------------- */
/* Formatting primitives                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Minutes -> the prototype's playtime string.
 *   < 60 min      -> "45m"
 *   < 100 hours   -> "6.5 h"
 *   >= 100 hours  -> "412 h"
 * Mirrors `fmt()` in prototype/ui.html exactly.
 */
export function fmtMinutes(m: Minutes): string {
  const mins = Number.isFinite(m) ? Math.max(0, Math.round(m)) : 0;
  if (mins < 60) return `${mins}m`;
  const h = mins / 60;
  return h >= 100 ? `${num(Math.round(h))} h` : `${h.toFixed(1)} h`;
}

/** Aggregate playtime, always whole hours with a thousands separator: "3,847 h". */
export function fmtTotalHours(m: Minutes): string {
  const mins = Number.isFinite(m) ? Math.max(0, m) : 0;
  return `${num(Math.round(mins / 60))} h`;
}

export function num(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Escape Discord markdown so a game called `*Hell*_divers_` cannot italicise the
 * rest of the embed. Backslash must be escaped first or we'd double-escape.
 *
 * Brackets, parens, `#` and `-` are included because Discord renders masked
 * links and headings inside embed descriptions, and Steam persona names and
 * guild names are attacker-controlled: a user named
 * `[Steam Support](https://phish.example)` would otherwise render a live link
 * inside our own "your profile is private" embed.
 */
const MD_CHARS = /([\\*_~`|>[\]()])/g;
/** `#` and `-` only start a heading or bullet at the beginning of a line. */
const MD_LINE_START = /^([ \t]*)([#-]+|\d+\.)/gm;
export function escapeMd(s: string): string {
  return String(s ?? '')
    .replace(MD_CHARS, '\\$1')
    .replace(MD_LINE_START, (_m, ws: string, marks: string) => `${ws}\\${marks}`);
}

/**
 * Render a name we did not author: a Steam persona, a guild name, a Discord
 * display name. Beyond markdown escaping this
 *   - strips invisibles (an RTL override in a persona name scrambles the embed),
 *   - defangs bare URLs, which Discord autolinks in embed descriptions even
 *     when every markdown character is escaped, so "Steam Support - verify at
 *     https://steamcomrnunity.example" would render as a live link in our voice.
 * Use this anywhere attacker-controlled text reaches a message or embed.
 */
export function safeName(raw: string | null | undefined, max = 80): string {
  const cleaned = sanitizeName(String(raw ?? ''));
  // Zero-width space after the scheme: invisible, but breaks link detection.
  // Applied last, because sanitizeName strips zero-width characters.
  return truncate(escapeMd(cleaned), max).replace(/(https?|steam):\/\//gi, '$1:\u200b//');
}

/** Truncate to `max` characters inclusive of the ellipsis. Never exceeds `max`. */
export function truncate(s: string, max: number): string {
  const str = String(s ?? '');
  if (max <= 0) return '';
  if (str.length <= max) return str;
  if (max === 1) return '…';
  return `${dropLoneSurrogate(str.slice(0, max - 1))}…`;
}

/**
 * Join lines into an embed description, dropping trailing lines that would push
 * us past the 4096-char cap rather than cutting a line in half.
 */
export function joinLines(lines: string[], max: number = LIMITS.description): string {
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    const add = out.length === 0 ? line.length : line.length + 1;
    if (len + add > max) break;
    out.push(line);
    len += add;
  }
  if (out.length === 0 && lines.length > 0) {
    return truncate(lines[0] ?? '', max);
  }
  return out.join('\n');
}

/** A game name, safe for an embed line: escaped, then clipped. */
export function gameName(name: string, max = 80): string {
  return truncate(escapeMd(name), max);
}

/* -------------------------------------------------------------------------- */
/* Steam session-token refusal (prototype screen 9)                            */
/* -------------------------------------------------------------------------- */

/**
 * True when `s` contains something shaped like a Steam `webapi_token` -- a JWT
 * (`eyJ...` header, three base64url segments), or a long bare `eyJ` blob.
 *
 * Deliberately a pure predicate: it is wired into the string options of our own
 * commands, never into a message-content listener (that would need a privileged
 * intent we do not and will not request).
 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/;
const BARE_BLOB_RE = /eyJ[A-Za-z0-9_-]{60,}/;
export function looksLikeSteamToken(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  if (s.length < 32) return false;
  return JWT_RE.test(s) || BARE_BLOB_RE.test(s);
}

export function tokenRefusalEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.err)
    .setTitle('Never send that to a bot — including me')
    .setDescription(
      [
        'That looks like a Steam **session token**. I deleted it without reading it, but you should treat it as compromised.',
        '',
        "Any bot asking you to paste one of those can also **delete your Steam family group** and **request purchases** with it. That's the standard Steam phishing script, and I will never ask you for one.",
        '',
        "I only ever use Steam's public API with my own key — which is also why family-shared games don't show up here.",
      ].join('\n'),
    );
}

export function familySharingRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('How family sharing works ↗')
      .setURL(FAMILY_SHARING_URL),
  );
}

/* -------------------------------------------------------------------------- */
/* Consent (prototype screen 3)                                                */
/* -------------------------------------------------------------------------- */

export function consentEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Before I import your library')
    .setDescription(
      [
        "Here's exactly what happens:",
        '',
        '• I store your **game names and playtime**, and your Steam ID.',
        "• Members of **this server only** can see which games you own and how long you've played them.",
        '• Your Steam ID itself is **never** shown to anyone.',
        '• **/steam unlink** deletes everything, immediately.',
        '',
        "I refresh your library about every 6 hours while you're using the bot.",
      ].join('\n'),
    );
}

export function consentRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`consent:${id}:yes`)
      .setStyle(ButtonStyle.Success)
      .setLabel('I agree — import my library'),
    new ButtonBuilder()
      .setCustomId(`consent:${id}:no`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancel'),
  );
}

/* -------------------------------------------------------------------------- */
/* Link success (prototype screen 1)                                           */
/* -------------------------------------------------------------------------- */

export interface LinkSuccess {
  personaName: string;
  avatarUrl: string | null;
  /** Every purchased game Steam returned. */
  ownedTotal: number;
  /** How many clear the matching threshold. */
  matchable: number;
  minPlaytime: Minutes;
  totalMinutes: Minutes;
  recentCount: number;
  refreshHours: number;
  guildName: string;
  /** Discord ID this was registered FOR, when a moderator added someone else. */
  forUserId?: string | null;
}

export function linkSuccessEmbed(s: LinkSuccess): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(COLORS.ok)
    .setAuthor({
      name: truncate(
        s.forUserId ? `Added ${s.personaName}` : `Linked to ${s.personaName}`,
        LIMITS.author,
      ),
      ...(s.avatarUrl ? { iconURL: s.avatarUrl } : {}),
    })
    .setDescription(
      joinLines([
        `Imported **${num(s.ownedTotal)} purchased ${plural(s.ownedTotal, 'game')}**.`,
        `**${num(s.matchable)}** have more than ${fmtMinutes(s.minPlaytime)} played — those are the ones used for matching.`,
        '',
        s.forUserId
          ? `Registered for <@${s.forUserId}> in **${safeName(s.guildName, 100)}**. They are matchable now, every listing shows it was added by you, and they can remove it themselves with **/privacy**.`
          : `You're now discoverable in **${safeName(s.guildName, 100)}**. Use **/privacy** to hide yourself at any time.`,
      ]),
    )
    .addFields(
      { name: 'Total playtime', value: fmtTotalHours(s.totalMinutes), inline: true },
      {
        name: 'Played recently',
        value: `${num(s.recentCount)} ${plural(s.recentCount, 'game')}`,
        inline: true,
      },
      { name: 'Next refresh', value: `in ${s.refreshHours} h`, inline: true },
    )
    .setFooter({ text: truncate(`${FAMILY_SHARING_FOOTER} Why?`, LIMITS.footer) });
  if (s.avatarUrl) e.setThumbnail(s.avatarUrl);
  return e;
}

/* -------------------------------------------------------------------------- */
/* Link failures (prototype screen 2) -- one distinct message per ProfileState  */
/* -------------------------------------------------------------------------- */

export interface StateMessage {
  title: string;
  description: string;
  color: number;
  /** Whether the "Open Steam privacy settings" link button helps here. */
  privacyHelp: boolean;
}

/**
 * Each ProfileState is a genuinely different problem with a different fix.
 * `private` and `game_details_private` in particular must NEVER be collapsed:
 * the second one is the case that trips up almost everyone.
 */
export function profileStateMessage(
  state: ProfileState,
  personaName: string | null,
  minPlaytime: Minutes = 30,
): StateMessage {
  const who = personaName ? `**${safeName(personaName, 64)}**` : 'that profile';
  switch (state) {
    case 'public':
      return {
        title: 'Library imported',
        description: `I can see ${who}'s games. You're all set.`,
        color: COLORS.ok,
        privacyHelp: false,
      };
    case 'private':
      return {
        title: 'Your Steam profile is private',
        description: [
          `I can't see anything on ${who}'s profile.`,
          '',
          '**Fix:** Steam → Profile → Edit Profile → Privacy Settings → set **My profile** to **Public**, then run the command again.',
        ].join('\n'),
        color: COLORS.err,
        privacyHelp: true,
      };
    case 'game_details_private':
      return {
        title: "Your profile is public, but your game details aren't",
        description: [
          'This trips up almost everyone — Steam has a **separate** setting for your games list.',
          '',
          '**Fix:** Steam → Profile → Edit Profile → Privacy Settings → **Game details** → **Public**.',
          '',
          `Also uncheck **"Always keep my total playtime private"** just below it, or every game imports as 0 minutes and nothing passes the ${fmtMinutes(minPlaytime)} filter.`,
        ].join('\n'),
        color: COLORS.warn,
        privacyHelp: true,
      };
    case 'playtime_hidden':
      return {
        title: 'I can see your games, but not your playtime',
        description: [
          `Every game on ${who} imported as 0 minutes, so nothing clears the ${fmtMinutes(minPlaytime)} filter and you won't match with anyone.`,
          '',
          '**Fix:** Steam → Profile → Edit Profile → Privacy Settings → uncheck **"Always keep my total playtime private"**, then run **/steam refresh**.',
        ].join('\n'),
        color: COLORS.warn,
        privacyHelp: true,
      };
    case 'empty':
      return {
        title: 'That Steam account owns no games',
        description: [
          `${who} is public and readable — there just isn't anything in it.`,
          '',
          "If that's the wrong account, run **/games add** again with the right profile URL. Remember that family-shared games belong to the person who bought them and never appear here.",
        ].join('\n'),
        color: COLORS.warn,
        privacyHelp: false,
      };
    case 'error':
      return {
        title: "Steam didn't answer",
        description: [
          "I couldn't reach Steam's API, so nothing was imported and nothing was changed.",
          '',
          'This is usually Steam being down for a few minutes. Try again shortly — if it keeps happening, it is on my side, not yours.',
        ].join('\n'),
        color: COLORS.err,
        privacyHelp: false,
      };
  }
}

export function profileStateEmbed(
  state: ProfileState,
  personaName: string | null,
  minPlaytime?: Minutes,
): EmbedBuilder {
  const m = profileStateMessage(state, personaName, minPlaytime);
  return new EmbedBuilder()
    .setColor(m.color)
    .setTitle(truncate(m.title, LIMITS.title))
    .setDescription(truncate(m.description, LIMITS.description));
}

/** "Open Steam privacy settings ↗" then "Try again" -- link first, per screen 2. */
export function retryRow(id: string, withPrivacyLink = true): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (withPrivacyLink) {
    row.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Open Steam privacy settings ↗')
        .setURL(STEAM_PRIVACY_URL),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`retry:${id}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Try again'),
  );
  return row;
}

/* -------------------------------------------------------------------------- */
/* Row renderers                                                               */
/* -------------------------------------------------------------------------- */

function rank(i: number): string {
  return `\`${String(i).padStart(2, ' ')}.\``;
}

/* --- /games list (prototype screen 4) ------------------------------------- */

export interface LibraryView {
  displayName: string;
  pageRows: GameRow[];
  offset: number;
  page: number;
  pages: number;
  matching: number;
  matchingMinutes: Minutes;
  ownedTotal: number;
  filter: Minutes;
  syncedAgo: string | null;
}

export function libraryEmbed(v: LibraryView): EmbedBuilder {
  // The total only counts games that actually have playtime, so a library of
  // hand-added games does not claim "0 h total" as though it were measured.
  const header =
    `**${num(v.matching)}** ${plural(v.matching, 'game')}` +
    (v.filter > 0 ? ` over ${fmtMinutes(v.filter)}` : '') +
    (v.matchingMinutes > 0 ? ` · ${fmtTotalHours(v.matchingMinutes)} total` : '');
  // An untracked (hand-added) game has NO playtime. Printing `0m` would read as
  // "never played" when it actually means "unknown", so mark it instead.
  const lines = v.pageRows.map((g, i) =>
    g.tracked
      ? `${rank(v.offset + i + 1)} **${gameName(g.name)}** · \`${fmtMinutes(g.playtime)}\``
      : `${rank(v.offset + i + 1)} **${gameName(g.name)}** · *added by hand*`,
  );
  const body = lines.length > 0 ? lines : ['*Nothing clears this filter.*'];
  const footer = [
    `Page ${v.page + 1}/${v.pages}`,
    v.syncedAgo ? `synced ${v.syncedAgo}` : null,
    `${num(v.ownedTotal)} games owned, ${num(v.matching)} above the filter`,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(`${escapeMd(v.displayName)}'s library`, LIMITS.title))
    .setDescription(joinLines([header, '', ...body]))
    .setFooter({ text: truncate(footer, LIMITS.footer) });
}

/* --- /games shared (prototype screen 5) ----------------------------------- */

export interface SharedView {
  meName: string;
  themName: string;
  pageRows: SharedRow[];
  offset: number;
  page: number;
  pages: number;
  total: number;
  myLibrarySize: number;
  theirLibrarySize: number;
  filter: Minutes;
}

export function sharedEmbed(v: SharedView): EmbedBuilder {
  const me = escapeMd(v.meName);
  const them = escapeMd(v.themName);
  // Playtime is deliberately not printed here -- only /games list shows hours.
  // The ordering still uses it (weaker playtime first), it is just not rendered.
  const lines = v.pageRows.map(
    (r, i) => `${rank(v.offset + i + 1)} **${gameName(r.name)}**`,
  );
  const body = lines.length > 0 ? lines : ['*No games in common above this filter.*'];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(
      truncate(
        `${me} & ${them} — ${num(v.total)} ${plural(v.total, 'game')} in common`,
        LIMITS.title,
      ),
    )
    .setDescription(
      joinLines([
        `Both played over ${fmtMinutes(v.filter)}. Sorted by whoever's played it least, so the top of the list is what you can actually play together tonight.`,
        '',
        ...body,
      ]),
    )
    .setFooter({
      text: truncate(
        `Showing ${num(v.pageRows.length)} of ${num(v.total)} · ${me} ${num(v.myLibrarySize)} games · ${them} ${num(v.theirLibrarySize)} games`,
        LIMITS.footer,
      ),
    });
}

/* --- /games who (prototype screen 6) -------------------------------------- */

export interface WhoView {
  appid: number;
  name: string;
  owners: OwnerRow[];
  filter: Minutes;
  iconUrl: string | null;
  storeUrl: string;
  /** Total eligible owners above the filter, which may exceed `owners.length`. */
  totalOwners?: number;
}

/**
 * The Steam account attached to a Discord user, rendered next to their mention.
 *
 * Matters most for accounts a moderator registered on someone else's behalf:
 * without it there is no way to see WHICH Steam library is attached to whom.
 * Returns '' when unknown so it can be interpolated unconditionally.
 */
export function steamTag(personaName: string | null | undefined): string {
  const name = safeName(personaName, 32);
  return name ? ` · ${name}` : '';
}

/**
 * Marks an entry a moderator registered for someone else rather than one the
 * user linked themselves. Those are unverified -- nobody confirmed the Steam
 * account really belongs to that person -- so listings must not present them
 * as equivalent to a self-link.
 */
export const ADDED_MARK = '✎';
export function addedMark(addedBy: string | null | undefined): string {
  return addedBy ? ` ${ADDED_MARK}` : '';
}
export const ADDED_FOOTNOTE = `${ADDED_MARK} added by a moderator, not self-linked`;

/** Deep Rock Galactic. The prototype has this easter egg; it stays. */
const DRG_APPID = 548430;

export function whoEmbed(v: WhoView): EmbedBuilder {
  const shown = v.owners.length;
  // The list is capped, but the headline count must describe reality: a game
  // with 40 owners should not claim it has 25.
  const n = v.totalOwners ?? shown;
  // Ranked by playtime, but the number itself belongs to /games list only.
  const lines = v.owners.map(
    (o, i) => `${rank(i + 1)} <@${o.userId}>${steamTag(o.personaName)}${addedMark(o.addedBy)}`,
  );
  const body = lines.length > 0 ? lines : ['*Nobody here has played it above this filter yet.*'];
  const footer = [
    v.appid === DRG_APPID ? 'Rock and Stone!' : null,
    n > shown ? `showing top ${num(shown)}` : null,
    v.owners.some((o) => o.addedBy) ? ADDED_FOOTNOTE : null,
    `min playtime ${fmtMinutes(v.filter)}`,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(escapeMd(v.name), LIMITS.title))
    .setURL(v.storeUrl)
    .setDescription(
      joinLines([
        `**${num(n)} ${plural(n, 'person', 'people')}** here ${n === 1 ? 'has' : 'have'} played it for more than ${fmtMinutes(v.filter)}.`,
        '',
        ...body,
      ]),
    )
    .setFooter({ text: truncate(footer, LIMITS.footer) })
    .setThumbnail(v.iconUrl);
}

export function whoRow(sessionId: string, count: number, storeUrl: string): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (count > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:ping`)
        .setStyle(ButtonStyle.Primary)
        .setLabel(truncate(`Ping ${count === 1 ? 'them' : `these ${count}`}`, LIMITS.buttonLabel)),
    );
  }
  row.addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Store page ↗').setURL(storeUrl),
  );
  return row;
}

/* --- /match (prototype screen 7) ------------------------------------------ */

export type MatchSort = 'overlap' | 'taste';

export interface MatchView {
  displayName: string;
  pageRows: MatchRow[];
  offset: number;
  page: number;
  pages: number;
  memberCount: number;
  filter: Minutes;
  sort: MatchSort;
}

/**
 * BOTH numbers appear on every row regardless of the active sort. That is a
 * deliberate product decision: sorting must never destroy information.
 */
export function matchEmbed(v: MatchView): EmbedBuilder {
  const lines = v.pageRows.map((m, i) => {
    const pct = `${Math.round(m.jaccard * 100)}%`;
    return (
      `${rank(v.offset + i + 1)} <@${m.userId}>${steamTag(m.personaName)}${addedMark(m.addedBy)}\n` +
      ` \`${num(m.overlap)} ${plural(m.overlap, 'game')}\` overlap · \`${pct}\` taste · ${num(m.theirTotal)} in their library`
    );
  });
  const body = lines.length > 0 ? lines : ['*Nobody else here clears this filter yet.*'];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(`People most like ${escapeMd(v.displayName)}`, LIMITS.title))
    .setDescription(
      joinLines([
        `Ranked across **${num(v.memberCount)} linked ${plural(v.memberCount, 'member')}** of this server, games with ${fmtMinutes(v.filter)}+ on both sides.`,
        '',
        ...body,
      ]),
    )
    .setFooter({
      text: truncate(
        `Overlap = shared games · Taste = shared ÷ combined, which ignores library size · sorted by ${v.sort}`,
        LIMITS.footer,
      ),
    });
}

export function matchSortRow(
  sessionId: string,
  active: MatchSort,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:overlap`)
      .setStyle(active === 'overlap' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setLabel('Rank by overlap'),
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:taste`)
      .setStyle(active === 'taste' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setLabel('Rank by taste'),
  );
}

/* --- /games leaderboard (prototype screen 8) ------------------------------ */

export interface LeaderboardView {
  /** 'guild' = the whole server's board; 'mine' = only games the caller has. */
  scope?: 'guild' | 'mine';
  guildName: string;
  pageRows: LeaderRow[];
  offset: number;
  page: number;
  pages: number;
  memberCount: number;
  distinctGames: number;
  filter: Minutes;
}

export function leaderboardEmbed(v: LeaderboardView): EmbedBuilder {
  const mine = v.scope === 'mine';
  const lines = v.pageRows.map(
    (g, i) =>
      `${rank(v.offset + i + 1)} **${gameName(g.name)}** · \`${num(g.owners)} ${plural(g.owners, 'person', 'people')}\``,
  );
  const empty = mine
    ? '*Nobody here shares a game with you yet.*'
    : '*No game here has two players above this filter yet.*';
  const body = lines.length > 0 ? lines : [empty];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(
      truncate(
        mine
          ? 'Your games — most shared here'
          : `${safeName(v.guildName, 80)} — most owned games`,
        LIMITS.title,
      ),
    )
    .setDescription(
      joinLines([
        mine
          ? `Games you have, ranked by how many people here have them too. Counts include you.`
          : `Games at least 2 members have played for ${fmtMinutes(v.filter)}+.`,
        '',
        ...body,
      ]),
    )
    .setFooter({
      text: truncate(
        `${num(v.memberCount)} linked ${plural(v.memberCount, 'member')} · ${num(v.distinctGames)} distinct games · page ${v.page + 1}/${v.pages}`,
        LIMITS.footer,
      ),
    });
}

/* -------------------------------------------------------------------------- */
/* /privacy                                                                    */
/* -------------------------------------------------------------------------- */

export interface PrivacyView {
  linked: boolean;
  discoverable: boolean;
  guildVisible: boolean;
  guildName: string;
}

export function privacyEmbed(v: PrivacyView): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Your privacy settings')
    .setDescription(
      joinLines([
        v.linked
          ? 'Your Steam library is linked. Your Steam ID itself is **never** shown to anyone.'
          : 'No Steam account linked yet — run **/games add** to get started.',
        '',
        `**Discoverable everywhere** — ${v.discoverable ? 'on' : 'off'}. When off you never appear in anyone's /match, /games who or /games leaderboard, in any server.`,
        `**Visible in ${safeName(v.guildName, 80)}** — ${v.guildVisible ? 'on' : 'off'}. Hides you in this one server only.`,
        '',
        '**Forget me** deletes your Steam link, your games and your playtime immediately. It cannot be undone.',
      ]),
    );
}

export function privacyRows(
  sessionId: string,
  v: PrivacyView,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:discoverable`)
        .setStyle(v.discoverable ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setLabel(v.discoverable ? 'Discoverable: on' : 'Discoverable: off'),
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:visible`)
        .setStyle(v.guildVisible ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setLabel(v.guildVisible ? 'Visible here: on' : 'Visible here: off'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:forget`)
        .setStyle(ButtonStyle.Danger)
        .setLabel('Forget me'),
    ),
  ];
}

/** Second step of "Forget me" -- destructive, so it always asks twice. */
export function forgetConfirmRow(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:forget_yes`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Yes, delete everything'),
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:forget_no`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Keep my data'),
  );
}

/* -------------------------------------------------------------------------- */
/* Small generic embeds                                                        */
/* -------------------------------------------------------------------------- */

export function noticeEmbed(
  title: string,
  description: string,
  color: number = COLORS.brand,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(truncate(title, LIMITS.title))
    .setDescription(truncate(description, LIMITS.description));
}

export function errorEmbed(description: string): EmbedBuilder {
  return noticeEmbed('That did not work', description, COLORS.err);
}

export function notLinkedEmbed(): EmbedBuilder {
  return noticeEmbed(
    'You have not linked a Steam account',
    'Run **/games add** with your profile URL or Steam ID first. Nothing is stored until you agree to the consent prompt.',
    COLORS.warn,
  );
}

/* --- /games add panel ------------------------------------------------------ */

export interface AddPanelView {
  /** Set when a moderator is adding games for someone else. */
  forUserId: string | null;
  steamCount: number;
  manualCount: number;
  steamLinked: boolean;
  catalogCount: number;
}

/**
 * The hub for building up someone's game list.
 *
 * Steam and non-Steam games are counted separately because they mean different
 * things: Steam games carry real playtime and answer "how much do you play
 * this", while manual games only answer "do you play this at all".
 */
export function addPanelEmbed(v: AddPanelView): EmbedBuilder {
  const whose = v.forUserId ? `<@${v.forUserId}>'s games` : 'Your games';
  const lines = [
    v.steamLinked
      ? `**${num(v.steamCount)}** from Steam · **${num(v.manualCount)}** added by hand`
      : `**${num(v.manualCount)}** ${plural(v.manualCount, 'game')} added by hand. No Steam account linked yet.`,
    '',
    v.catalogCount > 0
      ? `Pick from the **${num(v.catalogCount)}** ${plural(v.catalogCount, 'game')} other people here already have, or add one that is not listed.`
      : 'Nobody here has added a game yet — whatever you add becomes a one-click option for everyone else.',
  ];
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(whose)
    .setDescription(joinLines(lines))
    .setFooter({
      text: truncate(
        'Games added by hand have no playtime, so they always show regardless of any playtime filter.',
        LIMITS.footer,
      ),
    });
}
