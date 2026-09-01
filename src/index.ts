/**
 * Bot entrypoint.
 *
 * Intents: Guilds + GuildMessageReactions. Still NO PRIVILEGED intents — no
 * GuildMembers, no MessageContent, nothing to toggle in the Developer Portal.
 * INTERACTION_CREATE is not intent-gated, and the USER option on /games shared
 * resolves straight out of the interaction payload. That is also why the
 * Steam-token refusal is wired into our own command options rather than a
 * message listener.
 *
 * GuildMessageReactions exists solely for /roles, and it is what forces the
 * `partials` below: a reaction on a message the bot has not cached since it
 * started — which is every message written before the last restart — arrives
 * with only an id unless the client is told to accept partial structures.
 * Without this, role panels work in testing and stop working after a deploy.
 */

import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import type { GuildMember, Interaction } from 'discord.js';
import { openDb } from './db/index.js';
import { SteamClient } from './steam/client.js';
import { commandMap } from './commands/registry.js';
import {  type BotContext } from './commands/index.js';
import { COLORS, noticeEmbed } from './ui/embeds.js';
import { hasSession } from './ui/paginate.js';
import { applyReaction, type ReactionAction } from './roles/handler.js';
import { forgetRole } from './roles/store.js';

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Ready as ${c.user.tag} · ${commandMap.size} commands loaded`);
  // Deliberately nothing else. Steam is contacted only when a person asks:
  // once at import, and thereafter only from /steam update. There is no
  // background crawl, so nothing is started here.
});

client.on(Events.InteractionCreate, (interaction: Interaction) => {
  void route(interaction);
});

/* ---- reaction roles ------------------------------------------------------ */

/**
 * Best-effort DM. A reaction handler has no interaction to reply to, so this is
 * the only channel back to the person — and it fails silently and often,
 * because most people have server DMs closed. Never awaited for correctness.
 */
async function notify(member: GuildMember, text: string): Promise<void> {
  await member.send({ embeds: [noticeEmbed('Rolli ei saanud anda', text, COLORS.warn)] }).catch(() => {});
}

function onReaction(action: ReactionAction) {
  return (reaction: Parameters<typeof applyReaction>[1], user: Parameters<typeof applyReaction>[2]) => {
    void applyReaction({ db: ctx.db, notify }, reaction, user, action).catch((err) => {
      console.error(`[roles] ${action} handler failed`, err);
    });
  };
}

client.on(Events.MessageReactionAdd, onReaction('add'));
client.on(Events.MessageReactionRemove, onReaction('remove'));

// A deleted role leaves bindings pointing at nothing. Dropping them here keeps
// the panel honest; without it the listing shows a role mention that renders as
// a raw @&id and reacting does nothing.
client.on(Events.GuildRoleDelete, (role) => {
  try {
    const n = forgetRole(ctx.db, role.guild.id, role.id);
    if (n > 0) console.log(`[roles] dropped ${n} binding(s) for deleted role ${role.id}`);
  } catch (err) {
    console.error('[roles] could not clean up a deleted role', err);
  }
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
    if (/^(pg|pf|px|gp|cl|consent):/.test(interaction.customId) && hasSession(sessionId)) return;

    if (interaction.customId.startsWith('retry:')) {
      await interaction
        .reply({
          embeds: [
            noticeEmbed(
              'Valmis, kui sina oled',
              'Kui Steami säte on muudetud, käivita **/games add** ja sisesta sama profiili aadress uuesti.',
              COLORS.brand,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    if (/^(pg|pf|px|gp|cl|consent):/.test(interaction.customId)) {
      await interaction
        .reply({
          content: 'See sõnum on liiga vana, et seda uuendada. Käivita käsk uuesti.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return;
  }

  /* ---- select menus ------------------------------------------------------ */
  // Owned by the /games add panel's and the checklist's collectors, same as the
  // buttons above.
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
          'Midagi läks minu poolel katki',
          'See on viga minus, mitte sinus. Proovi hetke pärast uuesti.',
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
