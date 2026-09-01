/**
 * /steam update | change | unlink   (linking lives in /games add)
 *
 * Steam is contacted ONLY when a person asks for it: once when a library is
 * first imported, and then whenever someone runs /steam update. There is no
 * background crawl -- see "No background refresh" in the README.
 *
 * Every path that writes a library goes through `reviewAndSync`, so the
 * checklist can never be skipped by adding a new caller.
 */

import { ComponentType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction, RepliableInteraction } from 'discord.js';
import type { LibraryResult, Minutes, OwnedGame } from '../types.js';
import { SteamUserError } from '../types.js';
import { resolveToId64 } from '../steam/resolve.js';
import { syncLibrary, type LibrarySource } from '../steam/sync.js';
import {
  ensureUser,
  getExcludedAppids,
  linkSteam,
  listAllUserGames,
  listGames,
  setExcludedGames,
  setHiddenGames,
  setOptedIn,
  touchGuildMember,
  unlink,
} from '../db/queries.js';
import {
  COLORS,
  consentEmbed,
  consentRow,
  fmtMinutes,
  linkSuccessEmbed,
  noticeEmbed,
  profileStateEmbed,
  profileStateMessage,
  retryRow,
} from '../ui/embeds.js';
import { runChecklist } from '../ui/checklist.js';
import { claimSessionId, releaseSession } from '../ui/paginate.js';
import {
  ROW_LIMITS,
  getLinkInfo,
  guildOnlyEmbed,
  resolveMinPlaytime,
  type BotContext,
  type Command,
} from './index.js';
import {
  clearConsent,
  markRefreshed,
  refreshCooldownLeft,
  softenRefreshMark,
} from './user-state.js';

const data = new SlashCommandBuilder()
  .setName('steam')
  .setDescription('Halda oma Steami kogu — mänge lisad käsuga /games add')
  .addSubcommand((s) =>
    s.setName('update').setDescription('Otsi Steamist uusi mänge ja vali, mida alles jätta'),
  )
  .addSubcommand((s) =>
    s.setName('change').setDescription('Vali, milliseid su mänge teised siin näevad'),
  )
  .addSubcommand((s) =>
    s.setName('unlink').setDescription('Kustuta Steami ühendus ja sealt toodud mängud'),
  );

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Consent prompt. The reply is ephemeral, so only the invoker can see or click
 * these buttons -- a `filter` is safe here in a way it would not be on a public
 * paginated message.
 */
export async function askConsent(interaction: RepliableInteraction): Promise<boolean> {
  // Registered in the paginate session store so the global button router leaves
  // these clicks alone while this prompt is live.
  const id = claimSessionId(interaction.user.id);
  const message = await interaction.editReply({
    embeds: [consentEmbed()],
    components: [consentRow(id)],
  });
  try {
    const click = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 120_000,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(`consent:${id}:`),
    });
    await click.deferUpdate();
    return click.customId.endsWith(':yes');
  } catch {
    return false;
  } finally {
    releaseSession(id);
  }
}

/**
 * LibrarySource is the seam that lets syncLibrary persist a library we have
 * already fetched, instead of spending a second Steam request on it.
 */
function cachedSource(lib: LibraryResult): LibrarySource {
  return { fetchLibrary: async () => lib };
}

function libraryStats(games: readonly OwnedGame[], min: Minutes) {
  let totalMinutes = 0;
  let matchable = 0;
  let recent = 0;
  for (const g of games) {
    totalMinutes += g.playtimeForever;
    if (g.playtimeForever > min) matchable++;
    if (g.playtime2Weeks > 0) recent++;
  }
  return { totalMinutes, matchable, recent, ownedTotal: games.length };
}

/** Most-played first, so the games worth thinking about are on page one. */
function byPlaytimeDesc(a: OwnedGame, b: OwnedGame): number {
  return b.playtimeForever - a.playtimeForever || a.name.localeCompare(b.name);
}

const NOT_IMPORTED = noticeEmbed(
  'Midagi ei imporditud',
  'Sulgesid nimekirja, nii et midagi ei salvestatud ega muudetud.\n\nUuesti: **/steam update**',
  COLORS.warn,
);

