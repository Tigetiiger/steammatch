/**
 * /games list | shared | who | leaderboard   (prototype screens 4, 5, 6, 8)
 */

import {
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { SlashCommandIntegerOption } from 'discord.js';
import type { GameRow, LeaderRow, Minutes, SharedRow } from '../types.js';
import { iconUrl, storeUrl } from '../steam/sync.js';
import {
  leaderboard,
  listGames,
  searchGamesForAutocomplete,
  sharedGames,
  whoOwns,
  ensureUser,
  touchGuildMember,
} from '../db/queries.js';
import {
  COLORS,
  LIMITS,
  fmtMinutes,
  gameName,
  leaderboardEmbed,
  libraryEmbed,
  noticeEmbed,
  notLinkedEmbed,
  safeName,
  profileStateEmbed,
  retryRow,
  sharedEmbed,
  truncate,
  whoEmbed,
  whoRow,
} from '../ui/embeds.js';
import { claimSessionId, paginate, releaseSession } from '../ui/paginate.js';
import { openAddPanel } from './add-panel.js';
import {
  LEADERBOARD_MIN_OWNERS,
  ROW_LIMITS,
  agoLabel,
  displayNameOf,
  getGameMeta,
  getGuildStats,
  getLinkInfo,
  guildOnlyEmbed,
  refuseIfSteamToken,
  resolveMinPlaytime,
  type Command,
} from './index.js';

const LIST_PAGE = 10;
const SHARED_PAGE = 8;
// NOTE: a literal, not ROW_LIMITS.owners. commands/index.ts and this module are
// mutually imported, so at THIS module's evaluation time index.ts's consts are
// still in their temporal dead zone. ROW_LIMITS is only safe inside functions.
const WHO_MAX_OWNERS = 25;

export function minPlaytimeOption(o: SlashCommandIntegerOption): SlashCommandIntegerOption {
  return o
    .setName('min_playtime')
    .setDescription('Minutes played, exclusive. Default 30.')
    .setRequired(false)
    .setMinValue(0)
    .setMaxValue(100_000);
}

const data = new SlashCommandBuilder()
  .setName('games')
  .setDescription('Browse libraries in this server')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add games to your list — Steam, or anything else you play')
      .addUserOption((o) =>
        o
          .setName('user')
          .setDescription('Add games FOR someone else (needs Manage Server)')
          .setRequired(false),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('list')
      .setDescription('Your library, sorted by playtime')
      .addIntegerOption(minPlaytimeOption)
      .addBooleanOption((o) =>
        o
          .setName('public')
          .setDescription('Post it in the channel instead of only showing it to you')
          .setRequired(false),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('shared')
      .setDescription('Games you and one other member both play')
      .addUserOption((o) =>
        o.setName('user').setDescription('Who to compare against').setRequired(true),
      )
      .addIntegerOption(minPlaytimeOption),
  )
  .addSubcommand((s) =>
    s
      .setName('who')
      .setDescription('Who in this server plays a game')
      .addStringOption((o) =>
        o
          .setName('game')
          .setDescription('Start typing a game name')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(LIMITS.choiceValue),
      )
      .addIntegerOption(minPlaytimeOption),
  )
  .addSubcommand((s) =>
    s
      .setName('leaderboard')
      .setDescription('What this server plays most')
      .addBooleanOption((o) =>
        o
          .setName('mine')
          .setDescription('Only games you have, ranked by how many people here share them'),
      )
      .addIntegerOption(minPlaytimeOption),
  );

/* -------------------------------------------------------------------------- */

const command: Command = {
  data,

  /**
   * Autocomplete has a hard 3-second window and CANNOT be deferred, so this
   * touches local SQLite only -- never Steam, never anything awaited over the
   * network. `value` is the appid so execute resolves exactly; autocomplete is
   * not enforcing, so execute still handles arbitrary typed text.
   */
  async autocomplete(interaction, ctx) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'game') {
      await interaction.respond([]);
      return;
    }
    const query = (focused.value ?? '').toString().trim();
    try {
      const rows = searchGamesForAutocomplete(
        ctx.db,
        interaction.guildId ?? '',
        query,
        ROW_LIMITS.autocomplete,
      );
      await interaction.respond(
        rows.slice(0, 25).map((g) => ({
          // Prototype screen 6 shows "<name> (N owners)" -- the count is the
          // whole reason the list is ranked, so it belongs in the label.
          name: truncate(
            `${g.name} (${g.owners} ${g.owners === 1 ? 'owner' : 'owners'})`,
            LIMITS.choiceName,
          ),
          value: truncate(String(g.appid), LIMITS.choiceValue),
        })),
      );
    } catch (err) {
      console.error('[games] autocomplete failed', err);
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    // The add panel is always private: it is a personal setup flow, and when a
    // moderator runs it for someone else it should not be broadcast either.
    const isPublic =
      sub === 'add' ? false : sub === 'list' ? interaction.options.getBoolean('public') === true : true;

    // Before the defer: /games who defers PUBLICLY, and a token refusal is a
    // private security message -- it must never be posted into the channel.
    const rawGame = sub === 'who' ? (interaction.options.getString('game') ?? '') : '';
    if (rawGame && (await refuseIfSteamToken(interaction, rawGame))) return;

    await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

    if (!interaction.guildId || !interaction.guild) {
      await interaction.editReply({ embeds: [guildOnlyEmbed()] });
      return;
    }
    ensureUser(ctx.db, userId);
    touchGuildMember(ctx.db, interaction.guildId, userId);

    const min = resolveMinPlaytime(
      ctx.db,
      interaction.guildId,
      interaction.options.getInteger('min_playtime'),
    );

    if (sub === 'add') return addSub(interaction, ctx, min);
    if (sub === 'list') return listSub(interaction, ctx, min);
    if (sub === 'shared') return sharedSub(interaction, ctx, min);
    if (sub === 'who') return whoSub(interaction, ctx, min);
    if (sub === 'leaderboard') return leaderboardSub(interaction, ctx, min);

    await interaction.editReply({
      embeds: [noticeEmbed('Unknown subcommand', `I do not know \`/games ${sub}\`.`, COLORS.err)],
    });
  },
};

export default command;

/* -------------------------------------------------------------------------- */
/* Screen 4                                                                    */
/* -------------------------------------------------------------------------- */

type Ctx = Parameters<NonNullable<Command['execute']>>[1];
type Inter = Parameters<NonNullable<Command['execute']>>[0];

const byPlaytime = (a: GameRow, b: GameRow) => b.playtime - a.playtime;

/** /games add -- opens the panel, optionally on someone else's behalf. */
async function addSub(interaction: Inter, ctx: Ctx, min: Minutes): Promise<void> {
  const actorId = interaction.user.id;
  const target = interaction.options.getUser('user');
  const onBehalf = target !== null && target.id !== actorId;

  if (onBehalf) {
    // Same gate as the panel's on-behalf flow: without it any member could build
    // a game list for anyone else.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            'You cannot add games for other people',
            'Adding games **for someone else** needs the **Manage Server** permission.\n\nRun **/games add** with no `user` to manage your own.',
            COLORS.err,
          ),
        ],
      });
      return;
    }
    if (target.bot) {
      await interaction.editReply({
        embeds: [noticeEmbed('Bots do not play games', 'Pick a person instead.', COLORS.warn)],
      });
      return;
    }
    ensureUser(ctx.db, target.id);
    touchGuildMember(ctx.db, interaction.guildId!, target.id);
  }

  await openAddPanel(interaction, ctx, onBehalf ? target.id : actorId, min);
}

