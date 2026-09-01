/**
 * Generic button paginator.
 *
 * Query state is deliberately NOT serialised into custom_id -- custom_id is
 * capped at 100 characters and a filter + sort + user id + query string does not
 * fit. Instead each paginated reply gets a short session id, the rows live in an
 * in-memory Map, and the custom_id carries only `pg:<sessionId>:<page>`.
 *
 * Sessions are swept on a timer; a lost session (bot restart, expiry) just means
 * the buttons stop working, which the collector's `end` handler also cleans up.
 */

import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { Minutes } from '../types.js';

export const PAGE_SIZE = 10;
/** "No threshold". Not 0 -- every filter is applied with a strict `>`. */
export const NO_FILTER = -1;
/** A little longer than the 14-minute collector so the map never expires first. */
export const SESSION_TTL_MS = 16 * 60_000;
const COLLECTOR_IDLE_MS = 120_000;
const COLLECTOR_TIME_MS = 14 * 60_000;

/**
 * Prototype screen 4's filter row, in order. `All` is -1, not 0: every filter is
 * applied with a strict `>`, so a 0 threshold would silently exclude games with
 * no playtime -- which is exactly what "All" promises to show.
 */
export const FILTERS: ReadonlyArray<{ label: string; min: Minutes }> = [
  { label: '30m+', min: 30 },
  { label: '1h+', min: 60 },
  { label: '5h+', min: 300 },
  { label: '10h+', min: 600 },
  { label: 'All', min: NO_FILTER },
];

/* -------------------------------------------------------------------------- */
/* Session store                                                               */
/* -------------------------------------------------------------------------- */

interface SessionData<T> {
  ownerId: string;
  /** Unfiltered source rows. Filter buttons re-derive `rows` from this. */
  all: T[];
  rows: T[];
  page: number;
  filter: Minutes;
  sort: string;
  expiresAt: number;
}

const sessions = new Map<string, SessionData<never>>();

function put<T>(id: string, s: SessionData<T>): void {
  sessions.set(id, s as unknown as SessionData<never>);
}

export function sessionCount(): number {
  return sessions.size;
}

/** True while some live collector owns this session id. */
export function hasSession(id: string): boolean {
  return sessions.has(id);
}

/**
 * Reserve a session id for an interactive message that is not paginated
 * (/privacy, /games who). Registering it is what stops the global button router
 * from also answering those clicks and double-acking the interaction.
 */
export function claimSessionId(ownerId: string): string {
  const id = randomUUID().slice(0, 8);
  put(id, {
    ownerId,
    all: [],
    rows: [],
    page: 0,
    filter: NO_FILTER,
    sort: '',
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return id;
}

export function releaseSession(id: string): void {
  sessions.delete(id);
}

/** Drop every session whose deadline has passed. Returns how many were removed. */
export function sweepSessions(now: number = Date.now()): number {
  let n = 0;
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) {
      sessions.delete(id);
      n++;
    }
  }
  return n;
}

const sweeper = setInterval(() => sweepSessions(), 60_000);
// Never hold the process open just to sweep an empty map.
if (typeof sweeper.unref === 'function') sweeper.unref();

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

/** What `render` and the extra-button callbacks get to see. */
export interface PagerState<T> {
  readonly id: string;
  readonly ownerId: string;
  /** The unfiltered rows. */
  readonly all: T[];
  /** Rows after the active playtime filter. */
  readonly rows: T[];
  readonly pageRows: T[];
  readonly offset: number;
  readonly page: number;
  readonly pages: number;
  readonly filter: Minutes;
  readonly sort: string;
}

export type ExtraResult = 'rerender' | 'handled';

export interface ExtraActions<T> {
  /** Buttons folded into the nav row when they fit (prototype screen 5). */
  buttons?: (s: PagerState<T>) => ButtonBuilder[];
  /** Always-separate rows (prototype screens 7 and /privacy). */
  rows?: (s: PagerState<T>) => ActionRowBuilder<ButtonBuilder>[];
  /**
   * Handle a `px:<sessionId>:<key>` click. Return `'rerender'` to have the
   * paginator ack with an updated message, or `'handled'` if you already acked
   * the interaction yourself.
   */
  handle: (
    i: ButtonInteraction,
    s: PagerState<T>,
    key: string,
    mutate: (patch: Partial<{ rows: T[]; all: T[]; page: number; filter: Minutes; sort: string }>) => void,
  ) => Promise<ExtraResult>;
}

export interface PaginateOptions<T> {
  interaction: ChatInputCommandInteraction;
  ownerId: string;
  /** The full result set, before the playtime filter. */
  rows: T[];
  filter: Minutes;
  sort?: string;
  pageSize?: number;
  /** Show prototype screen 4's 30m/1h/5h/10h/All row. */
  showFilters?: boolean;
  /** How a filter value narrows `rows`. Defaults to identity. */
  applyFilter?: (all: T[], min: Minutes) => T[];
  render: (s: PagerState<T>) => EmbedBuilder;
  extra?: ExtraActions<T>;
}

/* -------------------------------------------------------------------------- */
/* Component builders                                                          */
/* -------------------------------------------------------------------------- */

