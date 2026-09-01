/**
 * /roles — self-service reaction roles.
 *
 * Entirely separate from the Steam side of the bot: no opt-in, no consent, no
 * eligible_members, no playtime. It shares only the database file and the embed
 * helpers.
 *
 * Gated on Manage Roles at two levels. `setDefaultMemberPermissions` hides the
 * command from members who cannot use it, which is a UI convenience and NOT a
 * security boundary -- a server admin can override it per-role in the Discord
 * settings UI. The runtime check in `execute` is the one that actually holds.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction, GuildMember, Role, TextChannel } from 'discord.js';
import { COLORS, gameName, noticeEmbed, rolePanelEmbed, safeName } from '../ui/embeds.js';
import { canOfferRole, type GuardVerdict } from '../roles/guard.js';
import { emojiKey, parseEmojiInput } from '../roles/emoji.js';
import {
  MAX_BINDINGS,
  addBinding,
  createPanel,
  deletePanel,
  getPanel,
  listBindings,
  listPanels,
  newestPanel,
  removeBindingByRole,
  setExclusive,
  type RolePanel,
} from '../roles/store.js';
import { guildOnlyEmbed, type BotContext, type Command } from './index.js';

const MESSAGE_ID_RE = /(\d{15,25})\s*$/;

const data = new SlashCommandBuilder()
  .setName('roles')
  .setDescription('Rollipaneelid — liikmed valivad endale rolle reaktsiooniga')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('panel')
      .setDescription('Loo uus rollipaneel siia kanalisse')
      .addStringOption((o) =>
        o.setName('title').setDescription('Paneeli pealkiri').setRequired(true).setMaxLength(200),
      )
      .addStringOption((o) =>
        o.setName('description').setDescription('Selgitav tekst').setMaxLength(1000),
      )
      .addBooleanOption((o) =>
        o
          .setName('exclusive')
          .setDescription('Ainult üks roll korraga — uue valimine eemaldab eelmise'),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Seo emoji rolliga')
      .addRoleOption((o) => o.setName('role').setDescription('Antav roll').setRequired(true))
      .addStringOption((o) =>
        o.setName('emoji').setDescription('Emoji, millega reageerida').setRequired(true).setMaxLength(100),
      )
      .addStringOption((o) =>
        o.setName('message').setDescription('Paneeli sõnumi ID — vaikimisi uusim').setMaxLength(30),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Eemalda roll paneelilt')
      .addRoleOption((o) => o.setName('role').setDescription('Eemaldatav roll').setRequired(true))
      .addStringOption((o) =>
        o.setName('message').setDescription('Paneeli sõnumi ID — vaikimisi uusim').setMaxLength(30),
      ),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Näita selle serveri rollipaneele'))
  .addSubcommand((s) =>
    s
      .setName('delete')
      .setDescription('Kustuta paneel ja selle seosed')
      .addStringOption((o) =>
        o.setName('message').setDescription('Paneeli sõnumi ID — vaikimisi uusim').setMaxLength(30),
      ),
  );

/* -------------------------------------------------------------------------- */

const command: Command = {
  data,

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.guild || !interaction.guildId) {
      await interaction.editReply({ embeds: [guildOnlyEmbed()] });
      return;
    }

    // The real gate. setDefaultMemberPermissions only hides the command.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            'Sul pole selleks õigust',
            'Rollipaneelide haldamiseks on vaja **Manage Roles** õigust.',
            COLORS.err,
          ),
        ],
      });
      return;
    }

    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply({
        embeds: [
          noticeEmbed(
            'Mul pole õigust rolle anda',
            'Anna mulle **Manage Roles** õigus ja tõsta minu roll serveri sätetes nende rollide kohale, mida ma jagama pean.',
            COLORS.err,
          ),
        ],
      });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'panel') return panelSub(interaction, ctx);
    if (sub === 'add') return addSub(interaction, ctx);
    if (sub === 'remove') return removeSub(interaction, ctx);
    if (sub === 'list') return listSub(interaction, ctx);
    if (sub === 'delete') return deleteSub(interaction, ctx);

    await interaction.editReply({
      embeds: [noticeEmbed('Tundmatu alamkäsk', `Ma ei tunne käsku \`/roles ${sub}\`.`, COLORS.err)],
    });
  },
};

export default command;

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

type Inter = ChatInputCommandInteraction;

/**
 * Which panel a command means: the `message` option, else the newest in the
 * guild. Accepts a raw id or a message link, because copying the link is what
 * the Discord UI actually offers.
 */
function targetPanel(interaction: Inter, ctx: BotContext): RolePanel | null {
  const raw = interaction.options.getString('message');
  if (raw) {
    const id = MESSAGE_ID_RE.exec(raw.trim())?.[1];
    if (!id) return null;
    const panel = getPanel(ctx.db, id);
    // Guild-scoped: a message id from another server must not be addressable.
    return panel && panel.guildId === interaction.guildId ? panel : null;
  }
  return newestPanel(ctx.db, interaction.guildId!);
}

