import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { environment } from './environment.js';
import { registerCommands } from './commandRegistration.js';

/** Replace all commands for this application in the configured guild. */
try {
  const env = environment({ amp: false });
  const rest = new REST({ version: '10' }).setToken(env.discordToken);
  await registerCommands({ rest, clientId: env.clientId, guildId: env.guildId, commands, routes: Routes });
  console.info(`Cleared existing guild commands and registered ${commands.length} monitor commands.`);
} catch (error) {
  const detail = error.message.startsWith('Missing ') || error.message.startsWith('Invalid ') || error.message.startsWith('Node.js')
    ? error.message
    : error.status
      ? `Discord API returned HTTP ${error.status}${error.code ? ` (code ${error.code})` : ''}: ${error.rawError?.message ?? 'request rejected'}`
      : 'Command registration failed before Discord accepted the request; check credentials and connectivity.';
  console.error(detail);
  process.exitCode = 1;
}