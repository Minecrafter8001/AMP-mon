import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../configStore.js';
import { defaults } from '../configStore.js';
import { AmpClient, normalizeInstances, normalizeStatus } from '../ampClient.js';
import { Monitor, mapLimit, playerSummary } from '../monitor.js';
import { Dashboard, buildOverviewEmbeds, buildInstanceEmbed } from '../dashboard.js';
import { ChannelType } from 'discord.js';
import { commands, commandHandler } from '../commands.js';

test('slash command registration and runtime handlers enforce guild administration', async () => {
  assert.equal(commands.length, 2);
  assert.equal(commands[1].toJSON().options[0].name, 'instance_id');
  assert.equal(commands[1].toJSON().options[0].required, true);
  let bound = false;
  const handler = commandHandler({ guildId, monitor: { snapshot }, dashboard: { bind: async () => { bound = true; } }, log: quiet });
  let response;
  await handler({ isChatInputCommand: () => true, commandName: 'monitor-setup', guildId, memberPermissions: { has: () => false }, reply: async body => { response = body; } });
  assert.equal(bound, false);
  assert.ok(response.content.includes('permission'));
});

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const snapshot = { instances: [], polledAt: Date.now(), discoveryFailed: false };

function fakeDiscord() {
  let nextId = 323456789012345678n;
  const messages = new Map();
  const channel = { id: channelId, guildId, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async id => { if (!messages.has(id)) throw Object.assign(new Error('missing'), { code: 10008 }); return messages.get(id); } },
    send: async body => {
      const message = { id: String(nextId++), author: { id: 'bot' }, body, edits: 0,
        async edit(update) { this.body = update; this.edits++; }, async delete() { messages.delete(this.id); }
      };
      messages.set(message.id, message); return message;
    }
  };
  return { messages, channel, client: { user: { id: 'bot' }, channels: { fetch: async () => channel } } };
}

test('dashboard edits stored messages and replaces only confirmed deleted messages', async () => {
  const store = memoryStore();
  const discord = fakeDiscord();
  const dashboard = new Dashboard({ store, client: discord.client, guildId, log: quiet });
  await dashboard.bind(null, channelId, snapshot);
  const first = store.snapshot().overview.messageIds[0];
  await dashboard.publish(snapshot);
  assert.equal(discord.messages.get(first).edits, 1);
  discord.messages.delete(first);
  await dashboard.publish(snapshot);
  const replacement = store.snapshot().overview.messageIds[0];
  assert.notEqual(first, replacement);
  discord.channel.messages.fetch = async () => { throw Object.assign(new Error('denied'), { code: 50013 }); };
  await dashboard.publish(snapshot);
  assert.equal(discord.messages.size, 1);
  assert.equal(store.snapshot().overview.messageIds[0], replacement);
});

test('large overview pages obey embed limits and alert cleanup survives reconstruction', async () => {
  const instances = Array.from({ length: 150 }, (_, index) => ({ id: `game-${index}`, name: 'Game'.repeat(30), host: { name: 'Remote' }, available: true, stale: false, appState: 'running', players: { current: 1 } }));
  const embeds = buildOverviewEmbeds({ ...snapshot, instances });
  assert.ok(embeds.length > 1);
  for (const embed of embeds) assert.ok(embed.length < 6000 && embed.data.description.length <= 4096);
  assert.doesNotThrow(() => buildInstanceEmbed({ id: 'game', available: false }, Date.now()).toJSON());
  const store = memoryStore();
  const discord = fakeDiscord();
  let now = 1000;
  const options = { store, client: discord.client, guildId, log: quiet, now: () => now };
  const dashboard = new Dashboard(options);
  await dashboard.bind(null, channelId, snapshot);
  await dashboard.alert({ id: 'game', name: '@everyone' });
  assert.equal(store.snapshot().pendingAlerts.length, 1);
  assert.ok(![...discord.messages.values()].at(-1).body.content.includes('@everyone'));
  now += 301000;
  await new Dashboard(options).cleanupAlerts();
  assert.equal(store.snapshot().pendingAlerts.length, 0);
  assert.equal(discord.messages.size, 1);
});

function memoryStore() {
  let data = defaults();
  return { snapshot: () => structuredClone(data), update: async callback => { const next = structuredClone(data); await callback(next); data = next; }, flush: async () => {} };
}
const quiet = { warn() {} };

test('polls do not overlap and alert only confirmed transitions, not outages or startup history', async () => {
  const store = memoryStore();
  await store.update(config => { config.states.game = { ampRunning: true, appState: 'running' }; });
  let running = false;
  let outage = false;
  let discoveries = 0;
  const notifications = [];
  const monitor = new Monitor({ store, log: quiet,
    amp: {
      getNetworkInstances: async () => { discoveries++; if (outage) throw new Error('offline'); return [{ id: 'game', ampRunning: running, available: true }]; },
      getInstanceStatus: async instance => ({ ...instance, appState: running ? 'running' : 'stopped', players: { current: running ? 2 : 0 }, stale: false }), close() {}
    }, alert: async instance => notifications.push(instance.id)
  });
  await Promise.all([monitor.poll(), monitor.poll()]);
  assert.equal(discoveries, 1);
  assert.equal(notifications.length, 0);
  running = true; await monitor.poll();
  outage = true; await monitor.poll();
  assert.equal(playerSummary(monitor.snapshot.instances).complete, false);
  assert.equal(notifications.length, 0);
  outage = false; running = false; await monitor.poll(); await monitor.poll();
  assert.deepEqual(notifications, ['game']);
  running = true; await monitor.poll(); running = false; await monitor.poll();
  assert.equal(notifications.length, 2);
});