const NO_PANEL = noticeEmbed(
  'Paneeli ei leitud',
  'Loo esmalt paneel: **/roles panel**. Kui neid on mitu, lisa `message` valikusse paneeli sõnumi ID või link.',
  COLORS.warn,
);

/** Re-render the public panel message after its bindings changed. */
async function repaint(interaction: Inter, ctx: BotContext, panel: RolePanel): Promise<boolean> {
  const rows = listBindings(ctx.db, panel.messageId);
  try {
    const channel = await interaction.client.channels.fetch(panel.channelId);
    if (!channel || !channel.isTextBased()) return false;
    const message = await (channel as TextChannel).messages.fetch(panel.messageId);
    await message.edit({
      embeds: [rolePanelEmbed({ ...panel, rows })],
      // The panel lists roles as mentions so renames stay correct. Without this
      // every edit would ping everyone holding one of them.
      allowedMentions: { parse: [] },
    });
    return true;
  } catch {
    return false;
  }
}

function guardMessage(role: Role, verdict: GuardVerdict): string {
  if (verdict.ok) return '';
  const name = safeName(role.name, 60);
  switch (verdict.reason) {
    case 'everyone':
      return '`@everyone` on kõigil niikuinii — seda ei saa jagada.';
    case 'managed':
      return `**${name}** on boti, boosteri või integratsiooni roll. Discord ei luba neid käsitsi anda.`;
    case 'above_bot':
      return `**${name}** asub serveri sätetes minu rollist kõrgemal, nii et ma ei saa seda anda. Tõsta minu roll sellest kõrgemale.`;
    case 'above_actor':
      return `**${name}** asub sinu enda kõrgeimast rollist kõrgemal või sellega samal tasemel, nii et sa ei saa seda jagada.`;
    case 'privileged':
      // Spelled out rather than a blanket refusal: a moderator who picked the
      // wrong role from the list needs to know which permission is the problem.
      return `**${name}** annab moderaatoriõigusi (${verdict.detail}). Neid ei tohi jagada reaktsiooniga, sest paneelilt saab rolli võtta igaüks.`;
  }
}

/* -------------------------------------------------------------------------- */
/* /roles panel                                                                */
/* -------------------------------------------------------------------------- */

async function panelSub(interaction: Inter, ctx: BotContext): Promise<void> {
  const title = interaction.options.getString('title', true).trim();
  const description = (interaction.options.getString('description') ?? '').trim();
  const exclusive = interaction.options.getBoolean('exclusive') === true;

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    await interaction.editReply({
      embeds: [noticeEmbed('Siia ma postitada ei saa', 'Käivita see tekstikanalis.', COLORS.err)],
    });
    return;
  }

  let message;
  try {
    message = await channel.send({
      embeds: [rolePanelEmbed({ title, description, exclusive, rows: [] })],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('[roles] could not post the panel', err);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Paneeli postitamine ebaõnnestus',
          'Kontrolli, et mul oleks siin kanalis **Send Messages**, **Embed Links** ja **Add Reactions** õigused.',
          COLORS.err,
        ),
      ],
    });
    return;
  }

  createPanel(ctx.db, {
    messageId: message.id,
    guildId: interaction.guildId!,
    channelId: channel.id,
    title,
    description,
    exclusive,
    createdBy: interaction.user.id,
  });

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        'Paneel loodud',
        `Lisa nüüd rollid: **/roles add role:@Roll emoji:⛏️**\n\nSõnumi ID: \`${message.id}\`${exclusive ? '\n\nRežiim: **ainult üks roll korraga**.' : ''}`,
        COLORS.ok,
      ),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* /roles add                                                                  */
/* -------------------------------------------------------------------------- */