/**
 * The one place a Steam library is ever written to the database.
 *
 * Shows the checklist over `lib.games`, persists the unchecked ones as
 * exclusions, then syncs. Returns null when the user backed out, in which case
 * NOTHING has been written -- the caller must not treat that as a success.
 */
async function reviewAndSync(
  interaction: RepliableInteraction,
  ctx: BotContext,
  userId: string,
  id64: string,
  lib: LibraryResult,
  min: Minutes,
  /** Exclusions to pre-tick. Empty for a library that is not this account's. */
  alreadyExcluded: ReadonlySet<number>,
  /**
   * Run after the user saves and before anything is written. This is where the
   * first import claims the Steam identity: taking the claim any earlier would
   * mean a cancelled checklist had already linked the account -- and, on a
   * relink, already wiped the previous library. Return false to abort having
   * written nothing.
   */
  accept: () => boolean = () => true,
): Promise<{ kept: OwnedGame[]; excludedCount: number } | null> {
  const games = [...lib.games].sort(byPlaytimeDesc);

  const review = await runChecklist({
    interaction,
    ownerId: interaction.user.id,
    items: games.map((g) => ({
      id: String(g.appid),
      label: g.name,
      // 'playtime_hidden' zeroes every playtime, so a 0 here is genuinely
      // unknown. Say nothing rather than print a misleading "0m played".
      ...(g.playtimeForever > 0 ? { note: `mängitud ${fmtMinutes(g.playtimeForever)}` } : {}),
    })),
    initial: games.filter((g) => !alreadyExcluded.has(g.appid)).map((g) => String(g.appid)),
    title: 'Vali, mida importida',
    intro:
      'Eemalda linnuke mängudelt, mida sa ei taha salvestada. Neid ei salvestata ja need jäävad valimata ka järgmisel **/steam update** korral.',
    checkedMeans: 'salvestatakse',
    uncheckedMeans: 'ei salvestata',
    saveLabel: 'Impordi valitud',
  });

  if (!review.saved) return null;
  if (!accept()) return null;

  const keptIds = review.checked;
  const kept = games.filter((g) => keptIds.has(String(g.appid)));
  const dropped = games.filter((g) => !keptIds.has(String(g.appid)));

  // Exclusions first: syncLibrary reads that table itself, so writing them
  // before the sync is what makes even the very first import honour the list.
  setExcludedGames(
    ctx.db,
    userId,
    dropped.map((g) => ({ appid: g.appid, name: g.name })),
  );
  try {
    await syncLibrary(ctx.db, userId, id64, cachedSource(lib));
  } catch (err) {
    console.error('[steam] syncLibrary failed', err);
  }
  return { kept, excludedCount: dropped.length };
}

/** The green "here is what I imported" screen, shared by link and update. */
async function reportImported(
  interaction: RepliableInteraction,
  result: { kept: OwnedGame[]; excludedCount: number },
  min: Minutes,
  personaName: string,
  avatarUrl: string | null,
  guildName: string,
  forUserId: string | null,
): Promise<void> {
  // Stats are computed over the KEPT games only: reporting numbers that include
  // games the user just refused would be reporting data we do not hold.
  const stats = libraryStats(result.kept, min);
  await interaction.editReply({
    embeds: [
      linkSuccessEmbed({
        personaName,
        avatarUrl,
        ownedTotal: stats.ownedTotal,
        matchable: stats.matchable,
        minPlaytime: min,
        totalMinutes: stats.totalMinutes,
        recentCount: stats.recent,
        excludedCount: result.excludedCount,
        guildName,
        forUserId,
      }),
    ],
    components: [],
  });
}

/* -------------------------------------------------------------------------- */
/* First import (driven from the /games add panel)                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve, fetch, review and store a Steam library, then report the outcome.
 *
 * Typed on RepliableInteraction rather than ChatInputCommandInteraction so the
 * same flow can be driven from the /games panel's modal, not just a slash
 * command. The caller must have deferred already.
 */
