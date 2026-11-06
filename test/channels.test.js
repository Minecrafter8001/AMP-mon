import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, defaults, validateConfig } from '../configStore.js';
import { Dashboard } from '../dashboard.js';
import { ChannelType } from 'discord.js';
import { commandHandler, commands } from '../commands.js';

const firstChannel = '223456789012345678';
const firstMessage = '323456789012345678';

test('legacy single-channel mappings migrate and persist without losing message IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amp-channels-'));
  const path = join(directory, 'config.json');
  try {
    const config = defaults();
    config.overview = { channelId: firstChannel, messageIds: [firstMessage] };
    config.instances.game = { channelId: firstChannel, messageIds: [firstMessage] };
    await writeFile(path, JSON.stringify(config));
    const store = new ConfigStore(path);
    const migrated = await store.load();
    assert.deepEqual(migrated.overview, [{ channelId: firstChannel, messageIds: [firstMessage] }]);
    assert.deepEqual(migrated.instances.game, [{ channelId: firstChannel, messageIds: [firstMessage] }]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).instances.game, migrated.instances.game);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('duplicate channel bindings are rejected during config validation', () => {
  const config = defaults();
  config.overview = [{ channelId: firstChannel, messageIds: [] }, { channelId: firstChannel, messageIds: [] }];
  assert.throws(() => validateConfig(config), /Invalid overview mapping/);
});

test('multiple channel dashboards are independent and removing one preserves the other', async () => {
  let config = defaults();
  const store = {
    snapshot: () => structuredClone(config),
    update: async mutate => { const next = structuredClone(config); await mutate(next); config = validateConfig(next); }
  };
  const secondChannel = '423456789012345678';
  const guildId = '123456789012345678';
  let nextId = 523456789012345678n;
  const channels = new Map();
  for (const id of [firstChannel, secondChannel]) {
    const messages = new Map();
    channels.set(id, {
      id, guildId, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async messageId => { if (!messages.has(messageId)) throw Object.assign(new Error('missing'), { code: 10008 }); return messages.get(messageId); } },
      async send(body) {
        const message = { id: String(nextId++), author: { id: 'bot' }, body,
          async edit(value) { this.body = value; }, async delete() { messages.delete(this.id); } };
        messages.set(message.id, message);
        return message;
      },
      stored: messages
    });
  }
  const dashboard = new Dashboard({ store, guildId, client: { user: { id: 'bot' }, channels: { fetch: async id => channels.get(id) } }, log: { warn() {} } });
  const snapshot = { instances: [{ id: 'game', name: 'game', available: true }], polledAt: Date.now() };
  await dashboard.bind('game', firstChannel, snapshot);
  await dashboard.bind('game', secondChannel, snapshot);
  await dashboard.bind('game', firstChannel, snapshot);
  assert.equal(config.instances.game.length, 2);
  assert.equal(channels.get(firstChannel).stored.size, 1);
  assert.equal(channels.get(secondChannel).stored.size, 1);
  await dashboard.publish(snapshot);
  assert.deepEqual(await dashboard.removeChannel('game', firstChannel), { removed: true, cleanupFailed: false });
  assert.deepEqual(config.instances.game.map(value => value.channelId), [secondChannel]);
  assert.equal(channels.get(firstChannel).stored.size, 0);
  assert.equal(channels.get(secondChannel).stored.size, 1);
});

test('overview alerts are delivered and tracked separately for every configured channel', async () => {
  let config = defaults();
  const secondChannel = '423456789012345678';
  config.overview = [{ channelId: firstChannel, messageIds: [] }, { channelId: secondChannel, messageIds: [] }];
  const store = { snapshot: () => structuredClone(config), update: async mutate => { const next = structuredClone(config); await mutate(next); config = validateConfig(next); } };
  const guildId = '123456789012345678';
  let nextId = 523456789012345678n;
  const sent = [];
  const client = { user: { id: 'bot' }, channels: { fetch: async id => ({ id, guildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async body => { sent.push({ id, body }); return { id: String(nextId++) }; } }) } };
  const dashboard = new Dashboard({ store, client, guildId, now: () => 1000, log: { warn() {} } });
  await dashboard.alert({ id: 'game', name: 'game' });
  assert.deepEqual(sent.map(value => value.id), [firstChannel, secondChannel]);
  assert.deepEqual(config.pendingAlerts.map(value => value.channelId), [firstChannel, secondChannel]);
});

test('/monitor remove-channel targets the overview or selected instance', async () => {
  const guildId = '123456789012345678';
  const snapshot = { instances: [{ id: 'game-id', name: 'game', available: true }], discoveryFailed: false };
  const calls = [];
  const handler = commandHandler({ guildId, monitor: { snapshot }, store: { snapshot: () => defaults() },
    dashboard: { removeChannel: async (id, channelId) => { calls.push({ id, channelId }); return { removed: true, cleanupFailed: false }; } }, log: { warn() {} } });
  const channel = { id: firstChannel, guildId, type: ChannelType.GuildText };
  async function remove(name) {
    let response;
    await handler({ isAutocomplete: () => false, isChatInputCommand: () => true, commandName: 'monitor', guildId,
      channel, memberPermissions: { has: () => true },
      options: { getSubcommand: () => 'remove-channel', getChannel: () => null, getString: () => name },
      async deferReply() {}, async editReply(value) { response = value; } });
    return response;
  }
  assert.match((await remove(null)).content, /Dashboard removed/);
  assert.match((await remove('game')).content, /Dashboard removed/);
  assert.deepEqual(calls, [{ id: null, channelId: firstChannel }, { id: 'game-id', channelId: firstChannel }]);
  assert.deepEqual(commands.map(command => command.name), ['monitor']);
  snapshot.instances[0].available = false;
  snapshot.discoveryFailed = true;
  assert.match((await remove('game')).content, /Dashboard removed/);
  assert.deepEqual(calls.at(-1), { id: 'game-id', channelId: firstChannel });
  let choices;
  await handler({ isAutocomplete: () => true, commandName: 'monitor', guildId, memberPermissions: { has: () => true },
    options: { getSubcommand: () => 'remove-channel', getFocused: () => ({ name: 'instance_name', value: 'ga' }) },
    async respond(value) { choices = value; } });
  assert.deepEqual(choices, [{ name: 'game', value: 'game' }]);
});