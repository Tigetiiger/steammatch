/**
 * The /games add panel.
 *
 * One ephemeral message with every way to build up a game list:
 *   - sync a Steam library (real playtime),
 *   - claim games other people in this server already added (one click),
 *   - add a game nobody has listed yet,
 *   - quick-add buttons for the usual off-Steam suspects.
 *
 * Everything runs off a single collector on the panel message. Modals are
 * awaited inline with `awaitModalSubmit` rather than routed globally, so all the
 * state stays in this closure and nothing has to be encoded into a custom_id.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import {
  addUserGame,
  guildCatalog,
  listGames,
  removeUserGame,
  upsertManualGame,
  userManualGames,
} from '../db/queries.js';
import { COLORS, addPanelEmbed, gameName, noticeEmbed } from '../ui/embeds.js';
import { runChecklist } from '../ui/checklist.js';
import { claimSessionId, releaseSession } from '../ui/paginate.js';
import { importLibrary } from './steam.js';
import { getLinkInfo, type BotContext } from './index.js';

/**
 * Quick-add buttons. Deliberately a list, not a hardcoded button: adding an
 * entry here is the whole job of supporting another common off-Steam game.
 * Keep it short -- these share one action row with the other controls.
 */
export const QUICK_ADD_GAMES: ReadonlyArray<{ name: string; emoji: string }> = [
  { name: 'Minecraft', emoji: '⛏️' },
];

const PANEL_IDLE_MS = 120_000;
const PANEL_TIME_MS = 14 * 60_000;
/**
 * The select menu's cap, and Discord's: 25 options is all one holds. That is a
 * shortlist of what the server plays most, NOT the catalogue -- the catalogue is
 * reached through "Sirvi kõiki", which paginates and has no such ceiling.
 */
const CATALOG_LIMIT = 25;
/**
 * The browse-everything ceiling. The checklist holds its rows in memory and
 * paginates ten to a page, so this bounds the message count, not the screen.
 */
const BROWSE_LIMIT = 1000;

type Ctx = BotContext;

function counts(ctx: Ctx, userId: string) {
  const all = listGames(ctx.db, userId, -1, 5000, 0);
  const manualCount = all.filter((g) => !g.tracked).length;
  return { steamCount: all.length - manualCount, manualCount };
}