export async function importLibrary(
  interaction: RepliableInteraction,
  ctx: BotContext,
  raw: string,
  min: Minutes,
  /** Who the library belongs to. Defaults to the caller. */
  targetId: string = interaction.user.id,
): Promise<void> {
  const userId = targetId;
  /** Set when a moderator registered this on someone else's behalf. */
  const addedBy = targetId === interaction.user.id ? null : interaction.user.id;

  let id64: string;
  try {
    id64 = await resolveToId64(raw, ctx.steamApiKey);
  } catch (err) {
    const msg =
      err instanceof SteamUserError
        ? err.message
        : 'Ei suutnud sellest Steami kontot leida. Kleebi oma profiili täisaadress, näiteks `https://steamcommunity.com/id/sinunimi` või `https://steamcommunity.com/profiles/7656119…`.';
    await interaction.editReply({
      embeds: [noticeEmbed('See pole loetav Steami profiil', msg, COLORS.err)],
      components: [retryRow(userId, false)],
    });
    return;
  }

  // Fetch BEFORE writing anything: a private profile must leave no trace.
  let lib: LibraryResult;
  try {
    lib = await ctx.steam.fetchLibrary(id64);
  } catch (err) {
    console.error('[steam] fetchLibrary failed', err);
    lib = { state: 'error', personaName: null, avatarUrl: null, games: [] };
  }

  if (lib.state === 'private' || lib.state === 'game_details_private' || lib.state === 'error') {
    const m = profileStateMessage(lib.state, lib.personaName, min);
    await interaction.editReply({
      embeds: [profileStateEmbed(lib.state, lib.personaName, min)],
      components: [retryRow(userId, m.privacyHelp)],
    });
    return;
  }

  // The checklist runs BEFORE linkSteam so that backing out of it leaves the
  // database exactly as it was. Doing it after would mean a cancel had already
  // created the link -- and, on a relink, already wiped the old library.
  const existing = getLinkInfo(ctx.db, userId);
  // Exclusions are appids, which only mean anything relative to the account
  // they came from. Re-pointing at a different Steam account starts clean.
  const alreadyExcluded =
    existing?.id64 === id64 ? getExcludedAppids(ctx.db, userId) : new Set<number>();

  if (lib.games.length > 0) {
    let claimFailed = false;
    const result = await reviewAndSync(
      interaction,
      ctx,
      userId,
      id64,
      lib,
      min,
      alreadyExcluded,
      () => {
        if (claimLink(ctx, userId, id64, addedBy)) return true;
        claimFailed = true;
        return false;
      },
    );
    if (claimFailed) {
      await interaction.editReply({ embeds: [alreadyClaimedEmbed()], components: [] });
      return;
    }
    if (result === null) {
      await interaction.editReply({ embeds: [NOT_IMPORTED], components: [] });
      return;
    }
    await reportImported(
      interaction,
      result,
      min,
      lib.personaName ?? 'your Steam account',
      lib.avatarUrl,
      interaction.guild?.name ?? 'this server',
      addedBy === null ? null : userId,
    );
    return;
  }

  // No games to review (an empty library, or one whose playtimes are hidden and
  // therefore not authoritative). Link it so /steam update has something to
  // work from, then explain the state.
  if (!claimLink(ctx, userId, id64, addedBy)) {
    await interaction.editReply({ embeds: [alreadyClaimedEmbed()], components: [] });
    return;
  }
  try {
    await syncLibrary(ctx.db, userId, id64, cachedSource(lib));
  } catch (err) {
    console.error('[steam] syncLibrary failed', err);
  }
  const m = profileStateMessage(lib.state, lib.personaName, min);
  await interaction.editReply({
    embeds: [profileStateEmbed(lib.state, lib.personaName, min)],
    components: m.privacyHelp ? [retryRow(userId, true)] : [],
  });
}

