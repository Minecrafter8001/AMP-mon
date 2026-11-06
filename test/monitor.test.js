import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, validateConfig } from '../configStore.js';
import { defaults } from '../configStore.js';
import { AmpClient, normalizeInstances, normalizeStatus } from '../ampClient.js';
import { Monitor, mapLimit, playerSummary } from '../monitor.js';
import { Dashboard, buildOverviewEmbeds, buildInstanceEmbed } from '../dashboard.js';
import { ChannelType } from 'discord.js';
import { commands, commandHandler } from '../commands.js';
import { registerCommands } from '../commandRegistration.js';

test('slash command registration and runtime handlers enforce guild administration', async () => {
  assert.equal(commands.length, 4);
  assert.equal(commands[1].toJSON().options[0].name, 'instance_name');
  assert.equal(commands[1].toJSON().options[0].required, true);
  assert.equal(commands[1].toJSON().options[0].autocomplete, true);
  assert.deepEqual(commands.slice(2).map(command => command.name), ['monitor-hide', 'monitor-show']);
  assert.ok(commands.slice(2).every(command => command.toJSON().options[0].autocomplete));
  let bound = false;
  const handler = commandHandler({ guildId, monitor: { snapshot }, dashboard: { bind: async () => { bound = true; } }, log: quiet });
  let response;
  await handler({ isAutocomplete: () => false, isChatInputCommand: () => true, commandName: 'monitor-setup', guildId, memberPermissions: { has: () => false }, reply: async body => { response = body; } });
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
  for (const embed of embeds) {
    assert.ok(embed.length < 6000 && embed.data.description.length <= 4096);
    assert.ok(embed.data.fields.length <= 25 && embed.data.fields.every(field => field.inline === false));
  }
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
      return String(url).endsWith('/Login') ? jsonResponse({ result: { success: true, sessionID: 'session' } }) : jsonResponse([{ FriendlyName: 'Remote', AvailableInstances: [{ InstanceID: 'game-1', InstanceName: 'minecraft-main', FriendlyName: 'Minecraft Community', Running: true, Module: 'Minecraft' }] }]);
    }
  });
  const instances = await client.getNetworkInstances();
  assert.equal(instances[0].host.name, 'Remote');
  assert.equal(instances[0].name, 'minecraft-main');
  assert.equal(instances[0].friendlyName, 'Minecraft Community');
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
  assert.equal(status.appState, 'running');
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

test('per-instance adapters honor MaxValue, custom player metrics and state enums', async () => {
  const settings = defaults().settings.amp;
  settings.instanceOverrides.game = { metricKeys: { players: 'Players' }, appStateMap: { '42': 'running' }, endpoints: ['game.example:25565'] };
  const client = new AmpClient({ url: 'https://amp.example/', username: 'bot', settings,
    fetchImpl: async url => String(url).endsWith('/Login') ? jsonResponse({ sessionID: 'child' }) : jsonResponse({ State: 42, Metrics: { Players: { RawValue: 4, MaxValue: 20 }, 'Memory Usage': { RawValue: 512, MaxValue: 2048, Units: 'MB' } } })
  });
  const status = await client.getInstanceStatus({ id: 'game', available: true, ampRunning: true, rawEndpoints: [] });
  assert.equal(status.appState, 'running');
  assert.deepEqual(status.players, { current: 4, max: 20 });
  assert.equal(status.memory.max, 2048);
  assert.deepEqual(status.endpoints, ['game.example:25565']);
});

test('unmapped game-specific state falls back to ADS Running without guessing enum values', () => {
  const settings = defaults().settings.amp;
  const factorio = normalizeStatus({ id: 'factorio', ampRunning: true, rawAppState: 0 }, { State: 20, Metrics: {} }, settings);
  const beammp = normalizeStatus({ id: 'beammp', ampRunning: true, rawAppState: 0 }, { State: 0, Metrics: {} }, settings);
  const unknown = normalizeStatus({ id: 'unknown', ampRunning: null }, { State: 20, Metrics: {} }, settings);
  assert.equal(factorio.appState, 'running');
  assert.equal(beammp.appState, 'running');
  assert.equal(unknown.appState, 'unknown');
  assert.equal(normalizeStatus({ id: 'stopped', ampRunning: false }, {}, settings).appState, 'stopped');
  settings.appStateMap['20'] = 'starting';
  assert.equal(normalizeStatus({ id: 'factorio', ampRunning: true }, { State: 20, Metrics: {} }, settings).appState, 'starting');
});

