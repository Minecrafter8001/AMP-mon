import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../configStore.js';
import { commands, commandHandler } from '../commands.js';

const guildId = '123456789012345678';

test('monitor-add registers name autocomplete', () => {
  const command = commands.find(value => value.name === 'monitor-add').toJSON();
  const name = command.options.find(option => option.name === 'instance_name');
  assert.equal(name.autocomplete, true);
});

test('monitor-add autocomplete responds from root discovery before first metrics poll finishes', async () => {
  const store = { snapshot: () => defaults() };
  const monitor = { snapshot: null, discoveredInstances: [
    { id: 'factorio-id', name: 'casualfactoriomodded01', available: true },
    { id: 'minecraft-id', name: 'Minecraft_01', available: true }
  ] };
  const handler = commandHandler({ guildId, monitor, store, dashboard: {} });
  let response;
  await handler({
    isAutocomplete: () => true,
    commandName: 'monitor-add',
    guildId,
    memberPermissions: { has: () => true },
    options: { getFocused: () => ({ name: 'instance_name', value: 'factorio' }) },
    respond: async choices => { response = choices; }
  });
  assert.deepEqual(response, [{ name: 'casualfactoriomodded01', value: 'casualfactoriomodded01' }]);
});