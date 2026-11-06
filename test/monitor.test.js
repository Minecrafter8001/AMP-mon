import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../configStore.js';
import { defaults } from '../configStore.js';
import { AmpClient, normalizeInstances, normalizeStatus } from '../ampClient.js';

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