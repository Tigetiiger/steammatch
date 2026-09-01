/**
 * Which roles may be put on a panel.
 *
 * A reaction role is self-service: anyone who can see the message can take it.
 * So the question is not "may this moderator grant this role" but "is it safe
 * for EVERY member to grant it to themselves", and those are different
 * questions with different answers.
 */

import { PermissionFlagsBits } from 'discord.js';
import type { GuildMember, Role } from 'discord.js';

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: GuardReason; detail?: string };

export type GuardReason =
  | 'everyone'
  | 'managed'
  | 'above_bot'
  | 'above_actor'
  | 'privileged';

/**
 * Permissions that make a role a moderator role. None of these belong on a
 * self-service panel at any tier: the point of a reaction role is that nobody
 * vets who takes it.
 */
const PRIVILEGED = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
] as const;

export function privilegedPermissionNames(role: Role): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
    if ((PRIVILEGED as readonly bigint[]).includes(bit) && role.permissions.has(bit)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * @param role   the role someone wants to make self-assignable
 * @param bot    the bot's own member object in this guild
 * @param actor  the moderator running the command
 */
export function canOfferRole(role: Role, bot: GuildMember, actor: GuildMember): GuardVerdict {
  // @everyone shares the guild's id and is held by definition.
  if (role.id === role.guild.id) return { ok: false, reason: 'everyone' };

  // Bot roles, booster roles and integration roles are owned by Discord; the
  // API refuses to assign them no matter what permissions we hold.
  if (role.managed) return { ok: false, reason: 'managed' };

  const privileged = privilegedPermissionNames(role);
  if (privileged.length > 0) {
    return { ok: false, reason: 'privileged', detail: privileged.join(', ') };
  }

  // Discord's own rule: you may only touch roles below your highest.
  if (role.comparePositionTo(bot.roles.highest) >= 0) {
    return { ok: false, reason: 'above_bot' };
  }

  // The guild owner is above the hierarchy and legitimately outranks everything.
  const actorIsOwner = actor.id === role.guild.ownerId;
  if (!actorIsOwner && role.comparePositionTo(actor.roles.highest) >= 0) {
    // Without this, a moderator with ManageRoles could hand out a role they
    // could not assign by hand -- the panel would be a way to climb the
    // hierarchy rather than a shortcut through it.
    return { ok: false, reason: 'above_actor' };
  }

  return { ok: true };
}
