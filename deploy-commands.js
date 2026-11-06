import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { environment } from './environment.js';
import { registerCommands } from './commandRegistration.js';

/** Upsert this bot's guild commands without replacing unrelated application commands. */
try {
  const env = environment({ amp: false });
  const rest = new REST({ version: '10' }).setToken(env.discordToken);
  await registerCommands({ rest, clientId: env.clientId, guildId: env.guildId, commands, routes: Routes });
  console.info(`Registered or updated ${commands.length} monitor commands in the configured guild.`);
} catch (error) {
  const detail = error.message.startsWith('Missing ') || error.message.startsWith('Invalid ') || error.message.startsWith('Node.js')
    ? error.message
    : error.status
      ? `Discord API returned HTTP ${error.status}${error.code ? ` (code ${error.code})` : ''}: ${error.rawError?.message ?? 'request rejected'}`
      : 'Command registration failed before Discord accepted the request; check credentials and connectivity.';
  console.error(detail);
  process.exitCode = 1;
}