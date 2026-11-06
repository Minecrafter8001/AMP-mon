import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../configStore.js';

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