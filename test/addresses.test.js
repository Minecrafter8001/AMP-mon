import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../configStore.js';
import { AmpClient } from '../ampClient.js';
import { buildInstanceEmbed, Dashboard } from '../dashboard.js';
import { parseManualAddresses, commands, commandHandler } from '../commands.js';
import { ChannelType } from 'discord.js';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const quiet = { warn() {} };
const response = value => new Response(JSON.stringify(value));

function memoryStore() {
  let data = defaults();
  return {
    snapshot: () => structuredClone(data),
    update: async mutate => { const next = structuredClone(data); await mutate(next); validateConfig(next); data = next; },
    get data() { return structuredClone(data); }
  };
}

test('manual address input supports newline lists and clear, rejecting unsafe sizes', () => {
  assert.deepEqual(parseManualAddresses('host.example:34197\nsteam://connect/game.example:27015'), [
    'host.example:34197', 'steam://connect/game.example:27015'
  ]);
  assert.equal(parseManualAddresses('clear'), null);
  assert.throws(() => parseManualAddresses(Array.from({ length: 11 }, (_, index) => `host${index}.example:1234`).join('\n')), /at most 10/);
  assert.throws(() => parseManualAddresses('x'.repeat(181)), /180 characters/);
});

test('manual addresses override AMP reports while the config switch suppresses reports', async () => {
  const config = defaults();
  const makeClient = settings => new AmpClient({ url: 'https://amp.example/', username: 'bot', settings,
    fetchImpl: async url => new URL(url).pathname.endsWith('/Login')
      ? response({ sessionID: 'child' })
      : response({ State: 0, Metrics: {} })
  });
  const instance = { id: 'game', name: 'game', ampRunning: true, available: true, rawEndpoints: ['amp.example:1234'] };
  const manualSettings = {
    ...config.settings.amp,
    instanceOverrides: { game: { endpoints: ['manual.example:1234'] } }
  };
  const manual = await makeClient(manualSettings).getInstanceStatus(instance);
  assert.deepEqual(manual.endpoints, ['manual.example:1234']);

  const suppressed = await makeClient({ ...config.settings.amp, useReportedEndpoints: false }).getInstanceStatus(instance);
  assert.deepEqual(suppressed.endpoints, []);

  const enabled = await makeClient({ ...config.settings.amp, useReportedEndpoints: true }).getInstanceStatus(instance);
  assert.deepEqual(enabled.endpoints, ['amp.example:1234']);
});

test('public per-server embed omits empty addresses and host', () => {
  const base = { id: 'game', name: 'game', friendlyName: 'Game Server', available: true, stale: false, ampRunning: true, appState: 'running', players: { current: 0, max: 10 }, memory: { current: 1, max: 2, unit: 'GB' }, cpu: 4, host: { name: 'Private Node' }, endpoints: [], maintenanceChecked: true };
  const emptyEmbed = buildInstanceEmbed(base, Date.now()).toJSON();
  assert.ok(!emptyEmbed.fields.some(field => field.name === 'Addresses:' || field.name === 'Host'));
  const withAddress = buildInstanceEmbed({ ...base, endpoints: ['game.example:34197'] }, Date.now()).toJSON();
  assert.equal(withAddress.fields.find(field => field.name === 'Addresses:').value, 'game.example:34197');
  assert.ok(!withAddress.fields.some(field => field.name === 'Host'));
});

test('player count hides zero maximum but retains positive maximum', () => {
  const instance = { name: 'game', available: true, stale: false, ampRunning: true, appState: 'running' };
  const playerField = players => buildInstanceEmbed({ ...instance, players }, Date.now()).toJSON().fields.find(field => field.name === 'Players').value;
  assert.equal(playerField({ current: 3, max: 0 }), '3');
  assert.equal(playerField({ current: 0, max: 0 }), '0');
  assert.equal(playerField({ current: 3, max: 10 }), '3 / 10');
  assert.equal(playerField({ current: 3, max: null }), '3');
});

