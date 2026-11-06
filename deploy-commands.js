import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { environment } from './environment.js';

/** Register only these two named commands, preserving unrelated commands in the app. */
try {
  const env = environment({ amp: false });
  const rest = new REST({ version: '10' }).setToken(env.discordToken);
  const route = Routes.applicationGuildCommands(env.clientId, env.guildId);
  for (const command of commands) await rest.post(route, { body: command.toJSON() });
  console.info('Registered monitor-setup and monitor-add in the configured guild.');
} catch (error) {
  console.error(error.message.startsWith('Missing ') || error.message.startsWith('Invalid ') || error.message.startsWith('Node.js') ? error.message : 'Command registration failed; check Discord credentials and application scope.');
  process.exitCode = 1;
}