import { Routes } from 'discord.js';

/** Update existing named guild commands and create missing ones without deleting others. */
export async function registerCommands({ rest, clientId, guildId, commands, routes = Routes }) {
  const collectionRoute = routes.applicationGuildCommands(clientId, guildId);
  const registered = await rest.get(collectionRoute);
  if (!Array.isArray(registered)) throw new Error('Discord returned an invalid guild command list');

  const results = [];
  for (const command of commands) {
    const body = command.toJSON();
    const existing = registered.find(value => value.name === body.name && (value.type ?? 1) === (body.type ?? 1));
    if (existing) {
      const route = routes.applicationGuildCommand(clientId, guildId, existing.id);
      results.push(await rest.put(route, { body }));
    } else {
      results.push(await rest.post(collectionRoute, { body }));
    }
  }
  return results;
}