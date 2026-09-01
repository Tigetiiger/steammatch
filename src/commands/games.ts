/**
 * /games list | shared | who | leaderboard   (prototype screens 4, 5, 6, 8)
 */

import {
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { SlashCommandIntegerOption } from 'discord.js';
import type { GameRow, LeaderRow, Minutes, SharedRow } from '../types.js';
import { iconUrl, storeUrl } from '../steam/sync.js';
import {
  isVisibleInGuild,
  leaderboard,
  guildGameMeta,
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
  pingCopyMessage,
  notLinkedEmbed,
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
    .setDescription('Vähim mänguaeg minutites. Vaikimisi 30.')
    .setRequired(false)
    .setMinValue(0)
    .setMaxValue(100_000);
}

const data = new SlashCommandBuilder()
  .setName('games')
  .setDescription('Sirvi selle serveri mängukogusid')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Lisa mänge oma nimekirja — Steamist või mujalt')
      .addUserOption((o) =>
        o
          .setName('user')
          .setDescription('Lisa mänge KELLEGI TEISE eest (vajab Manage Server õigust)')
          .setRequired(false),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('list')
      .setDescription('Sinu mängud, mänguaja järjekorras')
      .addIntegerOption(minPlaytimeOption)
      .addBooleanOption((o) =>
        o
          .setName('public')
          .setDescription('Postita kanalisse, mitte ainult sulle')
          .setRequired(false),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('shared')
      .setDescription('Mängud, mida te mõlemad mängite')
      .addUserOption((o) =>
        o.setName('user').setDescription('Kellega võrrelda').setRequired(true),
      )
      .addIntegerOption(minPlaytimeOption),
  )
  .addSubcommand((s) =>
    s
      .setName('who')
      .setDescription('Kes selles serveris mängu mängib')
      .addStringOption((o) =>
        o
          .setName('game')
          .setDescription('Hakka mängu nime kirjutama')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(LIMITS.choiceValue),
      )
      .addIntegerOption(minPlaytimeOption),
  )
  .addSubcommand((s) =>
    s
      .setName('leaderboard')
      .setDescription('Mida selles serveris kõige rohkem mängitakse')
      .addUserOption((o) =>
        o
          .setName('user')
          .setDescription('Kelle vaatenurgast — tema mängud jagajate arvu järgi. Tühi = kogu server')
          .setRequired(false),
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
            `${g.name} (${g.owners} ${g.owners === 1 ? 'mängija' : 'mängijat'})`,
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
      embeds: [noticeEmbed('Tundmatu alamkäsk', `Ma ei tunne käsku \`/games ${sub}\`.`, COLORS.err)],
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
            'Sa ei saa teiste eest mänge lisada',
            'Teise inimese eest mängude lisamiseks on vaja **Manage Server** õigust.\n\nOma mängude haldamiseks käivita **/games add** ilma `user` valikuta.',
            COLORS.err,
          ),
        ],
      });
      return;
    }
    if (target.bot) {
      await interaction.editReply({
        embeds: [noticeEmbed('Botid ei mängi', 'Vali päris inimene.', COLORS.warn)],
      });
      return;
    }
    ensureUser(ctx.db, target.id);
    touchGuildMember(ctx.db, interaction.guildId!, target.id);
  }

  await openAddPanel(interaction, ctx, onBehalf ? target.id : actorId, min);
}

/**
 * The in-memory twin of the SQL predicate `(playtime_tracked = 0 OR
 * playtime_forever > @min)`.
 *
 * /games list pulls the whole library once and re-filters it in the process
 * when a threshold button is pressed, so this rule exists in two places and
 * they have to agree. An untracked row's 0 means "no playtime known", not
 * "never played" -- drop the `!tracked` arm and the default 30-minute filter
 * silently swallows every hand-added game the moment the list renders.
 */
export function passesPlaytimeFilter(
  game: { playtime: Minutes; tracked: boolean },
  min: Minutes,
): boolean {
  return !game.tracked || game.playtime > min;
}