/** linkSteam + opt-in, as one step. False when someone else already owns the ID. */
function claimLink(
  ctx: BotContext,
  userId: string,
  id64: string,
  addedBy: string | null,
): boolean {
  const link = linkSteam(ctx.db, userId, id64, addedBy);
  if (!link.ok) return false;
  setOptedIn(ctx.db, userId, true);
  return true;
}

function alreadyClaimedEmbed() {
  // Steam IDs are public, so this is someone typing an ID that is not theirs
  // (or a genuine duplicate). Either way we do not move the claim.
  return noticeEmbed(
    'See Steami konto on juba ühendatud',
    'Keegi teine on selle Steami konto juba ühendanud, nii et ma ei võta seda üle.\n\nKui see on sinu oma, palu tal käivitada **/steam unlink**.',
    COLORS.warn,
  );
}

/* -------------------------------------------------------------------------- */

const command: Command = {
  data,

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Ephemeral for every /steam subcommand -- this is account plumbing.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.guildId) {
      await interaction.editReply({ embeds: [guildOnlyEmbed()] });
      return;
    }

    ensureUser(ctx.db, userId);
    touchGuildMember(ctx.db, interaction.guildId, userId);
    const min = resolveMinPlaytime(ctx.db, interaction.guildId, null);

    if (sub === 'unlink') return unlinkSub(interaction, ctx, userId);
    if (sub === 'change') return changeSub(interaction, ctx, userId);
    if (sub === 'update') return updateSub(interaction, ctx, userId, min);

    await interaction.editReply({
      embeds: [noticeEmbed('Tundmatu alamkäsk', `Ma ei tunne käsku \`/steam ${sub}\`.`, COLORS.err)],
    });
  },
};

export default command;

/* -------------------------------------------------------------------------- */
/* /steam unlink                                                               */
/* -------------------------------------------------------------------------- */

async function unlinkSub(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  userId: string,
): Promise<void> {
  unlink(ctx.db, userId);
  clearConsent(userId);

  // unlink() keeps hand-added games -- they never came from Steam. So opting
  // the person out is only right when nothing survived: doing it unconditionally
  // would leave their Minecraft row in the database and hide it from everyone,
  // which is the same disappearance the delete used to cause, one layer down.
  const left = listGames(ctx.db, userId, -1, 1, 0).length;
  if (left === 0) setOptedIn(ctx.db, userId, false);

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        'Ühendus kustutatud',
        left === 0
          ? 'Su Steam ID, mängud ja mänguaeg on kustutatud. Sa ei ilmu enam kellegi tulemustes.\n\nUuesti alustamiseks: **/games add**'
          : 'Su Steam ID, Steamist toodud mängud ja mänguaeg on kustutatud.\n\nKäsitsi lisatud mängud jäid alles — need ei tulnud Steamist. Neid näed **/games list** all ja eemaldad **/games add** paneelilt. Täielikuks kustutamiseks: **/privacy**.',
        COLORS.ok,
      ),
    ],
    components: [],
  });
}

/* -------------------------------------------------------------------------- */
/* /steam update — the ONLY thing that contacts Steam after the first import   */
/* -------------------------------------------------------------------------- */

