/**
 * A paginated checklist where every game carries its own toggle button, on its
 * own line. Built with Components V2.
 *
 * Two screens use it and they mean different things by "checked":
 *   - the post-sync import checklist (checked = store this game at all),
 *   - /steam change (checked = other people may see this game).
 * The mechanics are identical, so they live here once and the caller supplies
 * the wording.
 *
 * WHY 10 PER PAGE, when the old select-menu version fitted 25.
 * A Components V2 message allows 40 components counting nested ones, and an
 * inline row costs THREE of them: a Section, the TextDisplay inside it, and the
 * Button accessory. Navigation costs an ActionRow plus its 5 buttons, and the
 * header costs one more:
 *
 *     1 header + 1 container + (10 x 3) + 1 action row + 5 buttons = 38 of 40
 *
 * Eleven rows is the arithmetic ceiling (40 exactly, with no Container and so
 * no accent bar). Twenty is not reachable in this shape at all -- 20 x 3 = 60 --
 * which is why the page size dropped when the checkmark moved onto the line.
 *
 * WHY THIS IS A FOLLOW-UP MESSAGE rather than the deferred reply.
 * IS_COMPONENTS_V2 must be set when a message is CREATED; it cannot be added by
 * editing, and it cannot be removed once set. The callers defer before talking
 * to Steam (they have to -- 3 seconds), and that deferred reply has to stay a
 * normal message: it is where the "private profile" embeds and the final import
 * summary go. So the instructions stay on the parent reply and the interactive
 * list arrives beside it as its own ephemeral follow-up.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import type { Message, RepliableInteraction } from 'discord.js';
import { COLORS, checklistHeaderText, checklistRowText, noticeEmbed } from './embeds.js';
import { claimSessionId, releaseSession } from './paginate.js';

/**
 * Rows per page. Not a style choice -- see the component arithmetic above.
 * Raising it past 11 produces a message Discord rejects outright.
 */
export const CHECKLIST_PAGE = 10;

const COLLECTOR_IDLE_MS = 180_000;
const COLLECTOR_TIME_MS = 14 * 60_000;