async function addSub(interaction: Inter, ctx: BotContext): Promise<void> {
  const panel = targetPanel(interaction, ctx);
  if (!panel) {
    await interaction.editReply({ embeds: [NO_PANEL] });
    return;
  }

  const role = interaction.options.getRole('role', true) as Role;
  const emoji = parseEmojiInput(interaction.options.getString('emoji', true));
  if (!emoji) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'See ei ole emoji',
          'Sisesta täpselt üks emoji — kas tavaline (⛏️) või selle serveri oma (`<:nimi:123…>`). Muust serverist pärit emojiga ma reageerida ei saa.',
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  const me = interaction.guild!.members.me!;
  const actor = interaction.member as GuildMember;
  const verdict = canOfferRole(role, me, actor);
  if (!verdict.ok) {
    await interaction.editReply({
      embeds: [noticeEmbed('Seda rolli ma jagada ei saa', guardMessage(role, verdict), COLORS.err)],
    });
    return;
  }

  const result = addBinding(ctx.db, panel.messageId, {
    emojiKey: emoji.key,
    emojiRaw: emoji.raw,
    roleId: role.id,
  });

  if (result === 'role_taken') {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'See roll on juba paneelil',
          `**${safeName(role.name, 60)}** on juba seotud teise emojiga. Eemalda see esmalt: **/roles remove**.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }
  if (result === 'full') {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Paneel on täis',
          `Ühele paneelile mahub ${MAX_BINDINGS} rolli. Loo teine paneel: **/roles panel**.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  // React BEFORE reporting success: if this fails, the binding exists but
  // nobody can use it, and saying "done" would be a lie.
  let reacted = true;
  try {
    const channel = await interaction.client.channels.fetch(panel.channelId);
    const message = await (channel as TextChannel).messages.fetch(panel.messageId);
    await message.react(emoji.raw);
  } catch (err) {
    console.error('[roles] could not add the reaction', err);
    reacted = false;
  }
  await repaint(interaction, ctx, panel);

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        reacted ? 'Roll lisatud' : 'Roll lisatud, aga reageerida ei saanud',
        reacted
          ? `${emoji.raw} → **${safeName(role.name, 60)}**${result === 'replaced' ? '\n\nSee emoji oli varem seotud teise rolliga; asendasin selle.' : ''}`
          : `${emoji.raw} → **${safeName(role.name, 60)}**\n\nSeos on salvestatud, aga ma ei saanud paneelile reaktsiooni lisada. Kontrolli **Add Reactions** õigust ja seda, et emoji oleks sellest serverist. Lisa reaktsioon käsitsi või käivita käsk uuesti.`,
        reacted ? COLORS.ok : COLORS.warn,
      ),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* /roles remove | list | delete                                               */
/* -------------------------------------------------------------------------- */

async function removeSub(interaction: Inter, ctx: BotContext): Promise<void> {
  const panel = targetPanel(interaction, ctx);
  if (!panel) {
    await interaction.editReply({ embeds: [NO_PANEL] });
    return;
  }
  const role = interaction.options.getRole('role', true) as Role;
  const removed = removeBindingByRole(ctx.db, panel.messageId, role.id);
  if (!removed) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'Seda rolli paneelil polnud',
          `**${safeName(role.name, 60)}** ei ole selle paneeliga seotud.`,
          COLORS.warn,
        ),
      ],
    });
    return;
  }

  // The binding is gone, so the reaction is now a dead button. Clear it.
  try {
    const channel = await interaction.client.channels.fetch(panel.channelId);
    const message = await (channel as TextChannel).messages.fetch(panel.messageId);
    // Matched on the NORMALISED key, not indexed by it. reactions.cache is
    // keyed by `emoji.id ?? emoji.name`, and the name still carries the
    // variation selector Discord's picker inserts -- so the cache key for the
    // pickaxe is '\u26cf\ufe0f' while emoji_key stores the stripped '\u26cf'.
    // A .get() therefore missed every VS16 emoji and left the dead reaction on
    // the panel forever. Custom emoji were fine, since their key IS the id.
    const stale = message.reactions.cache.find(
      (r) => emojiKey({ id: r.emoji.id, name: r.emoji.name }) === removed.emojiKey,
    );
    await stale?.remove();
  } catch (err) {
    console.error('[roles] could not clear the reaction', err);
  }
  await repaint(interaction, ctx, panel);

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        'Roll eemaldatud',
        `${removed.emojiRaw} → **${safeName(role.name, 60)}** ei ole enam seotud.\n\nJuba jagatud rolle ma liikmetelt ära ei võta.`,
        COLORS.ok,
      ),
    ],
  });
}

async function listSub(interaction: Inter, ctx: BotContext): Promise<void> {
  const panels = listPanels(ctx.db, interaction.guildId!);
  if (panels.length === 0) {
    await interaction.editReply({
      embeds: [
        noticeEmbed('Rollipaneele pole', 'Loo esimene: **/roles panel**.', COLORS.warn),
      ],
    });
    return;
  }

  const lines = panels.map((p) => {
    const rows = listBindings(ctx.db, p.messageId);
    const link = `https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId}`;
    const pairs = rows.map((r) => `${r.emojiRaw} <@&${r.roleId}>`).join(' · ');
    return (
      `**${gameName(p.title, 80)}**${p.exclusive ? ' · *ainult üks*' : ''}\n` +
      `${rows.length} rolli · [ava sõnum](${link}) · \`${p.messageId}\`` +
      (pairs ? `\n${pairs}` : '')
    );
  });

  await interaction.editReply({
    embeds: [noticeEmbed(`Rollipaneelid (${panels.length})`, lines.join('\n\n'), COLORS.brand)],
  });
}

async function deleteSub(interaction: Inter, ctx: BotContext): Promise<void> {
  const panel = targetPanel(interaction, ctx);
  if (!panel) {
    await interaction.editReply({ embeds: [NO_PANEL] });
    return;
  }
  deletePanel(ctx.db, panel.messageId);
  await interaction.editReply({
    embeds: [
      noticeEmbed(
        'Paneel kustutatud',
        `**${gameName(panel.title, 80)}** ei jaga enam rolle.\n\nSõnum ise jäi kanalisse alles — kustuta see soovi korral käsitsi. Juba jagatud rolle ma liikmetelt ära ei võta.`,
        COLORS.ok,
      ),
    ],
  });
}

/* Kept out of the subcommand list on purpose: exclusivity is set at creation
   and changing it later would silently change what an existing panel means for
   people who already picked. Exported so a future /roles edit can use it. */
export { setExclusive };
