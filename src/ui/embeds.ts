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
  'Steam näitab ainult ise ostetud mänge — pere jagatud mänge ükski bot ei näe.';

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
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  // Estonian writes the decimal separator as a comma.
  return h >= 100 ? `${num(Math.round(h))} h` : `${h.toFixed(1).replace('.', ',')} h`;
}

/** Aggregate playtime, always whole hours with a thousands separator: "3,847 h". */
export function fmtTotalHours(m: Minutes): string {
  const mins = Number.isFinite(m) ? Math.max(0, m) : 0;
  return `${num(Math.round(mins / 60))} h`;
}

export function num(n: number): string {
  // Estonian groups thousands with a space. toLocaleString uses a non-breaking
  // space, which is fine in Discord but awkward everywhere else, so normalise it.
  return (Number.isFinite(n) ? n : 0).toLocaleString('et-EE').replace(/\u00a0/g, ' ');
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
    .setTitle('Ära saada seda ühelegi botile')
    .setDescription(
      [
        'See näeb välja nagu Steami **seansitoken**. Ma ei lugenud ega salvestanud seda, aga pea seda lekkinuks.',
        '',
        'Sellega saab kustutada su Steami perekonna ja teha oste. Mina kasutan ainult avalikku Steami API-t ja ei küsi seda kunagi.',
      ].join('\n'),
    );
}

export function familySharingRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Kuidas pere jagamine töötab ↗')
      .setURL(FAMILY_SHARING_URL),
  );
}

/* -------------------------------------------------------------------------- */
/* Consent (prototype screen 3)                                                */
/* -------------------------------------------------------------------------- */

export function consentEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Enne kogu importimist')
    .setDescription(
      [
        '• Salvestan **mängude nimed ja mänguaja** ning su Steam ID.',
        '• Neid näevad ainult **selle serveri** liikmed.',
        '• Su Steam ID-d ei näidata kellelegi.',
        '• **/steam unlink** kustutab kõik.',
        '',
        'Järgmisena valid nimekirjast, mida salvestada.',
      ].join('\n'),
    );
}

export function consentRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`consent:${id}:yes`)
      .setStyle(ButtonStyle.Success)
      .setLabel('Nõustun — impordi'),
    new ButtonBuilder()
      .setCustomId(`consent:${id}:no`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Katkesta'),
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
  /** Games the user unchecked on the import checklist, so they were not stored. */
  excludedCount: number;
  guildName: string;
  /** Discord ID this was registered FOR, when a moderator added someone else. */
  forUserId?: string | null;
}