export interface ChecklistItem {
  /** Stable key. Appids are numbers everywhere else; they are stringified here. */
  id: string;
  label: string;
  /** Shown after the name on the row, e.g. a playtime. */
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

/** Everything the screen needs to draw itself. Exported so a test can count it. */
export interface ChecklistViewState {
  sid: string;
  items: readonly ChecklistItem[];
  checked: ReadonlySet<string>;
  page: number;
  title: string;
  checkedMeans: string;
  uncheckedMeans: string;
  saveLabel: string;
}

/**
 * The message body: a header, a Container of one Section per game, and one row
 * of navigation.
 *
 * Exported for the component-budget test. Nothing else should call it -- the
 * arithmetic in this file's header comment is only true for what it builds.
 */
export function checklistComponents(v: ChecklistViewState): unknown[] {
  const pages = Math.max(1, Math.ceil(v.items.length / CHECKLIST_PAGE));
  const page = Math.min(Math.max(0, v.page), pages - 1);
  const offset = page * CHECKLIST_PAGE;
  const rows = v.items.slice(offset, offset + CHECKLIST_PAGE);

  const header = new TextDisplayBuilder().setContent(
    `## ${v.title}\n${checklistHeaderText({
      title: v.title,
      intro: '',
      pageRows: [],
      offset,
      page,
      pages,
      checked: v.checked.size,
      total: v.items.length,
      checkedMeans: v.checkedMeans,
      uncheckedMeans: v.uncheckedMeans,
    })}`,
  );

  const container = new ContainerBuilder().setAccentColor(COLORS.brand);
  rows.forEach((it, i) => {
    const on = v.checked.has(it.id);
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            checklistRowText(
              { label: it.label, checked: on, ...(it.note === undefined ? {} : { note: it.note }) },
              offset + i + 1,
            ),
          ),
        )
        // The accessory is what makes the checkmark clickable in place. One
        // button per Section is the API's limit, which is also why a page
        // cannot be toggled in a single interaction the way the select menu
        // did it -- see "Märgi kõik" below, which is the compensation.
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`cl:${v.sid}:t:${it.id}`)
            .setLabel(on ? '☑' : '☐')
            .setStyle(on ? ButtonStyle.Primary : ButtonStyle.Secondary),
        ),
    );
  });

  // Exactly five, which is the row's cap. The page counter that used to have
  // its own button lives in the header text now, and "Märgi kõik"/"Eemalda
  // kõik" are one button whose meaning flips -- there is no sixth slot.
  const allChecked = v.checked.size >= v.items.length;
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cl:${v.sid}:prev`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`cl:${v.sid}:next`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1),
    new ButtonBuilder()
      .setCustomId(`cl:${v.sid}:${allChecked ? 'none' : 'all'}`)
      .setLabel(allChecked ? 'Eemalda kõik' : 'Märgi kõik')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cl:${v.sid}:save`)
      .setLabel(v.saveLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cl:${v.sid}:cancel`)
      .setLabel('Katkesta')
      .setStyle(ButtonStyle.Danger),
  );

  return [header, container, nav];
}

/** Counts a built tree the way Discord does: every nested component included. */
export function countComponents(tree: readonly unknown[]): number {
  const one = (c: unknown): number => {
    const json = (c as { toJSON?: () => unknown }).toJSON?.() ?? c;
    const node = json as { components?: unknown[]; accessory?: unknown };
    let n = 1;
    for (const child of node.components ?? []) n += one(child);
    if (node.accessory) n += one(node.accessory);
    return n;
  };
  return tree.reduce<number>((sum, c) => sum + one(c), 0);
}

/**
 * Show the checklist and resolve once the user saves, cancels or walks away.
 *
 * Never rejects. A user who closes Discord mid-list is a timeout, which is a
 * cancel, which changes nothing.
 */
export async function runChecklist(opts: ChecklistOptions): Promise<ChecklistResult> {
  const items = opts.items;
  if (items.length === 0) return { saved: true, checked: new Set() };

  const sid = claimSessionId(opts.ownerId);
  const checked = new Set<string>();
  // Intersected with `items`, not copied: an id the caller pre-ticks that is no
  // longer in the library (a refunded game still in the stored set) must not
  // survive a save and become permanently unreachable.
  const present = new Set(items.map((i) => i.id));
  for (const id of opts.initial) if (present.has(id)) checked.add(id);

  const pages = Math.max(1, Math.ceil(items.length / CHECKLIST_PAGE));
  let page = 0;

  const pageItems = (): readonly ChecklistItem[] =>
    items.slice(page * CHECKLIST_PAGE, page * CHECKLIST_PAGE + CHECKLIST_PAGE);

  const view = (): ChecklistViewState => ({
    sid,
    items,
    checked,
    page,
    title: opts.title,
    checkedMeans: opts.checkedMeans,
    uncheckedMeans: opts.uncheckedMeans,
    saveLabel: opts.saveLabel ?? 'Salvesta',
  });

  // The instructions stay on the parent reply, which is a normal message and
  // can hold an embed. The list itself cannot share it -- see the file header.
  await opts.interaction.editReply({
    embeds: [noticeEmbed(opts.title, opts.intro, COLORS.brand)],
    components: [],
  });

  const payload = () =>
    ({ components: checklistComponents(view()) }) as unknown as { components: [] };

  const message = (await opts.interaction.followUp({
    ...payload(),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  })) as Message;

  return await new Promise<ChecklistResult>((resolve) => {
    let outcome: ChecklistResult = CANCELLED;
    let closedWith: string | null = null;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      idle: COLLECTOR_IDLE_MS,
      time: COLLECTOR_TIME_MS,
    });

    const finish = (text: string) =>
      ({
        components: [new TextDisplayBuilder().setContent(text)],
      }) as unknown as { components: [] };

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

          // A per-row toggle. The id is everything after the marker, because a
          // manual game's appid is NEGATIVE and splitting on ':' must not lose
          // the sign or the digits after it.
          if (action === 't') {
            const id = parts.slice(3).join(':');
            if (!present.has(id)) {
              await i.deferUpdate();
              return;
            }
            if (checked.has(id)) checked.delete(id);
            else checked.add(id);
            await i.update(payload());
            return;
          }

          switch (action) {
            case 'prev':
              page = Math.max(0, page - 1);
              break;
            case 'next':
              page = Math.min(pages - 1, page + 1);
              break;
            // Whole-list, not this page: the button replaces a select menu that
            // could tick 25 at once, so scoping it to ten would be a downgrade
            // on top of a downgrade.
            case 'all':
              for (const it of items) checked.add(it.id);
              break;
            case 'none':
              checked.clear();
              break;
            case 'save':
              closedWith = 'saved';
              await i.update(finish('Valik salvestatud.'));
              outcome = { saved: true, checked: new Set(checked) };
              collector.stop('saved');
              return;
            case 'cancel':
              closedWith = 'cancelled';
              await i.update(finish('Midagi ei muudetud.'));
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
      // Only for a timeout. Save and cancel already replaced the message from
      // inside the interaction that caused them, and re-editing here would
      // overwrite their wording with an expiry notice.
      if (closedWith === null) {
        void opts.interaction.webhook
          .editMessage(message.id, finish('Nimekiri aegus. Käivita käsk uuesti.'))
          .catch(() => {});
      }
      resolve(outcome);
    });
  });
}
