/**
 * A paginated, multi-select checklist on one ephemeral message.
 *
 * Two screens use it and they mean different things by "checked":
 *   - the post-sync import checklist (checked = store this game at all),
 *   - /steam change (checked = other people may see this game).
 * The mechanics are identical, so they live here once and the caller supplies
 * the wording.
 *
 * WHY A SELECT MENU PLUS A RENDERED LIST, rather than one or the other:
 * Discord's select menu is the only component that can toggle 25 things in one
 * interaction, but it only shows its selection while the dropdown is open, and
 * only for the current page. So the embed re-renders the boxes as text and the
 * menu is just the input device. Losing either half makes the screen unusable.
 *
 * The select's `values` are the COMPLETE answer for the page it was rendered
 * from -- an empty array means "nothing on this page", not "no change" -- so a
 * page submit replaces exactly that page's slice of the state and nothing else.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { EmbedBuilder, RepliableInteraction } from 'discord.js';
import { checklistEmbed } from './embeds.js';
import { claimSessionId, releaseSession } from './paginate.js';

/** Discord's hard cap on options in one select menu, and so our page size. */
export const CHECKLIST_PAGE = 25;

const COLLECTOR_IDLE_MS = 180_000;
const COLLECTOR_TIME_MS = 14 * 60_000;

export interface ChecklistItem {
  /** Stable key. Appids are numbers everywhere else; they are stringified here. */
  id: string;
  label: string;
  /** Shown in the dropdown row and after the name in the list, e.g. a playtime. */
  note?: string;
}

export interface ChecklistOptions {
  /** Must already be deferred (or replied) -- this drives it with editReply. */
  interaction: RepliableInteraction;
  /** Only this user's clicks are accepted. */
  ownerId: string;
  items: readonly ChecklistItem[];
  /** Ids checked when the screen opens. */
  initial: Iterable<string>;
  title: string;
  intro: string;
  checkedMeans: string;
  uncheckedMeans: string;
  saveLabel?: string;
}

export type ChecklistResult =
  | { saved: true; checked: Set<string> }
  /** Cancelled, timed out, or the collector died with the bot. Change nothing. */
  | { saved: false; checked: null };

const CANCELLED: ChecklistResult = { saved: false, checked: null };

/**
 * Show the checklist and resolve once the user saves, cancels or walks away.
 *
 * Resolves rather than throwing on every non-save outcome, because "the user
 * closed it" and "the timer expired" must both leave the database untouched --
 * and a caller that has to distinguish them would only get that wrong.
 */
