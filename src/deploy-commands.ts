/**
 * Registers slash commands with Discord.
 *
 * PUT is a FULL REPLACE: whatever is in `commands` becomes the complete command
 * set for that scope, and anything previously registered there disappears.
 *
 * With GUILD_ID set we register guild commands, which propagate instantly — use
 * that during development. Without it we register global commands, which can
 * take up to an hour to roll out.
 */

import { REST, Routes } from 'discord.js';
import { commands } from './commands/registry.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const token = required('DISCORD_TOKEN');
const appId = required('APP_ID');
const guildId = process.env['GUILD_ID'];

const body = commands.map((c) => c.data.toJSON());
const rest = new REST({ version: '10' }).setToken(token);

const route = guildId
  ? Routes.applicationGuildCommands(appId, guildId)
  : Routes.applicationCommands(appId);

try {
  const result = await rest.put(route, { body });
  const count = Array.isArray(result) ? result.length : body.length;
  console.log(
    guildId
      ? `Registered ${count} guild commands in ${guildId} (instant).`
      : `Registered ${count} global commands (may take up to an hour to appear).`,
  );
  for (const c of commands) console.log(`  /${c.data.name}`);
} catch (err) {
  console.error('Command registration failed', err);
  process.exit(1);
}
