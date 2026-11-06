import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../configStore.js';
import { AmpClient } from '../ampClient.js';
import { ampOptions } from '../environment.js';
import { Dashboard } from '../dashboard.js';
import { commandHandler, commands } from '../commands.js';

test('disabling schedule autodetection avoids all schedule and backup API calls', async () => {
  const config = defaults();
  config.settings.scheduleAutoDetect = false;
  const methods = [];
  const settings = ampOptions({ ampUrl: 'https://amp.example/', ampUsername: 'bot' }, config).settings;
  const client = new AmpClient({ url: 'https://amp.example/', username: 'bot', settings,
    fetchImpl: async url => {
      const method = new URL(url).pathname.split('/').at(-1);
      methods.push(method);
      if (method === 'Login') return new Response(JSON.stringify({ sessionID: 'child' }));
      if (method === 'GetStatus') return new Response(JSON.stringify({ State: 20, Metrics: {} }));
      throw new Error(`Unexpected API call: ${method}`);
    }
  });
  client.scheduleCache.set('game', { scheduleData: { PopulatedTriggers: [] }, backupWillStopServer: true });
  const instance = await client.getInstanceStatus({ id: 'game', name: 'game', ampRunning: true, available: true, rawEndpoints: [] });
  assert.deepEqual(methods, ['Login', 'GetStatus']);
  assert.deepEqual(instance.scheduleEvents, []);
  assert.equal(instance.maintenanceState, null);
  client.close();
});

test('schedule override configuration validates type and length', () => {
  const config = defaults();
  config.settings.amp.instanceOverrides.game = { scheduleText: 'Restarts every four hours' };
  assert.equal(validateConfig(config).settings.amp.instanceOverrides.game.scheduleText, 'Restarts every four hours');
  config.settings.amp.instanceOverrides.game.scheduleText = 'x'.repeat(1001);
  assert.throws(() => validateConfig(config), /Invalid override schedule text/);
});

test('custom schedule replaces detected text immediately and clearing restores it', async () => {
  let config = defaults();
  config.settings.amp.instanceOverrides.game = { endpoints: ['game.example:1234'] };
  const store = { snapshot: () => structuredClone(config), update: async mutate => { const next = structuredClone(config); await mutate(next); config = validateConfig(next); } };
  const snapshot = { instances: [{ id: 'game', name: 'game', available: true, scheduleEvents: [{ label: 'Scheduled restart', interval: 'Daily', nextAt: 1793937600000 }] }], polledAt: Date.now() };
  const dashboard = new Dashboard({ client: {}, store, guildId: '123456789012345678' });
  let embed;
  dashboard.publish = async value => { embed = dashboard.render('game', value)[0].toJSON(); };
  const maintenance = () => embed.fields.find(field => field.name === 'Scheduled maintenance')?.value;
  await dashboard.setManualSchedule('game', 'Restarts every four hours', snapshot);
  assert.equal(maintenance(), 'Restarts every four hours');
  assert.deepEqual(config.settings.amp.instanceOverrides.game.endpoints, ['game.example:1234']);
  await dashboard.setManualSchedule('game', null, snapshot);
  assert.match(maintenance(), /Scheduled restart/);
  await store.update(data => { data.settings.scheduleAutoDetect = false; });
  await dashboard.publish(snapshot);
  assert.equal(maintenance(), undefined);
  await dashboard.setManualSchedule('game', 'Weekly maintenance', snapshot);
  assert.equal(maintenance(), 'Weekly maintenance');
});

test('/monitor schedule saves and clears custom schedule text', async () => {
  let config = defaults();
  const store = { snapshot: () => structuredClone(config), update: async mutate => { const next = structuredClone(config); await mutate(next); config = validateConfig(next); } };
  const guildId = '123456789012345678';
  const snapshot = { instances: [{ id: 'game', name: 'game', available: true }], polledAt: Date.now(), discoveryFailed: false };
  const dashboard = new Dashboard({ client: {}, store, guildId });
  dashboard.publish = async () => {};
  const handler = commandHandler({ guildId, monitor: { snapshot }, store, dashboard, log: { warn() {} } });
  async function invoke(text) {
    let reply;
    await handler({ isAutocomplete: () => false, isChatInputCommand: () => true, commandName: 'monitor', guildId,
      memberPermissions: { has: () => true }, options: { getSubcommand: () => 'schedule', getString: name => name === 'instance_name' ? 'game' : text },
      async deferReply() {}, async editReply(value) { reply = value.content; } });
    return reply;
  }
  assert.match(await invoke('Restarts every four hours'), /updated/);
  assert.equal(config.settings.amp.instanceOverrides.game.scheduleText, 'Restarts every four hours');
  assert.match(await invoke('clear'), /cleared/);
  assert.equal(config.settings.amp.instanceOverrides.game, undefined);
  const schedule = commands[0].toJSON().options.find(option => option.name === 'schedule');
  assert.equal(schedule.options[0].autocomplete, true);
});