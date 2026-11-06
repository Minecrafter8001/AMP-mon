import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../configStore.js';
import { AmpClient } from '../ampClient.js';
import { buildInstanceEmbed } from '../dashboard.js';
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