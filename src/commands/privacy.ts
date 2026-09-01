/**
 * /privacy — toggle discoverability, per-guild visibility, or delete everything.
 * Always ephemeral: nobody else needs to watch you change these.
 */

import { ComponentType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  ensureUser,
  forget,
  setDiscoverable,
  setGuildVisible,
  touchGuildMember,
} from '../db/queries.js';
import {
  COLORS,
  forgetConfirmRow,
  noticeEmbed,
  privacyEmbed,
  privacyRows,
  type PrivacyView,
} from '../ui/embeds.js';
import { claimSessionId, releaseSession } from '../ui/paginate.js';
import {
  getLinkInfo,
  getPrivacyState,
  guildOnlyEmbed,
  type Command,
} from './index.js';
import { clearConsent } from './user-state.js';

const data = new SlashCommandBuilder()
  .setName('privacy')
  .setDescription('Control who can see your library, or delete everything');

const COLLECTOR_IDLE_MS = 120_000;
const COLLECTOR_TIME_MS = 14 * 60_000;

const command: Command = {
  data,

  async execute(interaction, ctx) {
    const userId = interaction.user.id;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({ embeds: [guildOnlyEmbed()] });
      return;
    }
    ensureUser(ctx.db, userId);
    touchGuildMember(ctx.db, guildId, userId);

    const guildName = interaction.guild?.name ?? 'this server';
    const view = (): PrivacyView => {
      const s = getPrivacyState(ctx.db, userId, guildId);
      return {
        linked: getLinkInfo(ctx.db, userId) !== null,
        discoverable: s.discoverable,
        guildVisible: s.guildVisible,
        guildName,
      };
    };

    // Registered so the global button router does not also answer these clicks.
    const sessionId = claimSessionId(userId);
    const payload = () => {
      const v = view();
      return { embeds: [privacyEmbed(v)], components: privacyRows(sessionId, v) };
    };

    const message = await interaction.editReply(payload());

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      idle: COLLECTOR_IDLE_MS,
      time: COLLECTOR_TIME_MS,
    });

    collector.on('collect', (i) => {
      void (async () => {
        try {
          // Ephemeral, so only the invoker can even see this -- but check anyway.
          if (i.user.id !== userId) {
            await i.reply({
              content: "These buttons aren't for you.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const key = i.customId.split(':').slice(2).join(':');

          if (key === 'discoverable') {
            setDiscoverable(ctx.db, userId, !view().discoverable);
            await i.update(payload());
            return;
          }
          if (key === 'visible') {
            setGuildVisible(ctx.db, guildId, userId, !view().guildVisible);
            await i.update(payload());
            return;
          }
          if (key === 'forget') {
            await i.update({
              embeds: [
                noticeEmbed(
                  'Delete everything?',
                  'This removes your Steam link, every game name and every playtime I hold for you. It is immediate and cannot be undone.',
                  COLORS.err,
                ),
              ],
              components: [forgetConfirmRow(sessionId)],
            });
            return;
          }
          if (key === 'forget_yes') {
            forget(ctx.db, userId);
            // The confirmation below promises the consent prompt comes back.
            // Without this, the next /games add sync in this process skips it.
            clearConsent(userId);
            await i.update({
              embeds: [
                noticeEmbed(
                  'Deleted',
                  'Everything I held about you is gone. You will not appear in anyone\'s /match, /games who or /games leaderboard.\n\nIf you change your mind, **/games add** starts fresh — with the consent prompt again.',
                  COLORS.ok,
                ),
              ],
              components: [],
            });
            collector.stop('forgotten');
            return;
          }
          if (key === 'forget_no') {
            await i.update(payload());
            return;
          }
          await i.deferUpdate();
        } catch (err) {
          console.error('[privacy] button handler failed', err);
          if (!i.replied && !i.deferred) {
            await i
              .reply({
                content: 'That did not go through. Run **/privacy** again.',
                flags: MessageFlags.Ephemeral,
              })
              .catch(() => {});
          }
        }
      })();
    });

    collector.on('end', (_c, reason) => {
      releaseSession(sessionId);
      if (reason === 'forgotten') return;
      interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};

export default command;