test('application-only transitions, configurable cooldown and permanent alerts', async () => {
  const store = memoryStore();
  await store.update(config => { config.settings.alerts.mode = 'application'; config.settings.alerts.cooldownSeconds = 60; config.settings.alerts.retentionSeconds = null; });
  let appState = 'running';
  let now = 1000;
  let alerts = 0;
  const monitor = new Monitor({ store, now: () => now, log: quiet, alert: async () => { alerts++; }, amp: {
    getNetworkInstances: async () => [{ id: 'game', ampRunning: true, available: true }],
    getInstanceStatus: async instance => ({ ...instance, appState, stale: false, players: { current: 0 } }), close() {}
  } });
  await monitor.poll(); appState = 'stopped'; await monitor.poll();
  appState = 'running'; await monitor.poll(); appState = 'stopped'; await monitor.poll();
  assert.equal(alerts, 1);
  now += 61000; appState = 'running'; await monitor.poll(); appState = 'stopped'; await monitor.poll();
  assert.equal(alerts, 2);
  const discord = fakeDiscord();
  const dashboard = new Dashboard({ store, client: discord.client, guildId });
  await dashboard.bind(null, channelId, snapshot);
  await dashboard.alert({ id: 'game', name: 'Game' });
  assert.equal(store.snapshot().pendingAlerts.length, 0);
});