async function listSub(interaction: Inter, ctx: Ctx, min: Minutes): Promise<void> {
  const userId = interaction.user.id;
  // Pulled unfiltered so the 30m/1h/5h/10h/All buttons never need another query.
  // -1, not 0: the queries are strictly `>`, so a threshold of 0 would hide
  // every 0-minute game and make the "All" button a lie.
  const all = [...listGames(ctx.db, userId, -1, ROW_LIMITS.library, 0)].sort(byPlaytime);
  const link = getLinkInfo(ctx.db, userId);
  if (link === null) {
    await interaction.editReply({ embeds: [notLinkedEmbed()] });
    return;
  }
  if (all.length === 0) {
    // Linked, but nothing stored: a hidden-playtime profile imports every game
    // at 0 minutes. Telling them to run /games add -- which they just did --
    // is the single most confusing thing the bot could say here.
    await interaction.editReply({
      embeds: [profileStateEmbed('playtime_hidden', null, min)],
      components: [retryRow(userId, true)],
    });
    return;
  }
  const synced = agoLabel(link?.lastSyncedAt ?? null);
  const displayName = displayNameOf(interaction, userId);

  await paginate<GameRow>({
    interaction,
    ownerId: userId,
    rows: all,
    filter: min,
    pageSize: LIST_PAGE,
    showFilters: true,
    applyFilter: (rows, m) => rows.filter((g) => g.playtime > m),
    render: (v) =>
      libraryEmbed({
        displayName,
        pageRows: v.pageRows,
        offset: v.offset,
        page: v.page,
        pages: v.pages,
        matching: v.rows.length,
        matchingMinutes: v.rows.reduce((s, g) => s + g.playtime, 0),
        ownedTotal: all.length,
        filter: v.filter,
        syncedAgo: synced,
      }),
  });
}

