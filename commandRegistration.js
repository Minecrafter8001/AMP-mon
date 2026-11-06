import { Routes } from 'discord.js';

/** Clear all guild commands, then register exactly the supplied command set. */
export async function registerCommands({ rest, clientId, guildId, commands, routes = Routes }) {
  const collectionRoute = routes.applicationGuildCommands(clientId, guildId);
  await rest.put(collectionRoute, { body: [] });
  return rest.put(collectionRoute, { body: commands.map(command => command.toJSON()) });
}