export function linkSuccessEmbed(s: LinkSuccess): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(COLORS.ok)
    .setAuthor({
      name: truncate(
        s.forUserId ? `Lisatud: ${s.personaName}` : `Ühendatud: ${s.personaName}`,
        LIMITS.author,
      ),
      ...(s.avatarUrl ? { iconURL: s.avatarUrl } : {}),
    })
    .setDescription(
      joinLines([
        `Salvestatud **${num(s.matchable)} ${plural(s.matchable, 'mäng', 'mängu')}** (${num(s.ownedTotal)}-st).`,
        ...(s.excludedCount > 0
          ? [`${num(s.excludedCount)} ${plural(s.excludedCount, 'mängu', 'mängu')} jätsid välja.`]
          : []),
        '',
        s.forUserId
          ? `Lisatud <@${s.forUserId}> jaoks serveris **${safeName(s.guildName, 100)}**. Ta saab selle ise eemaldada: **/privacy**`
          : `Oled nüüd nähtav serveris **${safeName(s.guildName, 100)}**. Peida end: **/privacy**`,
      ]),
    )
    .addFields(
      { name: 'Mänguaeg kokku', value: fmtTotalHours(s.totalMinutes), inline: true },
      {
        name: 'Hiljuti mängitud',
        value: `${num(s.recentCount)} ${plural(s.recentCount, 'mäng', 'mängu')}`,
        inline: true,
      },
      // There is no background refresh: Steam is contacted only when a person
      // asks it to be. Advertising an automatic one would be a promise nothing
      // in the bot keeps.
      { name: 'Uuendamine', value: '`/steam update`', inline: true },
    )
    .setFooter({ text: truncate(FAMILY_SHARING_FOOTER, LIMITS.footer) });
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
  const who = personaName ? `**${safeName(personaName, 64)}**` : 'sellel profiilil';
  switch (state) {
    case 'public':
      return {
        title: 'Kogu imporditud',
        description: `Näen ${who} mänge. Kõik on valmis.`,
        color: COLORS.ok,
        privacyHelp: false,
      };
    case 'private':
      return {
        title: 'Su Steami profiil on privaatne',
        description: [
          `Ma ei näe ${who} kohta midagi.`,
          '',
          '**Paranda:** Steam → Profiil → Muuda profiili → Privaatsus → **Minu profiil** = **Avalik**. Seejärel proovi uuesti.',
        ].join('\n'),
        color: COLORS.err,
        privacyHelp: true,
      };
    case 'game_details_private':
      return {
        title: 'Profiil on avalik, mängude info mitte',
        description: [
          'Steamis on mängude nimekirjal **eraldi** säte.',
          '',
          '**Paranda:** Steam → Profiil → Muuda profiili → Privaatsus → **Game details** = **Public**.',
          '',
          'Eemalda ka linnuke **"Always keep my total playtime private"**, muidu tuleb iga mäng 0 minutiga.',
        ].join('\n'),
        color: COLORS.warn,
        privacyHelp: true,
      };
    case 'playtime_hidden':
      return {
        title: 'Näen su mänge, aga mitte mänguaega',
        description: [
          `Iga mäng ${who} tuli 0 minutiga, nii et sa ei sobitu kellegagi.`,
          '',
          '**Paranda:** Steam → Profiil → Muuda profiili → Privaatsus → eemalda linnuke **"Always keep my total playtime private"**. Seejärel **/steam update**.',
        ].join('\n'),
        color: COLORS.warn,
        privacyHelp: true,
      };
    case 'empty':
      return {
        title: 'Sellel Steami kontol pole mänge',
        description: [
          `${who} on avalik ja loetav — seal lihtsalt pole midagi.`,
          '',
          'Kui see on vale konto, käivita **/games add** õige profiili aadressiga.',
        ].join('\n'),
        color: COLORS.warn,
        privacyHelp: false,
      };
    case 'error':
      return {
        title: 'Steam ei vastanud',
        description: [
          'Ei saanud Steamiga ühendust — midagi ei imporditud ega muudetud.',
          '',
          'Tavaliselt on Steam paar minutit maas. Proovi natukese aja pärast uuesti.',
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
        .setLabel('Ava Steami privaatsussätted ↗')
        .setURL(STEAM_PRIVACY_URL),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`retry:${id}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Proovi uuesti'),
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
    `**${num(v.matching)}** ${plural(v.matching, 'mäng', 'mängu')}` +
    (v.filter > 0 ? ` üle ${fmtMinutes(v.filter)}` : '') +
    (v.matchingMinutes > 0 ? ` · ${fmtTotalHours(v.matchingMinutes)} kokku` : '');
  // An untracked (hand-added) game has NO playtime. Printing `0m` would read as
  // "never played" when it actually means "unknown", so mark it instead.
  // A hidden game is still the owner's, so it stays in their own list -- but
  // silently, it would look like /steam change had done nothing.
  const lines = v.pageRows.map((g, i) => {
    const suffix = g.tracked ? `\`${fmtMinutes(g.playtime)}\`` : '*käsitsi lisatud*';
    const mark = g.hidden ? ` · ${HIDDEN_MARK} peidetud` : '';
    return `${rank(v.offset + i + 1)} **${gameName(g.name)}** · ${suffix}${mark}`;
  });
  const body = lines.length > 0 ? lines : ['*Selle filtriga pole midagi.*'];
  const hiddenCount = v.pageRows.filter((g) => g.hidden).length;
  const footer = [
    `Lk ${v.page + 1}/${v.pages}`,
    v.syncedAgo ? `uuendatud ${v.syncedAgo}` : null,
    `${num(v.ownedTotal)} ${plural(v.ownedTotal, 'mäng', 'mängu')} kokku`,
    hiddenCount > 0 ? `${HIDDEN_MARK} peidetud · /steam change` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(`${escapeMd(v.displayName)} kogu`, LIMITS.title))
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
  const body = lines.length > 0 ? lines : ['*Selle filtriga pole ühiseid mänge.*'];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(
      truncate(
        `${me} & ${them} — ${num(v.total)} ${plural(v.total, 'ühine mäng', 'ühist mängu')}`,
        LIMITS.title,
      ),
    )
    .setDescription(
      joinLines([
        `Mõlemal üle ${fmtMinutes(v.filter)}. Ülal on see, mida vähem mängitud.`,
        '',
        ...body,
      ]),
    )
    .setFooter({
      text: truncate(
        `${num(v.pageRows.length)}/${num(v.total)} · ${me} ${num(v.myLibrarySize)} · ${them} ${num(v.theirLibrarySize)}`,
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
  /** Null for a manually added game: it has no Steam appid and so no store page. */
  storeUrl: string | null;
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
/** Marks a game the owner has hidden from the rest of the server. */
export const HIDDEN_MARK = '🔒';

export const ADDED_MARK = '✎';
export function addedMark(addedBy: string | null | undefined): string {
  return addedBy ? ` ${ADDED_MARK}` : '';
}
export const ADDED_FOOTNOTE = `${ADDED_MARK} lisas moderaator, mitte kasutaja ise`;

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
  const body = lines.length > 0 ? lines : ['*Selle filtriga pole veel kedagi.*'];
  const footer = [
    v.appid === DRG_APPID ? 'Rock and Stone!' : null,
    n > shown ? `näitan ${num(shown)} esimest` : null,
    v.owners.some((o) => o.addedBy) ? ADDED_FOOTNOTE : null,
    `vähemalt ${fmtMinutes(v.filter)}`,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(escapeMd(v.name), LIMITS.title))
    // A manual game has no store page; linking the title to /app/-1 would give
    // the reader a 404 dressed up as the game's own page.
    .setURL(v.storeUrl)
    .setDescription(
      joinLines([
        `**${num(n)} ${plural(n, 'inimene', 'inimest')}** siin on seda mänginud üle ${fmtMinutes(v.filter)}.`,
        '',
        ...body,
      ]),
    )
    .setFooter({ text: truncate(footer, LIMITS.footer) })
    .setThumbnail(v.iconUrl);
}

export function whoRow(
  sessionId: string,
  count: number,
  /** Null for a manually added game, which has no store page to link to. */
  storeUrl: string | null,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (count > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:ping`)
        .setStyle(ButtonStyle.Primary)
        .setLabel(truncate(count === 1 ? 'Pingi teda' : `Pingi neid ${count}`, LIMITS.buttonLabel)),
    );
  }
  if (storeUrl !== null) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Poe leht ↗').setURL(storeUrl),
    );
  }
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
      ` \`${num(m.overlap)} ${plural(m.overlap, 'ühine', 'ühist')}\` · \`${pct}\` maitse · ${num(m.theirTotal)} nende kogus`
    );
  });
  const body = lines.length > 0 ? lines : ['*Selle filtriga pole veel kedagi.*'];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(`Kõige sarnasemad: ${escapeMd(v.displayName)}`, LIMITS.title))
    .setDescription(
      joinLines([
        `**${num(v.memberCount)} ühendatud ${plural(v.memberCount, 'liige', 'liiget')}** selles serveris, mõlemal üle ${fmtMinutes(v.filter)}.`,
        '',
        ...body,
      ]),
    )
    .setFooter({
      text: truncate(
        `Ühised = kattuvad mängud · Maitse = ühised ÷ kokku · järjestus: ${v.sort === 'taste' ? 'maitse' : 'ühised'}`,
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
      .setLabel('Ühiste järgi'),
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:taste`)
      .setStyle(active === 'taste' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setLabel('Maitse järgi'),
  );
}

/* --- /games leaderboard (prototype screen 8) ------------------------------ */

export interface LeaderboardView {
  /** 'guild' = the whole server's board; 'user' = one person's point of view. */
  scope?: 'guild' | 'user';
  /** Display name of the person whose board this is, when scope is 'user'. */
  subjectName?: string | null;
  /** True when that person is the one who ran the command. */
  subjectIsViewer?: boolean;
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
  const mine = v.scope === 'user';
  const whose = v.subjectIsViewer ? 'Sinu' : `${safeName(v.subjectName, 60)}`;
  const lines = v.pageRows.map(
    (g, i) =>
      `${rank(v.offset + i + 1)} **${gameName(g.name)}** · \`${num(g.owners)} ${plural(g.owners, 'inimene', 'inimest')}\``,
  );
  const empty = mine
    ? '*Selle filtriga ei jaga keegi siin veel ühtki neist mängudest.*'
    : '*Ühelgi mängul pole veel kahte mängijat selle filtriga.*';
  const body = lines.length > 0 ? lines : [empty];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(
      truncate(
        mine
          ? `${whose} mängud — enim jagatud`
          : `${safeName(v.guildName, 80)} — enim mängitud`,
        LIMITS.title,
      ),
    )
    .setDescription(
      joinLines([
        mine
          ? `${v.subjectIsViewer ? 'Sinu' : whose} mängud, järjestatud selle järgi, mitu inimest siin neid veel mängib. Arvestus sisaldab ${v.subjectIsViewer ? 'sind' : 'teda'}.`
          : `Mängud, mida vähemalt 2 liiget on mänginud üle ${fmtMinutes(v.filter)}.`,
        '',
        ...body,
      ]),
    )
    .setFooter({
      text: truncate(
        `${num(v.memberCount)} ${plural(v.memberCount, 'liige', 'liiget')} · ${num(v.distinctGames)} erinevat mängu · lk ${v.page + 1}/${v.pages}`,
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
    .setTitle('Sinu privaatsussätted')
    .setDescription(
      joinLines([
        v.linked
          ? 'Steami kogu on ühendatud. Su Steam ID-d ei näidata kellelegi.'
          : 'Steami kontot pole ühendatud — alusta käsuga **/games add**.',
        '',
        `**Nähtav kõikjal** — ${v.discoverable ? 'sees' : 'väljas'}. Väljas: sa ei ilmu üheski serveris kellegi tulemustes.`,
        `**Nähtav serveris ${safeName(v.guildName, 80)}** — ${v.guildVisible ? 'sees' : 'väljas'}. Peidab sind ainult siin.`,
        '',
        '**Unusta mind** kustutab Steami ühenduse, mängud ja mänguaja. Seda ei saa tagasi võtta.',
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
        .setLabel(v.discoverable ? 'Nähtav kõikjal: sees' : 'Nähtav kõikjal: väljas'),
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:visible`)
        .setStyle(v.guildVisible ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setLabel(v.guildVisible ? 'Nähtav siin: sees' : 'Nähtav siin: väljas'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`px:${sessionId}:forget`)
        .setStyle(ButtonStyle.Danger)
        .setLabel('Unusta mind'),
    ),
  ];
}

/** Second step of "Forget me" -- destructive, so it always asks twice. */
export function forgetConfirmRow(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:forget_yes`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Jah, kustuta kõik'),
    new ButtonBuilder()
      .setCustomId(`px:${sessionId}:forget_no`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Jäta alles'),
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
  return noticeEmbed('See ei õnnestunud', description, COLORS.err);
}

export function notLinkedEmbed(): EmbedBuilder {
  return noticeEmbed(
    'Steami kontot pole ühendatud',
    'Käivita esmalt **/games add** ja sisesta oma profiili aadress või Steam ID.',
    COLORS.warn,
  );
}

/* --- Reaction roles -------------------------------------------------------- */

export interface RolePanelView {
  title: string;
  description: string;
  exclusive: boolean;
  rows: ReadonlyArray<{ emojiRaw: string; roleId: string }>;
}

/**
 * The public panel message. Roles are rendered as mentions rather than names so
 * they stay correct when a role is renamed or recoloured; `allowedMentions` on
 * the send is what stops that pinging everyone who holds one.
 */
export function rolePanelEmbed(v: RolePanelView): EmbedBuilder {
  const lines =
    v.rows.length > 0
      ? v.rows.map((r) => `${r.emojiRaw} — <@&${r.roleId}>`)
      : ['*Ühtegi rolli pole veel lisatud.*'];

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(v.title, LIMITS.title))
    .setDescription(
      joinLines([
        ...(v.description ? [v.description, ''] : []),
        ...lines,
        '',
        v.exclusive
          ? '*Vali üks. Uue valimine eemaldab eelmise.*'
          : '*Reageeri rolli saamiseks. Eemalda reaktsioon, et roll ära anda.*',
      ]),
    );
}

/* --- The import / visibility checklist ------------------------------------ */

export interface ChecklistView {
  title: string;
  /** One line of context above the list. Already-safe text: we author it. */
  intro: string;
  /** The rows on the current page, in order, with their current check state. */
  pageRows: ReadonlyArray<{ label: string; checked: boolean; note?: string }>;
  offset: number;
  page: number;
  pages: number;
  checked: number;
  total: number;
  /** What being checked MEANS here -- it differs per checklist. */
  checkedMeans: string;
  uncheckedMeans: string;
}

/**
 * The paginated checklist body.
 *
 * The box glyphs are the whole point: a Discord select menu shows its own
 * selection state only while the menu is open, so without an explicit rendered
 * list the user cannot see what they have checked on any page but this one.
 */
export function checklistEmbed(v: ChecklistView): EmbedBuilder {
  const lines = v.pageRows.map(
    (r, i) =>
      `${r.checked ? '☑' : '☐'} ${rank(v.offset + i + 1)} ${
        r.checked ? `**${gameName(r.label)}**` : gameName(r.label)
      }${r.note ? ` · ${r.note}` : ''}`,
  );
  const header =
    `**${num(v.checked)}** / **${num(v.total)}** valitud` +
    (v.pages > 1 ? ` · näitan ${num(v.offset + 1)}–${num(v.offset + v.pageRows.length)}` : '');

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(truncate(v.title, LIMITS.title))
    .setDescription(
      joinLines([
        v.intro,
        '',
        header,
        '',
        ...(lines.length > 0 ? lines : ['*Pole midagi näidata.*']),
      ]),
    )
    .setFooter({
      text: truncate(
        `Lk ${v.page + 1}/${v.pages} · linnuke = ${v.checkedMeans} · ilma = ${v.uncheckedMeans}`,
        LIMITS.footer,
      ),
    });
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
  const whose = v.forUserId ? `<@${v.forUserId}> mängud` : 'Sinu mängud';
  const lines = [
    v.steamLinked
      ? `**${num(v.steamCount)}** Steamist · **${num(v.manualCount)}** käsitsi lisatud`
      : `**${num(v.manualCount)}** käsitsi lisatud ${plural(v.manualCount, 'mäng', 'mängu')}. Steami kontot pole ühendatud.`,
    '',
    v.catalogCount > 0
      ? `Vali **${num(v.catalogCount)}** mängu seast, mis teistel siin juba on, või lisa uus.`
      : 'Keegi pole veel mänge lisanud — mille sina lisad, saab teistele ühe klikiga valitavaks.',
  ];
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(whose)
    .setDescription(joinLines(lines))
    .setFooter({
      text: truncate(
        'Käsitsi lisatud mängudel pole mänguaega, seega need läbivad alati iga filtri.',
        LIMITS.footer,
      ),
    });
}