test('overview shrinking removes surplus tracked pages and simultaneous binds remain idempotent', async () => {
  const store = memoryStore();
  const discord = fakeDiscord();
  const dashboard = new Dashboard({ store, client: discord.client, guildId });
  await Promise.all([dashboard.bind(null, channelId, snapshot), dashboard.bind(null, channelId, snapshot)]);
  assert.equal(discord.messages.size, 1);
  const instances = Array.from({ length: 100 }, (_, index) => ({ id: `game-${index}`, name: 'Long name'.repeat(20), available: true, players: { current: 0 } }));
  await dashboard.publish({ ...snapshot, instances });
  assert.ok(discord.messages.size > 1);
  await dashboard.publish(snapshot);
  assert.equal(discord.messages.size, 1);
  assert.equal(store.snapshot().overview.messageIds.length, 1);
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

test('documented configuration example is valid and matches generated defaults', async () => {
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateConfig(example), defaults());
});

test('overview and instance embeds display names but never the internal AMP key', () => {
  const instance = { id: 'secret-internal-guid', name: 'Minecraft_01', friendlyName: 'Minecraft Community', host: { name: 'Node A' }, available: true, stale: false, ampRunning: true, appState: 'running', players: { current: 2, max: 10 }, memory: { current: 4, max: 8, unit: 'GB' }, cpu: 20, endpoints: [], updatedAt: Date.now() };
  const overviewText = buildOverviewEmbeds({ ...snapshot, instances: [instance] }).map(embed => embed.toJSON()).map(embed => `${embed.title}\n${embed.description}\n${embed.fields.map(field => `${field.name} ${field.value}`).join('\n')}\n${embed.footer?.text}`).join('\n');
  const instanceText = JSON.stringify(buildInstanceEmbed(instance, Date.now()).toJSON());
  assert.ok(overviewText.includes('Minecraft Community'));
  assert.ok(instanceText.includes('Minecraft'));
  assert.doesNotMatch(overviewText, /secret-internal-guid|InstanceID/);
  assert.doesNotMatch(instanceText, /secret-internal-guid|InstanceID/);
});

test('public overview avoids AMP, host and polling jargon while reporting availability and players', () => {
  const instances = [
    { id: 'one', name: 'Minecraft_01', friendlyName: 'Minecraft Community', host: { name: 'Private Node A' }, available: true, stale: false, ampRunning: true, appState: 'running', players: { current: 1 } },
    { id: 'two', name: 'Palworld_02', host: { name: 'Private Node B' }, available: true, stale: false, ampRunning: false, appState: 'stopped', players: { current: 0 } },
    { id: 'three', name: 'Valheim_03', host: { name: 'Private Node C' }, available: true, stale: true, ampRunning: true, appState: 'running', players: { current: 4 } }
  ];
  const embed = buildOverviewEmbeds({ ...snapshot, instances })[0].toJSON();
  const visible = `${embed.title}\n${embed.description}\n${embed.fields.map(field => `${field.name} | ${field.value}`).join('\n')}\n${embed.footer?.text ?? ''}`;
  assert.match(visible, /1 of 3 servers online/);
  assert.match(visible, /At least 1 player online/);
  assert.ok(visible.includes('Minecraft Community | Online | 1 player'));
  assert.ok(visible.includes('Palworld\\_02 | Offline | 0 players'));
  assert.ok(visible.includes('Valheim\\_03 | Checking status | Player count updating'));
  assert.doesNotMatch(visible, /AMP|Private Node|polling|partial|InstanceID|stale|one|two|three/);
});

test('monitor-add resolves exact non-friendly instance name and keeps its ID internal', async () => {
  const instance = { id: 'internal-id-123', name: 'Minecraft_01', available: true };
  let boundId;
  const handler = commandHandler({ guildId, monitor: { snapshot: { ...snapshot, instances: [instance] } }, dashboard: { channel: async () => ({}), bind: async id => { boundId = id; } }, log: quiet });
  const replies = [];
  const interaction = {
    isAutocomplete: () => false, isChatInputCommand: () => true, commandName: 'monitor-add', guildId,
    memberPermissions: { has: () => true }, channel: { id: channelId, guildId, type: ChannelType.GuildText },
    options: { getChannel: () => null, getString: name => { assert.equal(name, 'instance_name'); return 'Minecraft_01'; } },
    async deferReply() {}, async editReply(response) { replies.push(response); }
  };
  await handler(interaction);
  assert.equal(boundId, instance.id);
  assert.doesNotMatch(replies[0].content, /internal-id-123|InstanceID/);
});

test('autocomplete filters names and scopes hide/show suggestions to visibility', async () => {
  const store = memoryStore();
  await store.update(config => { config.hiddenInstances = ['game-hidden']; });
  const monitor = { snapshot: { ...snapshot, instances: [
    { id: 'game-visible', name: 'Minecraft_01', available: true },
    { id: 'game-hidden', name: 'Factorio_01', available: true },
    { id: 'game-stopped', name: 'Minecraft_02', available: false }
  ] } };
  const handler = commandHandler({ guildId, monitor, dashboard: {}, store, log: quiet });
  async function complete(commandName, value) {
    let response;
    await handler({ isAutocomplete: () => true, commandName, guildId, memberPermissions: { has: () => true },
      options: { getFocused: () => ({ name: 'instance_name', value }) }, respond: async choices => { response = choices; } });
    return response;
  }
  assert.deepEqual((await complete('monitor-add', 'mine')).map(option => option.value), ['Minecraft_01']);
  assert.deepEqual((await complete('monitor-hide', '')).map(option => option.value), ['Minecraft_01']);
  assert.deepEqual((await complete('monitor-show', 'fact')).map(option => option.value), ['Factorio_01']);
});

test('hide/show commands persist visibility and update overview totals but retain dedicated embeds', async () => {
  const store = memoryStore();
  const discord = fakeDiscord();
  const dashboard = new Dashboard({ store, client: discord.client, guildId, log: quiet });
  const monitor = { snapshot: { ...snapshot, instances: [
    { id: 'visible-game', name: 'Minecraft_01', available: true, stale: false, ampRunning: true, appState: 'running', players: { current: 1 } },
    { id: 'hidden-game', name: 'Factorio_01', available: true, stale: false, ampRunning: true, appState: 'running', players: { current: 4 } }
  ] } };
  await dashboard.bind(null, channelId, monitor.snapshot);
  await dashboard.bind('hidden-game', channelId, monitor.snapshot);
  const handler = commandHandler({ guildId, monitor, dashboard, store, log: quiet });
  async function run(commandName) {
    let reply;
    await handler({ isAutocomplete: () => false, isChatInputCommand: () => true, commandName, guildId, memberPermissions: { has: () => true },
      options: { getString: () => 'Factorio_01' }, async deferReply() {}, async editReply(response) { reply = response; } });
    return reply;
  }
  await run('monitor-hide');
  assert.deepEqual(store.snapshot().hiddenInstances, ['hidden-game']);
  const overviewId = store.snapshot().overview.messageIds[0];
  const dedicatedId = store.snapshot().instances['hidden-game'].messageIds[0];
  const overviewAfterHide = JSON.stringify(discord.messages.get(overviewId).body.embeds[0].data);
  assert.doesNotMatch(overviewAfterHide, /Factorio_01/);
  assert.match(overviewAfterHide, /1 player online/);
  assert.match(discord.messages.get(dedicatedId).body.embeds[0].data.title, /Factorio/);
  await run('monitor-show');
  assert.deepEqual(store.snapshot().hiddenInstances, []);
  const overviewAfterShow = JSON.stringify(discord.messages.get(overviewId).body.embeds[0].data);
  assert.match(overviewAfterShow, /Factorio/);
  assert.match(overviewAfterShow, /5 players online/);
});

test('command deployment clears the guild command set before registering all project commands', async () => {
  const calls = [];
  const routes = {
    applicationGuildCommands: (client, guild) => `collection:${client}:${guild}`,
  };
  const rest = {
    async put(route, options) { calls.push(['put', route, options.body]); }
  };
  await registerCommands({ rest, clientId: 'client', guildId: 'guild', commands, routes });
  assert.deepEqual(calls, [
    ['put', 'collection:client:guild', []],
    ['put', 'collection:client:guild', commands.map(command => command.toJSON())]
  ]);
});