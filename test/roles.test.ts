/**
 * Reaction roles: emoji identity, the storage rules, what a reaction means,
 * and who is allowed to put a role on a panel.
 *
 * The Discord-side effects (fetching partials, calling roles.add) are not
 * exercised here; `planReaction` and `canOfferRole` exist precisely so the
 * decisions can be tested without a gateway.
 */

import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/db/index.js';
import { emojiKey, normalizeUnicode, parseEmojiInput } from '../src/roles/emoji.js';
import { canOfferRole } from '../src/roles/guard.js';
import { planReaction } from '../src/roles/handler.js';
import {
  MAX_BINDINGS,
  addBinding,
  countBindings,
  createPanel,
  deletePanel,
  findBinding,
  forgetRole,
  getPanel,
  listBindings,
  newestPanel,
  removeBindingByRole,
} from '../src/roles/store.js';

const G = 'guild-1';
const MSG = '1000000000000000001';
const MSG2 = '1000000000000000002';
const CH = '2000000000000000001';
const MOD = 'U_mod';

let db: Database.Database;

function panel(messageId = MSG, exclusive = false) {
  createPanel(db, {
    messageId,
    guildId: G,
    channelId: CH,
    title: 'Vali oma rollid',
    description: '',
    exclusive,
    createdBy: MOD,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

/* ------------------------------------------------------------------ *
 * Emoji identity
 * ------------------------------------------------------------------ */

describe('emoji identity', () => {
  it('keys a custom emoji by its id, however it arrived', () => {
    // From the gateway...
    expect(emojiKey({ id: '123456789012345678', name: 'pepe' })).toBe('123456789012345678');
    // ...and from a command option. These MUST agree or the panel does nothing.
    expect(parseEmojiInput('<:pepe:123456789012345678>')?.key).toBe('123456789012345678');
    expect(parseEmojiInput('<a:dance:123456789012345678>')?.key).toBe('123456789012345678');
  });

  it('keeps the animated flag in the raw form, since reacting needs it', () => {
    const still = parseEmojiInput('<:pepe:123456789012345678>')!;
    const moving = parseEmojiInput('<a:dance:123456789012345678>')!;
    expect(still.animated).toBe(false);
    expect(moving.animated).toBe(true);
    expect(moving.raw).toBe('<a:dance:123456789012345678>');
  });

  it('treats an emoji with and without the variation selector as one emoji', () => {
    // U+2764 U+FE0F vs bare U+2764. Discord's picker sends the first, a
    // keyboard often the second, and both must hit the same binding.
    const withVs = '❤️';
    const without = '❤';
    expect(normalizeUnicode(withVs)).toBe(without);
    expect(emojiKey({ id: null, name: withVs })).toBe(emojiKey({ id: null, name: without }));
    expect(parseEmojiInput(withVs)?.key).toBe(parseEmojiInput(without)?.key);
  });

  it('renders the spelling the moderator typed, but keys the normalized one', () => {
    const parsed = parseEmojiInput('❤️')!;
    expect(parsed.raw).toBe('❤️');
    expect(parsed.key).toBe('❤');
  });

  it('keeps multi-codepoint emoji whole', () => {
    for (const e of ['👨‍👩‍👧', '🇪🇪', '👍🏽', '⛏️']) {
      expect(parseEmojiInput(e), e).not.toBeNull();
    }
  });

  it('refuses anything that is not exactly one emoji', () => {
    for (const bad of ['', '   ', 'minecraft', '⛏️⛏️', '⛏️ roll', ':pepe:', '<:pepe:abc>']) {
      expect(parseEmojiInput(bad), bad).toBeNull();
    }
  });

  it('refuses a bare snowflake, which cannot be rendered or reacted with', () => {
    expect(parseEmojiInput('123456789012345678')).toBeNull();
  });

  it('returns null for an emoji the gateway cannot identify', () => {
    // A deleted custom emoji still produces reaction events.
    expect(emojiKey({ id: null, name: null })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

describe('binding storage', () => {
  beforeEach(() => panel());

  it('binds an emoji to a role and reads it back in insertion order', () => {
    expect(addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' })).toBe('added');
    expect(addBinding(db, MSG, { emojiKey: '🚀', emojiRaw: '🚀', roleId: 'R2' })).toBe('added');
    expect(listBindings(db, MSG).map((b) => b.roleId)).toEqual(['R1', 'R2']);
  });

  it('replaces the role when the same emoji is bound again', () => {
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    expect(addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R2' })).toBe('replaced');
    expect(listBindings(db, MSG)).toHaveLength(1);
    expect(listBindings(db, MSG)[0]?.roleId).toBe('R2');
  });

  it('refuses to bind one role to two emoji on the same panel', () => {
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    // Otherwise two reactions would share one role: unreact from either and the
    // role goes, while the other reaction still shows as chosen.
    expect(addBinding(db, MSG, { emojiKey: '🚀', emojiRaw: '🚀', roleId: 'R1' })).toBe('role_taken');
    expect(countBindings(db, MSG)).toBe(1);
  });

  it('allows the same role on a DIFFERENT panel', () => {
    panel(MSG2);
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    expect(addBinding(db, MSG2, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' })).toBe('added');
  });

  it('caps a panel, but still lets an existing emoji be re-pointed', () => {
    for (let i = 0; i < MAX_BINDINGS; i++) {
      expect(addBinding(db, MSG, { emojiKey: `e${i}`, emojiRaw: `e${i}`, roleId: `R${i}` })).toBe('added');
    }
    expect(addBinding(db, MSG, { emojiKey: 'over', emojiRaw: 'over', roleId: 'RX' })).toBe('full');
    // A full panel must still be editable.
    expect(addBinding(db, MSG, { emojiKey: 'e0', emojiRaw: 'e0', roleId: 'RX' })).toBe('replaced');
  });

  it('removes a binding by role and hands back the emoji to un-react with', () => {
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    expect(removeBindingByRole(db, MSG, 'R1')).toEqual({
      emojiKey: '⛏',
      emojiRaw: '⛏️',
      roleId: 'R1',
    });
    expect(removeBindingByRole(db, MSG, 'R1')).toBeNull();
  });

  it('deletes bindings with their panel, via the foreign key', () => {
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    expect(deletePanel(db, MSG)).toBe(true);
    expect(getPanel(db, MSG)).toBeNull();
    expect(countBindings(db, MSG)).toBe(0);
  });

  it('forgets a deleted role across every panel in the guild', () => {
    panel(MSG2);
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    addBinding(db, MSG2, { emojiKey: '🚀', emojiRaw: '🚀', roleId: 'R1' });
    addBinding(db, MSG2, { emojiKey: '🔫', emojiRaw: '🔫', roleId: 'R2' });

    expect(forgetRole(db, G, 'R1')).toBe(2);
    expect(listBindings(db, MSG)).toEqual([]);
    expect(listBindings(db, MSG2).map((b) => b.roleId)).toEqual(['R2']);
  });

  it('newestPanel is the most recently created one', () => {
    // created_at has one-second resolution, so order by insertion is what the
    // DESC index actually gives us here; assert the behaviour, not the clock.
    panel(MSG2);
    expect(newestPanel(db, G)?.messageId).toBe(MSG2);
    expect(newestPanel(db, 'other-guild')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * What a reaction means
 * ------------------------------------------------------------------ */

describe('planReaction', () => {
  it('ignores a reaction on a message we do not manage', () => {
    panel();
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    expect(planReaction(db, '9999999999999999999', { name: '⛏️' }, 'U1', 'add')).toBeNull();
  });

  it('ignores an emoji that is not bound on a panel we do manage', () => {
    panel();
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    expect(planReaction(db, MSG, { name: '🍕' }, 'U1', 'add')).toBeNull();
  });

  it('matches regardless of the variation selector the client sent', () => {
    panel();
    addBinding(db, MSG, { emojiKey: '❤', emojiRaw: '❤️', roleId: 'R1' });
    expect(planReaction(db, MSG, { name: '❤️' }, 'U1', 'add')?.roleId).toBe('R1');
    expect(planReaction(db, MSG, { name: '❤' }, 'U1', 'add')?.roleId).toBe('R1');
  });

  it('grants exactly the one role on a normal panel', () => {
    panel();
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    addBinding(db, MSG, { emojiKey: '🚀', emojiRaw: '🚀', roleId: 'R2' });
    expect(planReaction(db, MSG, { name: '⛏️' }, 'U1', 'add')).toEqual({
      action: 'add',
      roleId: 'R1',
      userId: 'U1',
      alsoRemoved: [],
    });
  });

  it('drops the siblings on an exclusive panel', () => {
    panel(MSG, true);
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    addBinding(db, MSG, { emojiKey: '🚀', emojiRaw: '🚀', roleId: 'R2' });
    addBinding(db, MSG, { emojiKey: '🔫', emojiRaw: '🔫', roleId: 'R3' });

    const plan = planReaction(db, MSG, { name: '⛏️' }, 'U1', 'add')!;
    expect(plan.roleId).toBe('R1');
    expect([...plan.alsoRemoved].sort()).toEqual(['R2', 'R3']);
  });

  it('does not hand out the siblings when a reaction is REMOVED', () => {
    panel(MSG, true);
    addBinding(db, MSG, { emojiKey: '⛏', emojiRaw: '⛏️', roleId: 'R1' });
    addBinding(db, MSG, { emojiKey: '🚀', emojiRaw: '🚀', roleId: 'R2' });
    // Un-reacting means "none of these", not "give me the other ones".
    expect(planReaction(db, MSG, { name: '⛏️' }, 'U1', 'remove')).toEqual({
      action: 'remove',
      roleId: 'R1',
      userId: 'U1',
      alsoRemoved: [],
    });
  });
});

/* ------------------------------------------------------------------ *
 * Who may be offered
 * ------------------------------------------------------------------ */

/** Enough of a Role for the guard. `position` drives comparePositionTo. */
function fakeRole(opts: {
  id: string;
  position: number;
  permissions?: bigint;
  managed?: boolean;
  ownerId?: string;
}) {
  const role = {
    id: opts.id,
    name: `role-${opts.id}`,
    managed: opts.managed ?? false,
    position: opts.position,
    permissions: new PermissionsBitField(opts.permissions ?? 0n),
    guild: { id: G, ownerId: opts.ownerId ?? 'U_owner' },
    comparePositionTo(other: { position: number }) {
      return opts.position - other.position;
    },
  };
  return role as unknown as import('discord.js').Role;
}

function fakeMember(id: string, highestPosition: number) {
  return {
    id,
    roles: { highest: { position: highestPosition } },
  } as unknown as import('discord.js').GuildMember;
}

describe('canOfferRole', () => {
  const bot = fakeMember('U_bot', 50);
  const actor = fakeMember(MOD, 40);

  it('accepts an ordinary cosmetic role below both of them', () => {
    expect(canOfferRole(fakeRole({ id: 'R1', position: 10 }), bot, actor)).toEqual({ ok: true });
  });

  it('refuses @everyone, which shares the guild id', () => {
    const r = canOfferRole(fakeRole({ id: G, position: 0 }), bot, actor);
    expect(r).toMatchObject({ ok: false, reason: 'everyone' });
  });

  it('refuses managed roles, which Discord will not let anyone assign', () => {
    const r = canOfferRole(fakeRole({ id: 'R1', position: 10, managed: true }), bot, actor);
    expect(r).toMatchObject({ ok: false, reason: 'managed' });
  });

  it('refuses a role the bot cannot reach', () => {
    const r = canOfferRole(fakeRole({ id: 'R1', position: 60 }), bot, actor);
    expect(r).toMatchObject({ ok: false, reason: 'above_bot' });
  });

  it('refuses a role at or above the moderator running the command', () => {
    // Otherwise ManageRoles would be a way to climb the hierarchy: build a
    // panel granting a role you could not assign by hand, then click it.
    expect(canOfferRole(fakeRole({ id: 'R1', position: 45 }), bot, actor)).toMatchObject({
      ok: false,
      reason: 'above_actor',
    });
    expect(canOfferRole(fakeRole({ id: 'R1', position: 40 }), bot, actor)).toMatchObject({
      ok: false,
      reason: 'above_actor',
    });
  });

  it('lets the guild owner offer anything the bot can reach', () => {
    const owner = fakeMember('U_owner', 1);
    expect(canOfferRole(fakeRole({ id: 'R1', position: 45 }), bot, owner)).toEqual({ ok: true });
  });

  it('refuses moderator permissions no matter who asks', () => {
    for (const perm of [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.MentionEveryone,
    ]) {
      const role = fakeRole({ id: 'R1', position: 10, permissions: perm });
      const owner = fakeMember('U_owner', 1);
      // Not even the owner: a reaction role is taken by whoever clicks it, and
      // nobody vets that.
      expect(canOfferRole(role, bot, owner), String(perm)).toMatchObject({
        ok: false,
        reason: 'privileged',
      });
    }
  });

  it('names the offending permission, so a misclick is diagnosable', () => {
    const role = fakeRole({ id: 'R1', position: 10, permissions: PermissionFlagsBits.BanMembers });
    const verdict = canOfferRole(role, bot, actor);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.detail).toContain('BanMembers');
  });

  it('allows harmless permissions', () => {
    const role = fakeRole({
      id: 'R1',
      position: 10,
      permissions: PermissionFlagsBits.SendMessages | PermissionFlagsBits.Connect,
    });
    expect(canOfferRole(role, bot, actor)).toEqual({ ok: true });
  });
});