test('manual address updates appear immediately and survive polls until cleared', async () => {
  const store = memoryStore();
  const client = new AmpClient({ url: 'https://amp.example/', username: 'bot', settings: store.snapshot().settings.amp,
    fetchImpl: async url => new URL(url).pathname.endsWith('/Login') ? response({ sessionID: 'child' }) : response({ State: 0, Metrics: {} })
  });
  const instance = { id: 'game', name: 'game', ampRunning: true, available: true, rawEndpoints: [{ Endpoint: 'reported.example:1234' }] };
  const initial = await client.getInstanceStatus(instance);
  const snapshot = { instances: [initial], polledAt: Date.now() };
  const dashboard = new Dashboard({ client: {}, store, guildId, log: quiet });
  let latest;
  dashboard.publish = async value => { latest = dashboard.render('game', value)[0].toJSON(); };
  const address = () => latest.fields.find(field => field.name === 'Addresses:')?.value;
  await dashboard.setManualAddresses('game', ['manual.example:1234'], snapshot);
  assert.equal(address(), 'manual.example:1234');
  const next = await client.getInstanceStatus(instance);
  await dashboard.publish({ ...snapshot, instances: [next] });
  assert.equal(address(), 'manual.example:1234');
  await dashboard.setManualAddresses('game', null, { ...snapshot, instances: [next] });
  assert.equal(address(), 'reported.example:1234');
  await store.update(config => { config.settings.amp.useReportedEndpoints = false; });
  await dashboard.publish({ ...snapshot, instances: [next] });
  assert.equal(address(), undefined);
  await dashboard.setManualAddresses('game', ['manual.example:1234'], snapshot);
  assert.equal(address(), 'manual.example:1234');
  await dashboard.setManualAddresses('game', null, snapshot);
  assert.equal(address(), undefined);
  client.close();
});

test('setting and clearing an address edits the tracked message with the current configuration', async () => {
  const store = memoryStore();
  const messageId = '323456789012345678';
  await store.update(config => { config.instances.game = { channelId, messageIds: [messageId] }; });
  const message = { author: { id: 'bot' }, edits: [], async edit(payload) { this.edits.push(payload); } };
  const channel = {
    id: channelId, guildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async id => { assert.equal(id, messageId); return message; } }
  };
  const dashboard = new Dashboard({ client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, store, guildId, log: quiet });
  const snapshot = { instances: [{ id: 'game', name: 'game', available: true, ampRunning: true, appState: 'running', reportedEndpoints: ['reported.example:1234'] }], polledAt: Date.now() };
  await dashboard.setManualAddresses('game', ['manual.example:1234'], snapshot);
  assert.equal(message.edits[0].embeds[0].toJSON().fields.find(field => field.name === 'Addresses:').value, 'manual.example:1234');
  await dashboard.setManualAddresses('game', null, snapshot);
  assert.equal(message.edits[1].embeds[0].toJSON().fields.find(field => field.name === 'Addresses:').value, 'reported.example:1234');
});

test('/monitor-address saves and clears manual addresses for the selected instance', async () => {
  const store = memoryStore();
  const instance = { id: 'internal-game-id', name: 'game01', friendlyName: 'Game Server', available: true, stale: false };
  const snapshot = { instances: [instance], discoveryFailed: false };
  let published = 0;
  const dashboard = {
    async setManualAddresses(id, addresses) {
      await store.update(config => {
        const overrides = config.settings.amp.instanceOverrides;
        if (addresses === null) delete overrides[id];
        else overrides[id] = { endpoints: addresses };
      });
      published++;
    }
  };
  const handler = commandHandler({ guildId, monitor: { snapshot }, dashboard, store, log: quiet });
  const replies = [];
  async function invoke(addresses) {
    await handler({
      isAutocomplete: () => false, isChatInputCommand: () => true,
      commandName: 'monitor-address', guildId,
      memberPermissions: { has: () => true },
      options: { getString: name => name === 'instance_name' ? 'game01' : addresses },
      async deferReply() {}, async editReply(value) { replies.push(value.content); }
    });
  }
  assert.equal(commands.find(command => command.name === 'monitor-address').toJSON().options[0].autocomplete, true);
  await invoke('public.example:1234\nsteam://connect/backup.example:5678');
  assert.deepEqual(store.data.settings.amp.instanceOverrides['internal-game-id'].endpoints, ['public.example:1234', 'steam://connect/backup.example:5678']);
  await invoke('clear');
  assert.equal(store.data.settings.amp.instanceOverrides['internal-game-id'], undefined);
  assert.equal(published, 2);
  assert.match(replies[0], /Manual addresses updated/);
  assert.match(replies[1], /Manual addresses cleared/);
});