/* -------------------------------------------------------------------------- */
/* Screen 5                                                                    */
/* -------------------------------------------------------------------------- */

/** Sorted by whoever has played it least -- the top row is tonight's pick. */
const byWeaker = (a: SharedRow, b: SharedRow) =>
  Math.min(b.mine, b.theirs) - Math.min(a.mine, a.theirs);

async function sharedSub(interaction: Inter, ctx: Ctx, min: Minutes): Promise<void> {
  const me = interaction.user.id;
  const them = interaction.options.getUser('user', true);
  // Guild-scoped: comparing against someone who has hidden themselves HERE must
  // reveal nothing, even if they are visible in another guild.
  const guildId = interaction.guildId ?? '';

  if (them.id === me) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'You already own everything you own',
          'Pick somebody else to compare with — or run **/match** to see who is closest to you.',
          COLORS.warn,
        ),
      ],
    });
    return;
  }
  if (them.bot) {
    await interaction.editReply({
      embeds: [noticeEmbed('Bots do not play games', 'Pick a person instead.', COLORS.warn)],
    });
    return;
  }

  const rows = [...sharedGames(ctx.db, guildId, me, them.id, min)].sort(byWeaker);
  const meName = displayNameOf(interaction, me);
  const themName =
    interaction.guild?.members.cache.get(them.id)?.displayName ?? them.displayName ?? them.username;

  if (rows.length === 0) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          `${gameName(meName, 40)} & ${gameName(themName, 40)} — nothing in common`,
          `Neither of you has a game the other has also played for more than ${fmtMinutes(min)}. Lower **min_playtime**, or one of you has not linked a library yet.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  const myCount = listGames(ctx.db, me, min, ROW_LIMITS.library, 0).length;
  const theirCount = listGames(ctx.db, them.id, min, ROW_LIMITS.library, 0).length;

  await paginate<SharedRow>({
    interaction,
    ownerId: me,
    rows,
    filter: min,
    pageSize: SHARED_PAGE,
    render: (v) =>
      sharedEmbed({
        meName,
        themName,
        pageRows: v.pageRows,
        offset: v.offset,
        page: v.page,
        pages: v.pages,
        total: v.rows.length,
        myLibrarySize: myCount,
        theirLibrarySize: theirCount,
        filter: v.filter,
      }),
    extra: {
      buttons: (v) => [
        new ButtonBuilder()
          .setCustomId(`px:${v.id}:random`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('Pick one at random'),
      ],
      handle: async (i, v, key) => {
        if (key !== 'random') return 'rerender';
        const pick = v.rows[Math.floor(Math.random() * v.rows.length)];
        if (!pick) {
          await i.reply({
            content: 'Nothing to pick from.',
            flags: MessageFlags.Ephemeral,
          });
          return 'handled';
        }
        await i.reply({
          content: `Tonight: **${gameName(pick.name)}** — ${safeName(meName)} and ${safeName(themName)} both play it.`,
          allowedMentions: { parse: [] },
        });
        return 'handled';
      },
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Screen 6                                                                    */
/* -------------------------------------------------------------------------- */

async function whoSub(interaction: Inter, ctx: Ctx, min: Minutes): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const raw = (interaction.options.getString('game', true) ?? '').trim();
  // NOTE: the token check runs in execute(), BEFORE the public defer. Doing it
  // here would editReply a publicly-deferred interaction and post the refusal
  // into the channel -- exactly the bug that check was moved to avoid.

  // Autocomplete sends the appid as the value, but nothing forces the user to
  // pick a suggestion -- fall back to a name search on arbitrary typed text.
  let appid: number | null = null;
  if (/^\d{1,10}$/.test(raw)) appid = Number.parseInt(raw, 10);
  if (appid === null || getGameMeta(ctx.db, appid) === null) {
    const hits = raw.length > 0 ? searchGamesForAutocomplete(ctx.db, guildId, raw, 1) : [];
    const first = hits[0];
    appid = first ? first.appid : null;
  }

  const meta = appid === null ? null : getGameMeta(ctx.db, appid);
  if (appid === null || meta === null) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'I do not know that game',
          raw.length === 0
            ? 'Type part of a game name and pick one of the suggestions.'
            : `Nobody here owns anything matching **${gameName(raw, 60)}**. I only know games somebody in this server has linked.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  // One extra row tells us whether the list was truncated without a second query.
  const fetched = [...whoOwns(ctx.db, guildId, appid, min, WHO_MAX_OWNERS + 1)].sort(
    (a, b) => b.playtime - a.playtime,
  );
  const owners = fetched.slice(0, WHO_MAX_OWNERS);
  const totalOwners = fetched.length;

  const store = storeUrl(appid);
  // Registered so the global button router does not also answer these clicks.
  const sessionId = claimSessionId(interaction.user.id);
  const embed = whoEmbed({
    appid,
    name: meta.name,
    owners,
    totalOwners,
    filter: min,
    iconUrl: iconUrl(appid, meta.iconHash),
    storeUrl: store,
  });

  const message = await interaction.editReply({
    embeds: [embed],
    components: [whoRow(sessionId, owners.length, store)],
  });

  if (owners.length === 0) {
    releaseSession(sessionId);
    return;
  }

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    idle: 120_000,
    time: 14 * 60_000,
  });
  collector.on('collect', (i) => {
    void (async () => {
      if (i.user.id !== interaction.user.id) {
        await i
          .reply({
            content: "These buttons aren't for you — run the command yourself to get your own copy.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      if (!i.customId.endsWith(':ping')) {
        await i.deferUpdate().catch(() => {});
        return;
      }
      const ids = owners.map((o) => o.userId);
      await i
        .reply({
          content: `${ids.map((id) => `<@${id}>`).join(' ')} — ${gameName(meta.name, 80)}?`,
          allowedMentions: { users: ids.slice(0, 100) },
        })
        .catch(() => {});
      collector.stop('pinged');
    })();
  });
  collector.on('end', () => {
    releaseSession(sessionId);
    interaction.editReply({ components: [] }).catch(() => {});
  });
}

/* -------------------------------------------------------------------------- */
/* Screen 8                                                                    */
/* -------------------------------------------------------------------------- */

async function leaderboardSub(interaction: Inter, ctx: Ctx, min: Minutes): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const mine = interaction.options.getBoolean('mine') === true;
  // Both boards need 2+ owners: a game only you have is not "shared with you".
  const minOwners = LEADERBOARD_MIN_OWNERS;

  const rows: LeaderRow[] = [
    ...leaderboard(
      ctx.db,
      guildId,
      min,
      minOwners,
      ROW_LIMITS.leaderboard,
      mine ? interaction.user.id : null,
    ),
  ].sort((a, b) => b.owners - a.owners || b.guildMinutes - a.guildMinutes);
  const stats = getGuildStats(ctx.db, guildId);
  const guildLabel = interaction.guild?.name ?? 'This server';

  if (rows.length === 0) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          `${gameName(guildLabel, 80)} — nothing to rank yet`,
          `No game here has two members with more than ${fmtMinutes(min)} played. Once a couple more people run **/games add** this fills up.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  await paginate<LeaderRow>({
    interaction,
    ownerId: interaction.user.id,
    rows,
    filter: min,
    pageSize: LIST_PAGE,
    render: (v) =>
      leaderboardEmbed({
        guildName: guildLabel,
        pageRows: v.pageRows,
        offset: v.offset,
        page: v.page,
        pages: v.pages,
        memberCount: stats.members,
        distinctGames: stats.distinctGames,
        filter: v.filter,
        scope: mine ? 'mine' : 'guild',
      }),
  });
}