test('bounded workers and partial aggregation exclude stale player counts', async () => {
  let active = 0;
  let peak = 0;
  await mapLimit([1, 2, 3, 4, 5], 2, async value => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return value; });
  assert.equal(peak, 2);
  assert.deepEqual(playerSummary([
    { available: true, stale: false, players: { current: 3 } },
    { available: true, stale: true, players: { current: 10 } }
  ]), { total: 3, known: 1, count: 2, complete: false });
});

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('AMP login, nested discovery and SESSIONID use the official request shape', async () => {
  const calls = [];
  const client = new AmpClient({ url: 'https://amp.example/prefix/', username: 'bot', password: 'secret', settings: defaults().settings.amp,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      return String(url).endsWith('/Login') ? jsonResponse({ result: { success: true, sessionID: 'session' } }) : jsonResponse([{ FriendlyName: 'Remote', AvailableInstances: [{ InstanceID: 'game-1', Running: true, Module: 'Minecraft' }] }]);
    }
  });
  const instances = await client.getNetworkInstances();
  assert.equal(instances[0].host.name, 'Remote');
  assert.equal(calls[0].url, 'https://amp.example/prefix/API/Core/Login');
  assert.equal(calls[0].body.username, 'bot');
  assert.equal(calls[1].body.SESSIONID, 'session');
});

test('concurrent session expiry shares reauthentication and permissions do not retry', async () => {
  let logins = 0;
  const client = new AmpClient({ url: 'https://amp.example/', username: 'bot', settings: defaults().settings.amp,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/Login')) return jsonResponse({ sessionID: `s${++logins}` });
      if (String(url).endsWith('/Denied')) return jsonResponse({}, 403);
      return JSON.parse(options.body).SESSIONID === 's1' ? jsonResponse({ Title: 'Unauthorized Access' }) : jsonResponse({ result: [] });
    }
  });
  await client.login();
  await Promise.all([client.request('Core/GetStatus'), client.request('Core/GetStatus')]);
  assert.equal(logins, 2);
  await assert.rejects(client.request('Core/Denied'), { kind: 'permission' });
  assert.equal(logins, 2);
});

test('discovery deduplicates instances and telemetry distinguishes unknown from zero', () => {
  const settings = defaults().settings.amp;
  const [instance] = normalizeInstances([{ InstanceID: 'game', Running: true }, { AvailableInstances: [{ InstanceID: 'game', Running: true }] }]);
  assert.equal(normalizeInstances([{ InstanceID: 'game' }, { InstanceID: 'game' }]).length, 1);
  const status = normalizeStatus(instance, { State: 10, Metrics: { 'CPU Usage': { Percent: 12 }, 'Memory Usage': { RawValue: 1024, Max: 4096, Units: 'MB' }, 'Active Users': { RawValue: 0, Max: 20 } } }, settings);
  assert.equal(status.appState, 'unknown');
  assert.equal(status.players.current, 0);
  assert.equal(status.memory.unit, 'MB');
  assert.equal(normalizeStatus(instance, {}, settings).players.current, null);
  assert.equal(normalizeStatus({ ...instance, ampRunning: false }, {}, settings).players.current, 0);
});

test('child sessions are isolated and transport refuses redirects', async () => {
  const settings = defaults().settings.amp;
  const client = new AmpClient({ url: 'https://amp.example/base/', username: 'bot', settings,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (String(url).endsWith('/Login')) return jsonResponse({ sessionID: String(url).includes('/Servers/game/') ? 'child' : 'root' });
      assert.equal(JSON.parse(options.body).SESSIONID, 'child');
      return jsonResponse({ Metrics: {} });
    }
  });
  await client.login();
  await client.getInstanceStatus({ id: 'game', ampRunning: true, rawEndpoints: [] });
  assert.equal(client.sessions.size, 2);
  assert.throws(() => client.childRoute({ id: '../bad' }));
});

test('JSON transactions preserve concurrent changes and isolate snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amp-mon-'));
  try {
    const store = new ConfigStore(join(directory, 'config.json'));
    await store.load();
    await Promise.all([
      store.update(config => { config.states.first = 'running'; }),
      store.update(config => { config.states.second = 'stopped'; })
    ]);
    const snapshot = store.snapshot();
    snapshot.states.first = 'modified';
    assert.equal(store.snapshot().states.first, 'running');
    assert.equal(JSON.parse(await readFile(store.path, 'utf8')).states.second, 'stopped');
    await assert.rejects(store.update(config => { config.settings.concurrency = 0; }));
    await store.update(config => { config.states.third = 'unknown'; });
    assert.equal(store.snapshot().settings.concurrency, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed existing configuration is not overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amp-mon-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, '{broken');
    await assert.rejects(new ConfigStore(path).load());
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});