async function updateSub(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  userId: string,
  min: Minutes,
): Promise<void> {
  const link = getLinkInfo(ctx.db, userId);
  if (!link) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Pole midagi uuendada',
          'Steami kontot pole ühendatud. Käivita esmalt **/games add**.',
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  const waitMs = refreshCooldownLeft(userId);
  if (waitMs > 0) {
    const readyAt = Math.floor((Date.now() + waitMs) / 1000);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Hiljuti juba uuendatud',
          `Steam piirab päringuid, seega saab uuendada kord 15 minuti jooksul. Proovi uuesti <t:${readyAt}:R>.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }
  markRefreshed(userId);

  let lib: LibraryResult;
  try {
    lib = await ctx.steam.fetchLibrary(link.id64);
  } catch (err) {
    console.error('[steam] update fetch failed', err);
    lib = { state: 'error', personaName: link.personaName, avatarUrl: null, games: [] };
  }

  if (lib.state !== 'public') {
    // Every non-public state needs its own explanation. Reporting "imported 412
    // games, 0 matchable" as a green success is how a user who has NOT fixed
    // their privacy setting concludes the bot is broken. A failure is not the
    // user's fault, so shorten the wait -- but do not clear it: an
    // always-failing profile would otherwise be an unlimited free loop against
    // the shared Steam rate limiter.
    softenRefreshMark(userId);
    // 'playtime_hidden' and 'empty' are still authoritative answers, so they are
    // persisted; sync.ts decides what that means for the stored snapshot.
    if (lib.state !== 'error' && lib.state !== 'private' && lib.state !== 'game_details_private') {
      try {
        await syncLibrary(ctx.db, userId, link.id64, cachedSource(lib));
      } catch (err) {
        console.error('[steam] update sync failed', err);
      }
    }
    const m = profileStateMessage(lib.state, lib.personaName ?? link.personaName, min);
    await interaction.editReply({
      embeds: [profileStateEmbed(lib.state, lib.personaName ?? link.personaName, min)],
      components: [retryRow(userId, m.privacyHelp)],
    });
    return;
  }

  const result = await reviewAndSync(
    interaction,
    ctx,
    userId,
    link.id64,
    lib,
    min,
    getExcludedAppids(ctx.db, userId),
  );
  if (result === null) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Midagi ei muutunud',
          'Sulgesid nimekirja, nii et su kogu jäi täpselt samaks.',
          COLORS.warn,
        ),
      ],
      components: [],
    });
    return;
  }

  await reportImported(
    interaction,
    result,
    min,
    lib.personaName ?? link.personaName ?? 'your Steam account',
    lib.avatarUrl,
    interaction.guild?.name ?? 'this server',
    null,
  );
}

/* -------------------------------------------------------------------------- */
/* /steam change — per-game visibility                                         */
/* -------------------------------------------------------------------------- */

async function changeSub(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  userId: string,
): Promise<void> {
  // Every game, hidden ones included and with no playtime filter: you must be
  // able to unhide something no threshold would have shown you.
  const all = listAllUserGames(ctx.db, userId, ROW_LIMITS.library);
  if (all.length === 0) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Sul pole mänge, mida muuta',
          'Impordi esmalt Steami kogu või lisa mänge käsitsi: **/games add**',
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  const review = await runChecklist({
    interaction,
    ownerId: userId,
    items: all.map((g) => ({
      id: String(g.appid),
      label: g.name,
      ...(g.tracked && g.playtime > 0
        ? { note: `mängitud ${fmtMinutes(g.playtime)}` }
        : { note: 'käsitsi lisatud' }),
    })),
    // Checked = visible. Stated that way round because "tick what people can
    // see" is the question a person actually has; "tick what to hide" inverts
    // it and reads as the opposite on every screen.
    initial: all.filter((g) => !g.hidden).map((g) => String(g.appid)),
    title: 'Kes mida näeb',
    intro:
      'Märgitud mänge näevad teised selles serveris. Märkimata mängud jäävad **sinu** /games list nimekirja, aga ei ilmu mujal.',
    checkedMeans: 'teised näevad',
    uncheckedMeans: 'ainult sinule',
    saveLabel: 'Salvesta',
  });

  if (!review.saved) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Midagi ei muutunud',
          'Sulgesid nimekirja, nii et nähtavus jäi täpselt samaks.',
          COLORS.warn,
        ),
      ],
      components: [],
    });
    return;
  }

  const hidden = all.filter((g) => !review.checked.has(String(g.appid))).map((g) => g.appid);
  setHiddenGames(ctx.db, userId, hidden);

  const visible = all.length - hidden.length;
  await interaction.editReply({
    embeds: [
      noticeEmbed(
        'Nähtavus salvestatud',
        hidden.length === 0
          ? `Kõik **${visible}** su mängu on selles serveris nähtavad.`
          : `**${visible}** nähtav · **${hidden.length}** peidetud.\n\nPeidetud mängud on endiselt sinu **/games list** nimekirjas, tähisega 🔒.`,
        COLORS.ok,
      ),
    ],
    components: [],
  });
}
