/**
 * Reaction -> role.
 *
 * This runs with NO interaction to reply to. Nothing here can put a message on
 * screen in response to a failure, so every failure path either fixes itself
 * silently, tells the user by DM, or is logged for the operator -- and the code
 * has to be written knowing nobody is watching.
 *
 * PARTIALS. A reaction on a message the bot has not seen since it started
 * arrives with `message.id` set and essentially nothing else. That is the whole
 * message history of the server, so it is the normal case, not an edge case:
 * every panel stops working after a restart unless the client is constructed
 * with Partials.Message / Reaction / User and the event fetches what it needs.
 * `resolveReaction` is where that happens.
 */

import { PermissionFlagsBits } from 'discord.js';
import type { GuildMember, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import type { Database } from 'better-sqlite3';
import { emojiKey } from './emoji.js';
import { privilegedPermissionNames } from './guard.js';
import { findBinding, removeBindingByRole, siblingRoleIds } from './store.js';

export type ReactionAction = 'add' | 'remove';

export interface RoleChange {
  action: ReactionAction;
  roleId: string;
  userId: string;
  /** Roles dropped because the panel is exclusive. */
  alsoRemoved: string[];
}

/**
 * Decide what a reaction event means, with no Discord calls at all.
 *
 * Split from the side effects so the interesting logic -- keying, exclusivity,
 * "is this even our message" -- is testable without a gateway.
 */
export function planReaction(
  db: Database,
  messageId: string,
  emoji: { id?: string | null; name?: string | null },
  userId: string,
  action: ReactionAction,
): RoleChange | null {
  const key = emojiKey(emoji);
  if (key === null) return null;

  const binding = findBinding(db, messageId, key);
  if (binding === null) return null;

  return {
    action,
    roleId: binding.roleId,
    userId,
    // Only on add. Removing a reaction in an exclusive panel means "I want none
    // of these", not "give me the others".
    alsoRemoved:
      action === 'add' && binding.exclusive ? siblingRoleIds(db, messageId, binding.roleId) : [],
  };
}

/**
 * Fill in a partial reaction far enough to read its message id and emoji.
 *
 * Returns null when the fetch fails, which normally means the message was
 * deleted between the reaction and this handler. That is not an error worth
 * logging every time.
 */
async function resolveReaction(
  reaction: MessageReaction | PartialMessageReaction,
): Promise<MessageReaction | null> {
  if (!reaction.partial) return reaction;
  try {
    return await reaction.fetch();
  } catch {
    return null;
  }
}

export interface HandlerDeps {
  db: Database;
  /** Told about failures the user should know about; best-effort. */
  notify?: (member: GuildMember, text: string) => Promise<void>;
}

/**
 * Apply a reaction event. Safe to call for every reaction in the server: the
 * database probe happens first and bails on anything we do not manage.
 */
export async function applyReaction(
  deps: HandlerDeps,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  action: ReactionAction,
): Promise<RoleChange | null> {
  // Our own reactions are how the panel gets its buttons in the first place.
  if (user.bot) return null;

  const full = await resolveReaction(reaction);
  if (full === null) return null;

  const guild = full.message.guild;
  if (!guild) return null; // DM reaction; there are no roles to grant.

  const plan = planReaction(deps.db, full.message.id, full.emoji, user.id, action);
  if (plan === null) return null;

  let member: GuildMember;
  try {
    member = await guild.members.fetch(user.id);
  } catch {
    return null; // Left the server between reacting and now.
  }

  const role = guild.roles.cache.get(plan.roleId) ?? (await guild.roles.fetch(plan.roleId).catch(() => null));
  if (!role) {
    // The role was deleted but the binding outlived it. The guildRoleDelete
    // listener normally cleans this up; this is the race where it has not yet.
    console.warn(`[roles] binding points at a missing role ${plan.roleId} in ${guild.id}`);
    return null;
  }

  // Re-checked at grant time, not just at bind time: roles get dragged around
  // in the server settings long after a panel is built, and the bot losing its
  // position is the single most common way a working panel stops working.
  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn(`[roles] missing ManageRoles in ${guild.id}`);
    return null;
  }
  if (role.comparePositionTo(me.roles.highest) >= 0) {
    console.warn(`[roles] ${role.id} is at or above my highest role in ${guild.id}`);
    await deps.notify?.(
      member,
      `Ma ei saa rolli **${role.name}** anda, sest see asub serveri sätetes minu enda rollist kõrgemal. Palun anna sellest administraatorile teada.`,
    );
    return null;
  }

  // The same re-check, for the same reason, applied to PERMISSIONS. canOfferRole
  // refuses a moderator role at bind time, but a role's permissions are edited
  // in the server settings long after the panel is built: tick Manage Messages
  // onto a colour role bound months ago and, without this, every member in the
  // guild can hand themselves that permission by clicking a reaction. The
  // position check does not catch it -- a colour role sits below the bot.
  //
  // ONLY on grant. A removal is always safe, and refusing one would strand the
  // role on everyone who already holds it.
  if (plan.action === 'add') {
    const privileged = privilegedPermissionNames(role);
    if (privileged.length > 0) {
      console.warn(
        `[roles] ${role.id} has gained ${privileged.join(', ')} since it was bound in ${guild.id}; refusing and dropping the binding`,
      );
      // Drop the binding too. Leaving it means the panel keeps advertising a
      // button that silently does nothing, and the next permission audit has
      // nothing to find.
      try {
        removeBindingByRole(deps.db, full.message.id, plan.roleId);
      } catch (err) {
        console.error('[roles] could not drop the unsafe binding', err);
      }
      await deps.notify?.(
        member,
        `Rolli **${role.name}** ma enam jagada ei saa: sellele on lisatud moderaatori õigused (${privileged.join(', ')}), mida ei tohi endale ise võtta. Eemaldasin selle paneelilt — anna administraatorile teada.`,
      );
      return null;
    }
  }

  try {
    if (plan.action === 'add') {
      if (plan.alsoRemoved.length > 0) {
        // One API call, not one per role: the member update is atomic and a
        // partial failure cannot leave two exclusive roles held at once.
        const next = new Set(member.roles.cache.keys());
        for (const id of plan.alsoRemoved) next.delete(id);
        next.add(plan.roleId);
        await member.roles.set([...next]);
      } else if (!member.roles.cache.has(plan.roleId)) {
        await member.roles.add(plan.roleId);
      }
    } else if (member.roles.cache.has(plan.roleId)) {
      await member.roles.remove(plan.roleId);
    }
  } catch (err) {
    console.error(`[roles] could not ${plan.action} ${plan.roleId} for ${user.id}`, err);
    return null;
  }

  return plan;
}
