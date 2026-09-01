/**
 * The command registry.
 *
 * Deliberately separate from ./index.js, which holds the shared helpers every
 * command imports. Building this array inside index.js created a cycle
 * (index -> games -> index): importing any leaf module first hit its
 * module-evaluation body before index.js had finished initialising, and threw
 * a temporal-dead-zone TypeError. `tsc` does not catch that, and it made the
 * command modules impossible to unit test in isolation.
 *
 * Only src/index.ts and src/deploy-commands.ts import this file.
 */

import { Collection } from 'discord.js';
import type { Command } from './index.js';
import steam from './steam.js';
import games from './games.js';
import match from './match.js';
import privacy from './privacy.js';
import roles from './roles.js';

export const commands: Command[] = [steam, games, match, privacy, roles];

export const commandMap = new Collection<string, Command>(
  commands.map((c) => [c.data.name, c] as const),
);
