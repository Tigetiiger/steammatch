/**
 * Bot entrypoint.
 *
 * Intents: Guilds ONLY. INTERACTION_CREATE is not intent-gated, and the USER
 * option on /games shared resolves straight out of the interaction payload, so
 * this bot needs no privileged intents at all — no GuildMembers, no
 * MessageContent. That is also why the Steam-token refusal is wired into our own
 * command options instead of a message listener.
 */

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { openDb } from './db/index.js';
import { SteamClient } from './steam/client.js';
import { startRefresher } from './steam/refresher.js';
import { commandMap } from './commands/registry.js';
import {  type BotContext } from './commands/index.js';
import { COLORS, noticeEmbed } from './ui/embeds.js';
import { hasSession } from './ui/paginate.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const token = required('DISCORD_TOKEN');
const steamApiKey = required('STEAM_API_KEY');
const dbPath = process.env['DB_PATH'] ?? './data/bot.sqlite';

const ctx: BotContext = {
  db: openDb(dbPath),
  steam: new SteamClient(steamApiKey),
  steamApiKey,
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Ready as ${c.user.tag} · ${commandMap.size} commands loaded`);
  // Keeps the promise made by the consent screen and the "Next refresh" field.
  startRefresher(ctx.db, ctx.steam);
});

client.on(Events.InteractionCreate, (interaction: Interaction) => {
  void route(interaction);
});

async function route(interaction: Interaction): Promise<void> {
  /* ---- autocomplete: 3-second hard deadline, cannot be deferred ---------- */
  if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName);
    if (!command?.autocomplete) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    try {
      await command.autocomplete(interaction, ctx);
    } catch (err) {
      console.error(`[autocomplete] ${interaction.commandName} failed`, err);
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  /* ---- buttons ----------------------------------------------------------- */
  if (interaction.isButton()) {
    // Paginator, consent and /privacy buttons are owned by per-message
    // collectors, which receive this same event. Answering here too would
    // double-ack, so anything with a LIVE session id is left alone; only orphans
    // (bot restarted, collector expired) and the stateless "Try again" button
    // are handled here.
    const sessionId = interaction.customId.split(':')[1] ?? '';
    if (/^(pg|pf|px|gp|consent):/.test(interaction.customId) && hasSession(sessionId)) return;

    if (interaction.customId.startsWith('retry:')) {
      await interaction
        .reply({
          embeds: [
            noticeEmbed(
              'Ready when you are',
              'Once the Steam setting is changed, run **/games add** and sync again with the same profile URL.',
              COLORS.brand,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    if (/^(pg|pf|px|gp|consent):/.test(interaction.customId)) {
      await interaction
        .reply({
          content: 'That message is too old for me to update. Run the command again.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return;
  }

  /* ---- select menus ------------------------------------------------------ */
  // Owned by the /games add panel's collector, same as the buttons above.
  if (interaction.isStringSelectMenu()) return;

  /* ---- slash commands ---------------------------------------------------- */
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    console.warn(`Unknown command /${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    console.error(`[command] /${interaction.commandName} failed`, err);
    const payload = {
      embeds: [
        noticeEmbed(
          'Something broke on my side',
          'That is a bug, not something you did. Try again in a moment — if it keeps happening it is worth reporting.',
          COLORS.err,
        ),
      ],
    };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      console.error('[command] could not report the failure to the user', replyErr);
    }
  }
}

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

await client.login(token);
