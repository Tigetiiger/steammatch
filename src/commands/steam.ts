/**
 * /steam unlink | refresh  (linking lives in /games add)   (prototype screens 1, 2, 3)
 */

import { ComponentType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction, RepliableInteraction } from 'discord.js';
import type { LibraryResult, Minutes } from '../types.js';
import { SteamUserError } from '../types.js';
import { resolveToId64 } from '../steam/resolve.js';
import { syncLibrary, type LibrarySource } from '../steam/sync.js';
import {
  ensureUser,
  hasStoredConsent,
  linkSteam,
  setOptedIn,
  touchGuildMember,
  unlink,
} from '../db/queries.js';
import {
  COLORS,
  consentEmbed,
  consentRow,
  linkSuccessEmbed,
  noticeEmbed,
  profileStateEmbed,
  profileStateMessage,
  retryRow,
} from '../ui/embeds.js';
import { claimSessionId, releaseSession } from '../ui/paginate.js';
import {
  getLinkInfo,
  guildOnlyEmbed,
  refuseIfSteamToken,
  resolveMinPlaytime,
  type BotContext,
  type Command,
} from './index.js';
import {
  REFRESH_COOLDOWN_MS,
  clearConsent,
  softenRefreshMark,
  hasConsented,
  markRefreshed,
  recordConsent,
  refreshCooldownLeft,
} from './user-state.js';

/** How often the background refresh is advertised to run, in hours. */
const REFRESH_HOURS = 6;




const data = new SlashCommandBuilder()
  .setName('steam')
  .setDescription('Refresh or remove your Steam library — add games with /games add')
  .addSubcommand((s) =>
    s.setName('unlink').setDescription('Delete your Steam link, games and playtime'),
  )
  .addSubcommand((s) =>
    s.setName('refresh').setDescription('Re-import your library from Steam now'),
  );

/* -------------------------------------------------------------------------- */

/**
 * Consent prompt (screen 3). The reply is ephemeral, so only the invoker can see
 * or click these buttons -- a `filter` is safe here in a way it would not be on
 * a public paginated message.
 */
async function askConsent(interaction: ChatInputCommandInteraction): Promise<boolean> {
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

function libraryStats(games: LibraryResult['games'], min: Minutes) {
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

/**
 * Runs the import once consent is in hand. `state === 'public'` and
 * `playtime_hidden` / `empty` are all readable libraries and get persisted;
 * `private`, `game_details_private` and `error` store nothing.
 */
/**
 * Resolve, fetch and store a Steam library, then report the outcome.
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
        : "I couldn't turn that into a Steam account. Paste your full profile URL — it looks like `https://steamcommunity.com/id/yourname` or `https://steamcommunity.com/profiles/7656119…`.";
    await interaction.editReply({
      embeds: [noticeEmbed("That isn't a Steam profile I can read", msg, COLORS.err)],
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

  // linkSteam must run first: syncLibrary updates the steam_accounts row.
  const link = linkSteam(ctx.db, userId, id64, addedBy);
  if (!link.ok) {
    // Steam IDs are public, so this is someone typing an ID that is not theirs
    // (or a genuine duplicate). Either way we do not move the claim.
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'That Steam account is already linked',
          'Somebody on Discord has already linked this Steam account, so I will not move it.\n\nIf it is yours, ask them to run **/steam unlink**, or link a different account.',
          COLORS.warn,
        ),
      ],
      components: [],
    });
    return;
  }
  setOptedIn(ctx.db, userId, true);
  try {
    await syncLibrary(ctx.db, userId, id64, cachedSource(lib));
  } catch (err) {
    console.error('[steam] syncLibrary failed', err);
  }

  if (lib.state !== 'public') {
    const m = profileStateMessage(lib.state, lib.personaName, min);
    await interaction.editReply({
      embeds: [profileStateEmbed(lib.state, lib.personaName, min)],
      components: m.privacyHelp ? [retryRow(userId, true)] : [],
    });
    return;
  }

  const stats = libraryStats(lib.games, min);
  await interaction.editReply({
    embeds: [
      linkSuccessEmbed({
        personaName: lib.personaName ?? 'your Steam account',
        avatarUrl: lib.avatarUrl,
        ownedTotal: stats.ownedTotal,
        matchable: stats.matchable,
        minPlaytime: min,
        totalMinutes: stats.totalMinutes,
        recentCount: stats.recent,
        refreshHours: REFRESH_HOURS,
        guildName: interaction.guild?.name ?? 'this server',
        forUserId: addedBy === null ? null : userId,
      }),
    ],
    components: [],
  });
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

    if (sub === 'unlink')    if (sub === 'unlink') {
      unlink(ctx.db, userId);
      setOptedIn(ctx.db, userId, false);
      clearConsent(userId);
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            'Unlinked — everything is gone',
            'Your Steam ID, your game list and your playtime have been deleted. You no longer appear in anyone\'s /match, /games who or /games leaderboard.\n\nRun **/games add** any time to start over.',
            COLORS.ok,
          ),
        ],
        components: [],
      });
      return;
    }

    if (sub === 'refresh') {
      const link = getLinkInfo(ctx.db, userId);
      if (!link) {
        await interaction.editReply({
          embeds: [
            noticeEmbed(
              'Nothing to refresh',
              'You have no Steam account linked. Run **/games add** first.',
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
              'Already refreshed recently',
              `Steam rate-limits me, so manual refreshes are once every 15 minutes. Try again <t:${readyAt}:R>.\n\nYour library also refreshes on its own about every ${REFRESH_HOURS} hours.`,
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
        console.error('[steam] refresh fetch failed', err);
        lib = { state: 'error', personaName: link.personaName, avatarUrl: null, games: [] };
      }

      // Persist first where Steam gave us a real answer: 'playtime_hidden' and
      // 'empty' are authoritative libraries, they just have nothing matchable.
      if (lib.state !== 'error' && lib.state !== 'private' && lib.state !== 'game_details_private') {
        try {
          await syncLibrary(ctx.db, userId, link.id64, cachedSource(lib));
        } catch (err) {
          console.error('[steam] refresh sync failed', err);
        }
      }

      if (lib.state !== 'public') {
        // Every non-public state needs its own explanation. Reporting
        // "imported 412 games, 0 matchable" as a green success is how a user
        // who has NOT fixed their privacy setting concludes the bot is broken.
        // A failure is not the user's fault, so shorten the wait -- but do not
        // clear it: an always-failing profile would otherwise be an unlimited
        // free loop against the shared Steam rate limiter.
        softenRefreshMark(userId);
        const m = profileStateMessage(lib.state, lib.personaName ?? link.personaName, min);
        await interaction.editReply({
          embeds: [profileStateEmbed(lib.state, lib.personaName ?? link.personaName, min)],
          components: [retryRow(userId, m.privacyHelp)],
        });
        return;
      }

      const stats = libraryStats(lib.games, min);
      await interaction.editReply({
        embeds: [
          linkSuccessEmbed({
            personaName: lib.personaName ?? link.personaName ?? 'your Steam account',
            avatarUrl: lib.avatarUrl,
            ownedTotal: stats.ownedTotal,
            matchable: stats.matchable,
            minPlaytime: min,
            totalMinutes: stats.totalMinutes,
            recentCount: stats.recent,
            refreshHours: REFRESH_HOURS,
            guildName: interaction.guild?.name ?? 'this server',
          }),
        ],
        components: [],
      });
      return;
    }

    await interaction.editReply({
      embeds: [noticeEmbed('Unknown subcommand', `I do not know \`/steam ${sub}\`.`, COLORS.err)],
    });
  },
};

export default command;