/** Exported so a test can hold the row layout to Discord's five-per-row cap. */
export function panelComponents(sid: string, catalog: { appid: number; name: string; owners: number }[]) {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (catalog.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gp:${sid}:pick`)
          .setPlaceholder('Mängud, mis teistel siin juba on — vali, mida sa mängid')
          .setMinValues(1)
          .setMaxValues(Math.min(catalog.length, CATALOG_LIMIT))
          .addOptions(
            catalog.slice(0, CATALOG_LIMIT).map((c) => ({
              label: gameName(c.name, 100),
              // Estonian uses the adessive for both numbers, so no plural split.
              description: `${c.owners} inimesel on see olemas`,
              value: String(c.appid),
            })),
          ),
      ),
    );
  }

  // TWO rows, not one. The primary actions used to share a row with the
  // quick-add buttons under a .slice(0, 5), so adding a second entry to
  // QUICK_ADD_GAMES would have silently dropped "Eemalda" off the end. Splitting
  // them means the list can grow to five without eating anything.
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`gp:${sid}:steam`)
        .setLabel('Impordi Steami kogu')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`gp:${sid}:browse`)
        .setLabel('Sirvi kõiki mänge')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`gp:${sid}:manual`)
        .setLabel('Lisa muu mäng')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`gp:${sid}:remove`)
        .setLabel('Eemalda')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  if (QUICK_ADD_GAMES.length > 0) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...QUICK_ADD_GAMES.slice(0, 5).map((q, i) =>
          new ButtonBuilder()
            .setCustomId(`gp:${sid}:quick${i}`)
            .setLabel(q.name)
            .setEmoji(q.emoji)
            .setStyle(ButtonStyle.Success),
        ),
      ),
    );
  }
  return rows;
}

export async function openAddPanel(
  interaction: ChatInputCommandInteraction,
  ctx: Ctx,
  targetId: string,
  min: number,
): Promise<void> {
  const guildId = interaction.guildId!;
  const actorId = interaction.user.id;
  const forUserId = targetId === actorId ? null : targetId;
  const sid = claimSessionId(actorId);

  const render = () => {
    const c = counts(ctx, targetId);
    const catalog = guildCatalog(ctx.db, guildId, targetId, CATALOG_LIMIT);
    return {
      embeds: [
        addPanelEmbed({
          forUserId,
          ...c,
          steamLinked: getLinkInfo(ctx.db, targetId) !== null,
          catalogCount: catalog.length,
        }),
      ],
      components: panelComponents(sid, catalog),
    };
  };

  const message = await interaction.editReply(render());

  const collector = message.createMessageComponentCollector({
    idle: PANEL_IDLE_MS,
    time: PANEL_TIME_MS,
  });

  collector.on('collect', async (i) => {
    // Checked here, not in `filter`: a rejected filter leaves the interaction
    // unacknowledged and the clicker sees a failure.
    if (i.user.id !== actorId) {
      await i.reply({ content: 'See paneel pole sinu oma.', flags: MessageFlags.Ephemeral });
      return;
    }
    const action = i.customId.split(':')[2] ?? '';

    try {
      if (i.isStringSelectMenu() && action === 'pick') {
        await handlePick(i, ctx, guildId, targetId, render);
        return;
      }
      if (!i.isButton()) return;

      if (action === 'steam') return handleSteam(i, ctx, targetId, min, render);
      if (action === 'browse') return handleBrowse(i, ctx, guildId, targetId, render);
      if (action === 'manual') return handleManual(i, ctx, targetId, render);
      if (action === 'remove') return handleRemove(i, ctx, targetId, render);

      const quick = action.startsWith('quick') ? QUICK_ADD_GAMES[Number(action.slice(5))] : undefined;
      if (quick) {
        const game = upsertManualGame(ctx.db, quick.name);
        addUserGame(ctx.db, targetId, game.appid);
        await i.update(render());
      }
    } catch (err) {
      console.error('[add-panel] action failed', err);
    }
  });

  collector.on('end', () => {
    releaseSession(sid);
    void interaction.editReply({ components: [] }).catch(() => {});
  });
}

async function handlePick(
  i: StringSelectMenuInteraction,
  ctx: Ctx,
  guildId: string,
  targetId: string,
  render: () => { embeds: unknown[]; components: unknown[] },
): Promise<void> {
  // Only what this panel actually offered. Discord validates select values
  // against the options it sent, but the catalogue is re-read here anyway so
  // the guarantee lives in our code rather than in an assumption about theirs.
  const offered = new Set(guildCatalog(ctx.db, guildId, targetId, CATALOG_LIMIT).map((c) => c.appid));
  for (const value of i.values) {
    const appid = Number(value);
    if (Number.isInteger(appid) && offered.has(appid)) addUserGame(ctx.db, targetId, appid);
  }
  await i.update(render() as never);
}

async function handleSteam(
  i: ButtonInteraction,
  ctx: Ctx,
  targetId: string,
  min: number,
  render: () => { embeds: unknown[]; components: unknown[] },
): Promise<void> {
  const modalId = `gpm:${i.id}`;
  await i.showModal(
    new ModalBuilder()
      .setCustomId(modalId)
      .setTitle('Impordi Steami kogu')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('id_or_url')
            .setLabel('Steami profiili aadress, nimi või ID64')
            .setPlaceholder('steamcommunity.com/id/sinunimi')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200),
        ),
      ),
  );

  const submit = await i
    .awaitModalSubmit({ time: 5 * 60_000, filter: (m) => m.customId === modalId })
    .catch(() => null);
  if (!submit) return; // they closed it

  await submit.deferReply({ flags: MessageFlags.Ephemeral });
  await importLibrary(submit, ctx, submit.fields.getTextInputValue('id_or_url').trim(), min, targetId);
  await i.editReply(render() as never).catch(() => {});
}

/**
 * "Sirvi kõiki mänge" -- the whole guild catalogue, not the select menu's 25.
 *
 * The select menu can hold 25 options and the catalogue is already an order of
 * magnitude past that, so everything below the top 25 was unreachable: not hard
 * to find, but absent. This runs the SAME checklist the import screen and
 * /steam change use, over the catalogue instead of a Steam library. Selection
 * survives paging and everything is written in one go at the end.
 *
 * It gets its OWN deferred reply rather than taking over the panel's message:
 * the panel has to stay where it is, because this is one action among several
 * and the person is expected to come back to it.
 */
async function handleBrowse(
  i: ButtonInteraction,
  ctx: Ctx,
  guildId: string,
  targetId: string,
  render: () => { embeds: unknown[]; components: unknown[] },
): Promise<void> {
  const catalog = guildCatalog(ctx.db, guildId, targetId, BROWSE_LIMIT);
  if (catalog.length === 0) {
    await i.reply({
      embeds: [
        noticeEmbed(
          'Siin pole veel midagi sirvida',
          'Sul on juba kõik mängud, mida teised siin on lisanud. Kui keegi impordib oma Steami kogu, tekib siia valikut.',
          COLORS.warn,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const review = await runChecklist({
    interaction: i,
    ownerId: i.user.id,
    items: catalog.map((c) => ({
      id: String(c.appid),
      label: c.name,
      note: `${c.owners} inimesel`,
    })),
    // Nothing pre-ticked: by construction these are games the person does NOT
    // have, so a ticked box always means "add this", never "keep this".
    initial: [],
    title: 'Kõik selle serveri mängud',
    intro: `Siin on **${catalog.length}** mängu, mis teistel siin juba on ja sul veel mitte. Märgi need, mida sa mängid — märgitud mängud lisatakse su nimekirja.`,
    checkedMeans: 'lisatakse',
    uncheckedMeans: 'ei lisata',
    saveLabel: 'Lisa märgitud',
  });

  if (!review.saved) {
    await i.editReply({
      embeds: [
        noticeEmbed('Midagi ei lisatud', 'Sulgesid nimekirja, nii et su mängud jäid samaks.', COLORS.warn),
      ],
      components: [],
    });
    return;
  }

  // Only appids this panel actually offered. review.checked can only hold ids
  // from `items`, but the catalogue is re-read as the authority anyway rather
  // than trusting a round trip through a custom_id.
  const offered = new Map(catalog.map((c) => [String(c.appid), c]));
  let added = 0;
  for (const id of review.checked) {
    const row = offered.get(id);
    if (row && addUserGame(ctx.db, targetId, row.appid)) added++;
  }

  await i.editReply({
    embeds: [
      noticeEmbed(
        added === 0 ? 'Midagi uut ei lisandunud' : `Lisatud: ${added} ${added === 1 ? 'mäng' : 'mängu'}`,
        added === 0
          ? 'Kõik märgitud mängud olid sul juba olemas.'
          : 'Need on nüüd su nimekirjas. Vaata üle: **/games list**',
        added === 0 ? COLORS.warn : COLORS.ok,
      ),
    ],
    components: [],
  });
  await i.message.edit(render() as never).catch(() => {});
}

async function handleManual(
  i: ButtonInteraction,
  ctx: Ctx,
  targetId: string,
  render: () => { embeds: unknown[]; components: unknown[] },
): Promise<void> {
  const modalId = `gpm:${i.id}`;
  await i.showModal(
    new ModalBuilder()
      .setCustomId(modalId)
      .setTitle('Lisa mäng')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Mängu nimi')
            .setPlaceholder('Minecraft')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80),
        ),
      ),
  );

  const submit = await i
    .awaitModalSubmit({ time: 5 * 60_000, filter: (m) => m.customId === modalId })
    .catch(() => null);
  if (!submit) return;

  const raw = submit.fields.getTextInputValue('name').trim();
  if (!raw) {
    await submit.reply({
      embeds: [noticeEmbed('Nimi oli tühi', 'Sisesta mängu nimi ja proovi uuesti.', COLORS.warn)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const game = upsertManualGame(ctx.db, raw);
  const added = addUserGame(ctx.db, targetId, game.appid);
  await submit.reply({
    embeds: [
      noticeEmbed(
        added ? `Lisatud: ${gameName(game.name, 80)}` : `See oli sul juba: ${gameName(game.name, 80)}`,
        game.created
          ? 'Keegi siin polnud seda veel lisanud — nüüd saavad teised selle ühe klikiga valida.'
          : 'Kasutasin kirjet, mis teistel siin juba olemas oli.',
        added ? COLORS.ok : COLORS.warn,
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
  await i.editReply(render() as never).catch(() => {});
}

async function handleRemove(
  i: ButtonInteraction,
  ctx: Ctx,
  targetId: string,
  render: () => { embeds: unknown[]; components: unknown[] },
): Promise<void> {
  const mine = userManualGames(ctx.db, targetId, 25);
  if (mine.length === 0) {
    await i.reply({
      embeds: [
        noticeEmbed(
          'Pole midagi eemaldada',
          'Siit saab eemaldada ainult käsitsi lisatud mänge. Steami mängude jaoks kasuta **/steam unlink**.',
          COLORS.warn,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const pickId = `gpr:${i.id}`;
  await i.reply({
    content: 'Milline peaks kaduma?',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(pickId)
          .setPlaceholder('Vali eemaldatavad mängud')
          .setMinValues(1)
          .setMaxValues(mine.length)
          .addOptions(mine.map((g) => ({ label: gameName(g.name, 100), value: String(g.appid) }))),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });

  const reply = await i.fetchReply();
  const chosen = await reply
    .awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: 2 * 60_000,
      filter: (m) => m.customId === pickId && m.user.id === i.user.id,
    })
    .catch(() => null);
  if (!chosen) return;

  for (const v of chosen.values) removeUserGame(ctx.db, targetId, Number(v));
  await chosen.update({ content: `Eemaldatud: ${chosen.values.length}.`, components: [] });
  await i.editReply(render() as never).catch(() => {});
}