async function listSub(interaction: Inter, ctx: Ctx, min: Minutes): Promise<void> {
  const userId = interaction.user.id;
  // Pulled unfiltered so the 30m/1h/5h/10h/All buttons never need another query.
  // -1, not 0: the queries are strictly `>`, so a threshold of 0 would hide
  // every 0-minute game and make the "All" button a lie.
  const all = [...listGames(ctx.db, userId, -1, ROW_LIMITS.library, 0)].sort(byPlaytime);
  const link = getLinkInfo(ctx.db, userId);
  // Games first, link second. A person can have games without a Steam account:
  // everything added by hand through the /games add panel. Asking "are you
  // linked?" before "do you have anything?" told those people they had no
  // library while the panel was happily storing one.
  if (all.length === 0) {
    if (link === null) {
      await interaction.editReply({ embeds: [notLinkedEmbed()] });
      return;
    }
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
    applyFilter: (rows, m) => rows.filter((g) => passesPlaytimeFilter(g, m)),
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
          'Sa jagad iseendaga kõike',
          'Vali keegi teine — või käivita **/match**, et näha, kes on sulle kõige lähedasem.',
          COLORS.warn,
        ),
      ],
    });
    return;
  }
  if (them.bot) {
    await interaction.editReply({
      embeds: [noticeEmbed('Botid ei mängi', 'Vali päris inimene.', COLORS.warn)],
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
          `${gameName(meName, 40)} & ${gameName(themName, 40)} — ühiseid mänge pole`,
          `Teil pole ühtki mängu, mida mõlemad oleksid mänginud üle ${fmtMinutes(min)}. Proovi väiksemat **min_playtime** väärtust.`,
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
  //
  // The leading `-?` is load-bearing: manually added games carry a synthetic
  // NEGATIVE appid, so without it picking "Minecraft" from the suggestions sent
  // "-1", failed this test, fell through to a name search for the literal text
  // "-1", and reported that nobody owns the game the user had just been offered.
  let appid: number | null = null;
  if (/^-?\d{1,10}$/.test(raw)) appid = Number.parseInt(raw, 10);
  // guildGameMeta, not a global lookup: a game nobody here visibly owns must not
  // resolve at all, or /games who renders the title and icon of something whose
  // only local owner hid it with /steam change.
  if (appid === null || guildGameMeta(ctx.db, guildId, appid) === null) {
    const hits = raw.length > 0 ? searchGamesForAutocomplete(ctx.db, guildId, raw, 1) : [];
    const first = hits[0];
    appid = first ? first.appid : null;
  }

  const meta = appid === null ? null : guildGameMeta(ctx.db, guildId, appid);
  if (appid === null || meta === null) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Ma ei tunne seda mängu',
          raw.length === 0
            ? 'Kirjuta osa mängu nimest ja vali pakutust.'
            : `Kellelgi siin pole midagi, mis sobiks otsinguga **${gameName(raw, 60)}**. Tunnen ainult mänge, mille keegi siin on lisanud.`,
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

  // Only Steam apps have a store page. A manual game's synthetic negative appid
  // would build https://store.steampowered.com/app/-1, which is a 404.
  const store = appid > 0 ? storeUrl(appid) : null;
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

  // With no owners AND no store page there is nothing to put in the row, and
  // Discord rejects an action row with zero components.
  const row = whoRow(sessionId, owners.length, store);
  const message = await interaction.editReply({
    embeds: [embed],
    components: row.components.length > 0 ? [row] : [],
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
      // Copy is open to anyone who can see the message: it hands back exactly
      // what is already on their screen, privately, and pings nobody. Ping is
      // not -- it notifies up to 25 people, so it stays with whoever ran the
      // command rather than being a button any passer-by can fire.
      if (i.customId.endsWith(':copy')) {
        await i
          .reply({
            content: pingCopyMessage(gameName(meta.name, 80), owners.map((o) => o.userId)),
            // Belt and braces. The mentions are inside a code block and inert
            // already; this makes a stray backtick in a game name unable to
            // turn the block into a live ping of everybody in it.
            allowedMentions: { parse: [] },
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      if (i.user.id !== interaction.user.id) {
        await i
          .reply({
            content: 'Need nupud pole sinu omad — käivita käsk ise.',
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

  // Anyone's point of view, not just the caller's. Empty means the whole server.
  const target = interaction.options.getUser('user');
  const subjectId = target?.id ?? null;
  const viewerId = interaction.user.id;
  const subjectIsViewer = subjectId === viewerId;

  if (target?.bot) {
    await interaction.editReply({
      embeds: [noticeEmbed('Botid ei mängi', 'Vali päris inimene.', COLORS.warn)],
    });
    return;
  }

  // The query enforces this itself; checking here only buys a message that says
  // WHY the board is empty, which an empty result set cannot distinguish.
  if (subjectId !== null && !subjectIsViewer && !isVisibleInGuild(ctx.db, guildId, subjectId)) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Seda liiget ma siin näidata ei saa',
          'Ta ei ole selles serveris nähtav või pole oma mänge lisanud.',
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  // Both boards need 2+ owners: a game only one person has is not "shared".
  const minOwners = LEADERBOARD_MIN_OWNERS;

  const rows: LeaderRow[] = [
    ...leaderboard(ctx.db, guildId, min, minOwners, ROW_LIMITS.leaderboard, subjectId, viewerId),
  ].sort((a, b) => b.owners - a.owners || b.guildMinutes - a.guildMinutes);
  const stats = getGuildStats(ctx.db, guildId);
  const guildLabel = interaction.guild?.name ?? 'This server';
  const subjectName = subjectId === null ? null : displayNameOf(interaction, subjectId);

  if (rows.length === 0) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          subjectId === null
            ? `${gameName(guildLabel, 80)} — pole veel midagi järjestada`
            : `${gameName(subjectIsViewer ? 'Sina' : (subjectName ?? 'Tema'), 60)} — pole veel midagi järjestada`,
          subjectId === null
            ? `Ühelgi mängul pole kahte liiget, kes oleksid seda mänginud üle ${fmtMinutes(min)}. Kui veel paar inimest käivitavad **/games add**, siis täitub.`
            : `Ühtki ${subjectIsViewer ? 'sinu' : 'tema'} mängu ei mängi siin keegi teine üle ${fmtMinutes(min)}. Proovi väiksemat **min_playtime** väärtust.`,
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
        subjectName,
        subjectIsViewer,
        pageRows: v.pageRows,
        offset: v.offset,
        page: v.page,
        pages: v.pages,
        memberCount: stats.members,
        distinctGames: stats.distinctGames,
        filter: v.filter,
        scope: subjectId === null ? 'guild' : 'user',
      }),
  });
}