export function navRow(id: string, page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`pg:${id}:${Math.max(0, page - 1)}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('◀')
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`pg:${id}:noop`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(`${page + 1}/${pages}`)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`pg:${id}:${Math.min(pages - 1, page + 1)}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('▶')
      .setDisabled(page >= pages - 1),
  );
}

export function filterRow(id: string, active: Minutes): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const f of FILTERS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`pf:${id}:${f.min}`)
        .setStyle(f.min === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel(f.label),
    );
  }
  return row;
}

/* -------------------------------------------------------------------------- */
/* The paginator                                                               */
/* -------------------------------------------------------------------------- */

const MAX_BUTTONS_PER_ROW = 5;

/**
 * Renders `opts.rows` into the already-deferred reply and wires up a button
 * collector. Assumes the interaction has been deferred (or replied) already, so
 * ephemerality has already been decided and cannot change here.
 */
export async function paginate<T>(opts: PaginateOptions<T>): Promise<void> {
  const pageSize = Math.max(1, opts.pageSize ?? PAGE_SIZE);
  const applyFilter = opts.applyFilter ?? ((all: T[]) => all);
  const id = claimSessionId(opts.ownerId);

  const s: SessionData<T> = {
    ownerId: opts.ownerId,
    all: opts.rows,
    rows: applyFilter(opts.rows, opts.filter),
    page: 0,
    filter: opts.filter,
    sort: opts.sort ?? '',
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  put(id, s);

  const state = (): PagerState<T> => {
    const pages = Math.max(1, Math.ceil(s.rows.length / pageSize));
    if (s.page > pages - 1) s.page = pages - 1;
    if (s.page < 0) s.page = 0;
    const offset = s.page * pageSize;
    return {
      id,
      ownerId: s.ownerId,
      all: s.all,
      rows: s.rows,
      pageRows: s.rows.slice(offset, offset + pageSize),
      offset,
      page: s.page,
      pages,
      filter: s.filter,
      sort: s.sort,
    };
  };

  const payload = (): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } => {
    const v = state();
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    const inlineButtons = opts.extra?.buttons?.(v) ?? [];

    if (v.pages > 1) {
      const nav = navRow(id, v.page, v.pages);
      if (inlineButtons.length > 0 && 3 + inlineButtons.length <= MAX_BUTTONS_PER_ROW) {
        nav.addComponents(...inlineButtons);
        components.push(nav);
      } else {
        components.push(nav);
        if (inlineButtons.length > 0) {
          components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...inlineButtons.slice(0, MAX_BUTTONS_PER_ROW),
            ),
          );
        }
      }
    } else if (inlineButtons.length > 0) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...inlineButtons.slice(0, MAX_BUTTONS_PER_ROW),
        ),
      );
    }

    if (opts.showFilters) components.push(filterRow(id, v.filter));
    for (const r of opts.extra?.rows?.(v) ?? []) components.push(r);

    return { embeds: [opts.render(v)], components: components.slice(0, 5) };
  };

  const message = await opts.interaction.editReply(payload());

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    idle: COLLECTOR_IDLE_MS,
    time: COLLECTOR_TIME_MS,
  });

  collector.on('collect', (i) => {
    void (async () => {
      try {
        // Validated here, NOT in a `filter`: a rejecting filter leaves the
        // interaction unacknowledged and Discord shows the clicker a failure.
        if (i.user.id !== s.ownerId) {
          await i.reply({
            content:
              "These buttons aren't for you — run the command yourself to get your own copy.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        s.expiresAt = Date.now() + SESSION_TTL_MS;

        const parts = i.customId.split(':');
        const kind = parts[0] ?? '';
        const sid = parts[1] ?? '';
        const arg = parts.slice(2).join(':');
        if (sid !== id) return;

        if (kind === 'pg') {
          if (arg === 'noop') {
            await i.deferUpdate();
            return;
          }
          const n = Number.parseInt(arg, 10);
          s.page = Number.isFinite(n) ? n : 0;
          await i.update(payload());
          return;
        }

        if (kind === 'pf') {
          const n = Number.parseInt(arg, 10);
          // -1, not 0: filters apply a strict `>`, so 0 would hide unplayed games.
      s.filter = Number.isFinite(n) ? n : NO_FILTER;
          s.rows = applyFilter(s.all, s.filter);
          s.page = 0;
          await i.update(payload());
          return;
        }

        if (kind === 'px' && opts.extra) {
          const result = await opts.extra.handle(i, state(), arg, (patch) => {
            if (patch.all !== undefined) s.all = patch.all;
            if (patch.rows !== undefined) s.rows = patch.rows;
            if (patch.page !== undefined) s.page = patch.page;
            if (patch.filter !== undefined) s.filter = patch.filter;
            if (patch.sort !== undefined) s.sort = patch.sort;
          });
          if (result === 'rerender') await i.update(payload());
          return;
        }

        await i.deferUpdate();
      } catch (err) {
        console.error('[paginate] button handler failed', err);
        if (!i.replied && !i.deferred) {
          await i
            .reply({
              content: 'Something broke handling that button. Try running the command again.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
      }
    })();
  });

  collector.on('end', () => {
    sessions.delete(id);
    opts.interaction.editReply({ components: [] }).catch(() => {});
  });
}
