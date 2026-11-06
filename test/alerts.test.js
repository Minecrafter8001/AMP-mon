import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../configStore.js';
import { Monitor } from '../monitor.js';
import { Dashboard } from '../dashboard.js';
import { commandHandler, commands } from '../commands.js';
import { ChannelType } from 'discord.js';

function memoryStore() {
  let data = defaults();
  return { snapshot: () => structuredClone(data), update: async mutate => { const next = structuredClone(data); await mutate(next); data = next; }, flush: async () => {} };
}

test('scheduled downtime remains recognizable after the next occurrence rolls forward', async () => {
  const store = memoryStore();
  let now = Date.parse('2026-11-06T03:59:00Z');
  const scheduledAt = Date.parse('2026-11-06T04:00:00Z');
  let running = true;
  const notifications = [];
  const amp = {
    getNetworkInstances: async () => [{ id: 'game', name: 'game', available: true, ampRunning: running }],
    getInstanceStatus: async instance => ({ ...instance, stale: false, appState: running ? 'running' : 'stopped', scheduleEvents: [{ state: 'scheduled-restart', nextAt: now < scheduledAt ? scheduledAt : scheduledAt + 86400000 }] }),
    close() {}
  };
  const monitor = new Monitor({ amp, store, now: () => now, alert: async (instance, scheduled) => notifications.push({ instance, scheduled }), log: { warn() {} } });
  await monitor.poll();
  now += 90000;
  await monitor.poll();
  now += 30000;
  running = false;
  await monitor.poll();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].scheduled.nextAt, scheduledAt);
});

test('outages outside the configured schedule window use ordinary downtime alerts', async () => {
  const store = memoryStore();
  let now = 1000000;
  let running = true;
  const alerts = [];
  const amp = { getNetworkInstances: async () => [{ id: 'game', available: true, ampRunning: running }],
    getInstanceStatus: async instance => ({ ...instance, stale: false, appState: running ? 'running' : 'stopped', scheduleEvents: [{ state: 'scheduled-restart', nextAt: 2000000 }] }), close() {} };
  const monitor = new Monitor({ amp, store, now: () => now, alert: async (instance, scheduled) => alerts.push(scheduled), log: { warn() {} } });
  await monitor.poll();
  running = false;
  now += 30000;
  await monitor.poll();
  assert.deepEqual(alerts, [null]);
});

test('disabled autodetection ignores cached scheduled events for alert classification', async () => {
  const store = memoryStore();
  await store.update(config => { config.settings.scheduleAutoDetect = false; });
  let running = true;
  const alerts = [];
  const amp = { getNetworkInstances: async () => [{ id: 'game', available: true, ampRunning: running }],
    getInstanceStatus: async instance => ({ ...instance, stale: false, appState: running ? 'running' : 'stopped', scheduleEvents: [{ state: 'scheduled-restart', nextAt: 1000000 }] }), close() {} };
  const monitor = new Monitor({ amp, store, now: () => 1000000, alert: async (instance, scheduled) => alerts.push(scheduled), log: { warn() {} } });
  await monitor.poll();
  running = false;
  await monitor.poll();
  assert.deepEqual(alerts, [null]);
});

test('schedule-window matching includes its boundary and excludes later stops', async () => {
  async function classify(stopTime) {
    const store = memoryStore();
    await store.update(config => { config.settings.alerts.scheduleWindowSeconds = 60; });
    let running = true;
    let now = 1000000;
    let result;
    const amp = { getNetworkInstances: async () => [{ id: 'game', available: true, ampRunning: running }],
      getInstanceStatus: async instance => ({ ...instance, stale: false, appState: running ? 'running' : 'stopped', scheduleEvents: [{ state: 'scheduled-restart', nextAt: 1030000 }] }), close() {} };
    const monitor = new Monitor({ amp, store, now: () => now, alert: async (instance, scheduled) => { result = scheduled; }, log: { warn() {} } });
    await monitor.poll();
    running = false;
    now = stopTime;
    await monitor.poll();
    return result;
  }
  assert.equal((await classify(1090000)).nextAt, 1030000);
  assert.equal(await classify(1090001), null);
});

test('per-server routing sends scheduled alerts once per channel and honors hidden overview', async () => {
  const store = memoryStore();
  const guildId = '123456789012345678';
  const sharedChannel = '223456789012345678';
  const serverChannel = '423456789012345678';
  await store.update(config => {
    config.overview = [{ channelId: sharedChannel, messageIds: [] }];
    config.instances.game = [{ channelId: sharedChannel, messageIds: [] }, { channelId: serverChannel, messageIds: [] }];
    config.settings.alerts.instanceRouting.game = { overview: true, instance: true };
  });
  const sent = [];
  let nextId = 523456789012345678n;
  const client = { user: { id: 'bot' }, channels: { fetch: async id => ({ id, guildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async body => { sent.push({ id, body }); return { id: String(nextId++) }; } }) } };
  const dashboard = new Dashboard({ store, client, guildId, now: () => 1000, log: { warn() {} } });
  await dashboard.alert({ id: 'game', name: 'game', friendlyName: 'Game Server' }, { state: 'scheduled-restart' });
  assert.deepEqual(sent.map(entry => entry.id), [sharedChannel, serverChannel]);
  assert.ok(sent.every(entry => entry.body.content === 'Game Server is down for scheduled restart.'));
  assert.equal(store.snapshot().pendingAlerts.length, 2);
  await store.update(config => { config.hiddenInstances = ['game']; config.settings.alerts.instanceRouting.game.instance = false; });
  await dashboard.alert({ id: 'game', name: 'game' });
  assert.equal(sent.length, 2);
  await store.update(config => { config.settings.alerts.instanceRouting.game.instance = true; });
  await dashboard.alert({ id: 'game', name: 'game' }, { state: 'scheduled-backup' });
  assert.deepEqual(sent.slice(2).map(entry => entry.id), [sharedChannel, serverChannel]);
  assert.ok(sent.slice(2).every(entry => entry.body.content === 'game is down for scheduled backup.'));
});

test('/monitor alerts persists both boolean destinations for a selected server', async () => {
  const store = memoryStore();
  const guildId = '123456789012345678';
  const monitor = { snapshot: { instances: [{ id: 'game', name: 'game', available: true }], discoveryFailed: false } };
  const handler = commandHandler({ guildId, monitor, store, dashboard: {}, log: { warn() {} } });
  let reply;
  await handler({ isAutocomplete: () => false, isChatInputCommand: () => true, commandName: 'monitor', guildId,
    memberPermissions: { has: () => true }, options: { getSubcommand: () => 'alerts', getString: () => 'game', getBoolean: name => name === 'instance' },
    async deferReply() {}, async editReply(value) { reply = value; } });
  assert.deepEqual(store.snapshot().settings.alerts.instanceRouting.game, { overview: false, instance: true });
  assert.match(reply.content, /overview off, server channels on/);
  const alerts = commands[0].toJSON().options.find(option => option.name === 'alerts');
  assert.equal(alerts.options[0].autocomplete, true);
  assert.deepEqual(alerts.options.slice(1).map(option => option.name), ['overview', 'instance']);
});