export async function runChecklist(opts: ChecklistOptions): Promise<ChecklistResult> {
  const items = opts.items;
  if (items.length === 0) return { saved: true, checked: new Set() };

  const sid = claimSessionId(opts.ownerId);
  const checked = new Set<string>();
  // Intersected with `items`, not copied: an id that is no longer in the
  // library (a refunded game still sitting in the exclusion table) must not
  // survive a save and become permanently unreachable.
  const present = new Set(items.map((i) => i.id));
  for (const id of opts.initial) if (present.has(id)) checked.add(id);

  const pages = Math.max(1, Math.ceil(items.length / CHECKLIST_PAGE));
  let page = 0;

  const pageItems = (): readonly ChecklistItem[] => {
    const offset = page * CHECKLIST_PAGE;
    return items.slice(offset, offset + CHECKLIST_PAGE);
  };

  const embed = (): EmbedBuilder => {
    const rows = pageItems();
    return checklistEmbed({
      title: opts.title,
      intro: opts.intro,
      pageRows: rows.map((it) => ({
        label: it.label,
        checked: checked.has(it.id),
        ...(it.note === undefined ? {} : { note: it.note }),
      })),
      offset: page * CHECKLIST_PAGE,
      page,
      pages,
      checked: checked.size,
      total: items.length,
      checkedMeans: opts.checkedMeans,
      uncheckedMeans: opts.uncheckedMeans,
    });
  };

  const components = (): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] => {
    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
    const current = pageItems();

    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cl:${sid}:sel`)
          .setPlaceholder(
            pages > 1
              ? `Märgi, mida soovid — lk ${page + 1}/${pages}`
              : 'Märgi, mida soovid alles jätta',
          )
          // 0, not 1: unchecking every game on a page is a legitimate answer,
          // and a minimum of 1 would make it impossible to express.
          .setMinValues(0)
          .setMaxValues(current.length)
          .addOptions(
            current.map((it) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(clip(it.label, 100))
                .setValue(it.id)
                .setDefault(checked.has(it.id))
                .setDescription(clip(it.note ?? ' ', 100)),
            ),
          ),
      ),
    );

    if (pages > 1) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`cl:${sid}:prev`)
            .setLabel('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId(`cl:${sid}:noop`)
            .setLabel(`${page + 1} / ${pages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`cl:${sid}:next`)
            .setLabel('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pages - 1),
        ),
      );
    }

    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        // Whole-list, not per-page: the select menu already does a page in one
        // gesture, so page-scoped buttons would add nothing it cannot express.
        new ButtonBuilder()
          .setCustomId(`cl:${sid}:all`)
          .setLabel('Märgi kõik')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`cl:${sid}:none`)
          .setLabel('Eemalda kõik')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`cl:${sid}:save`)
          .setLabel(opts.saveLabel ?? 'Salvesta')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cl:${sid}:cancel`)
          .setLabel('Katkesta')
          .setStyle(ButtonStyle.Danger),
      ),
    );

    return rows;
  };

  const payload = () => ({ embeds: [embed()], components: components() });

  const message = await opts.interaction.editReply(payload());

  return await new Promise<ChecklistResult>((resolve) => {
    let outcome: ChecklistResult = CANCELLED;

    const collector = message.createMessageComponentCollector({
      idle: COLLECTOR_IDLE_MS,
      time: COLLECTOR_TIME_MS,
    });

    collector.on('collect', (i) => {
      void (async () => {
        try {
          // Checked here rather than in a `filter`, for the reason the paginator
          // documents: a rejecting filter never acks, so the clicker sees a
          // red failure instead of an explanation.
          if (i.user.id !== opts.ownerId) {
            await i.reply({
              content: 'See nimekiri pole sinu oma.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const parts = i.customId.split(':');
          if ((parts[1] ?? '') !== sid) return;
          const action = parts[2] ?? '';

          if (i.isStringSelectMenu() && action === 'sel') {
            // The page's slice is replaced wholesale by the submitted values.
            const chosen = new Set(i.values);
            for (const it of pageItems()) {
              if (chosen.has(it.id)) checked.add(it.id);
              else checked.delete(it.id);
            }
            await i.update(payload());
            return;
          }
          if (!i.isButton()) return;

          switch (action) {
            case 'prev':
              page = Math.max(0, page - 1);
              break;
            case 'next':
              page = Math.min(pages - 1, page + 1);
              break;
            case 'all':
              for (const it of items) checked.add(it.id);
              break;
            case 'none':
              checked.clear();
              break;
            // Both of these ack BEFORE stopping. The caller replaces this
            // message with its own result screen via editReply, which does not
            // acknowledge the button -- so without the deferUpdate the person
            // who clicked Save gets a red "interaction failed" next to a
            // screen that did, in fact, work.
            case 'save':
              await i.deferUpdate();
              outcome = { saved: true, checked: new Set(checked) };
              collector.stop('saved');
              return;
            case 'cancel':
              await i.deferUpdate();
              outcome = CANCELLED;
              collector.stop('cancelled');
              return;
            default:
              await i.deferUpdate();
              return;
          }
          await i.update(payload());
        } catch (err) {
          console.error('[checklist] action failed', err);
        }
      })();
    });

    collector.on('end', () => {
      releaseSession(sid);
      // The caller replaces this message with its own result screen, so the
      // components are cleared but the embed is deliberately left in place.
      resolve(outcome);
    });
  });
}

/** Select-menu labels and descriptions have hard caps and reject empty strings. */
function clip(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length === 0) return '—';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
