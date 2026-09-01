/**
 * /match   (prototype screen 7)
 *
 * `sort` chooses the ranking, but BOTH numbers are printed on every row no
 * matter which one is active. That is an explicit product decision: changing the
 * sort must never take information away from the reader.
 */

import { SlashCommandBuilder } from 'discord.js';
import type { MatchRow, Minutes } from '../types.js';
import { ensureUser, findMatches, touchGuildMember } from '../db/queries.js';
import {
  COLORS,
  matchEmbed,
  matchSortRow,
  noticeEmbed,
  notLinkedEmbed,
  fmtMinutes,
  type MatchSort,
} from '../ui/embeds.js';
import { paginate } from '../ui/paginate.js';
import { minPlaytimeOption } from './games.js';
import {
  ROW_LIMITS,
  displayNameOf,
  getGuildStats,
  getLinkInfo,
  guildOnlyEmbed,
  resolveMinPlaytime,
  type Command,
} from './index.js';

const MATCH_PAGE = 10;

const data = new SlashCommandBuilder()
  .setName('match')
  .setDescription('Find the people in this server whose library is most like yours')
  .addIntegerOption(minPlaytimeOption)
  .addStringOption((o) =>
    o
      .setName('sort')
      .setDescription('overlap = shared games (default) · taste = shared ÷ combined')
      .setRequired(false)
      .addChoices(
        { name: 'Rank by overlap (default)', value: 'overlap' },
        { name: 'Rank by taste', value: 'taste' },
      ),
  );

function sorter(sort: MatchSort) {
  return sort === 'taste'
    ? (a: MatchRow, b: MatchRow) => b.jaccard - a.jaccard || b.overlap - a.overlap
    : (a: MatchRow, b: MatchRow) => b.overlap - a.overlap || b.jaccard - a.jaccard;
}

const command: Command = {
  data,

  async execute(interaction, ctx) {
    const userId = interaction.user.id;
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply({ embeds: [guildOnlyEmbed()] });
      return;
    }
    ensureUser(ctx.db, userId);
    touchGuildMember(ctx.db, interaction.guildId, userId);

    const min: Minutes = resolveMinPlaytime(
      ctx.db,
      interaction.guildId,
      interaction.options.getInteger('min_playtime'),
    );
    const requested = interaction.options.getString('sort');
    const initialSort: MatchSort = requested === 'taste' ? 'taste' : 'overlap';

    // getLinkInfo, not "has rows above 0 minutes": a hidden-playtime library
    // stores every game at 0 and would otherwise be reported as not linked.
    if (getLinkInfo(ctx.db, userId) === null) {
      await interaction.editReply({ embeds: [notLinkedEmbed()] });
      return;
    }

    const rows = [
      ...findMatches(ctx.db, interaction.guildId, userId, min, ROW_LIMITS.matches, initialSort),
    ].sort(sorter(initialSort));
    const stats = getGuildStats(ctx.db, interaction.guildId);
    const displayName = displayNameOf(interaction, userId);

    if (rows.length === 0) {
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            `Nobody to match ${displayName} with yet`,
            `Nobody else here has a linked, visible library with a game you have both played for more than ${fmtMinutes(min)}. Lower **min_playtime**, or get a friend to run **/games add**.`,
            COLORS.warn,
          ),
        ],
      });
      return;
    }

    await paginate<MatchRow>({
      interaction,
      ownerId: userId,
      rows,
      filter: min,
      sort: initialSort,
      pageSize: MATCH_PAGE,
      render: (v) =>
        matchEmbed({
          displayName,
          pageRows: v.pageRows,
          offset: v.offset,
          page: v.page,
          pages: v.pages,
          memberCount: stats.members,
          filter: v.filter,
          sort: v.sort === 'taste' ? 'taste' : 'overlap',
        }),
      extra: {
        rows: (v) => [matchSortRow(v.id, v.sort === 'taste' ? 'taste' : 'overlap')],
        handle: async (_i, v, key, mutate) => {
          if (key !== 'overlap' && key !== 'taste') return 'rerender';
          mutate({ sort: key, page: 0, rows: [...v.rows].sort(sorter(key)) });
          return 'rerender';
        },
      },
    });
  },
};

export default command;
