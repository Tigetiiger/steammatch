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
  .setDescription('Halda, kes su kogu näeb, või kustuta kõik');

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
              content: 'Need nupud pole sinu omad.',
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
                  'Kustutada kõik?',
                  'See eemaldab su Steami ühenduse, kõik mängud ja mänguajad. Seda ei saa tagasi võtta.',
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
                  'Kustutatud',
                  'Kõik sinu kohta salvestatu on kustutatud. Sa ei ilmu enam kellegi tulemustes.\n\nKui ümber mõtled, alusta uuesti: **/games add**',
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
                content: 'See ei läinud läbi. Käivita **/privacy** uuesti.',
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
