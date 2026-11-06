import { EventEmitter } from 'node:events';

/** Independent workers preserve result order while limiting concurrent AMP requests. */
export async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

/** Only current, known player counts contribute to the total, never stale cached counts. */
export function playerSummary(instances) {
  let total = 0;
  let known = 0;
  for (const instance of instances) {
    if (instance.available && !instance.stale && instance.players?.current !== null && instance.players?.current !== undefined) {
      total += instance.players.current;
      known++;
    }
  }
  return { total, known, count: instances.length, complete: known === instances.length };
}

/** The event layer is driven by completed polls, not an AMP push connection. */
export class Monitor extends EventEmitter {
  constructor({ amp, store, publish = async () => {}, alert = async () => {}, log = console, now = Date.now }) {
    super();
    Object.assign(this, { amp, store, publish, alert, log, now });
    this.snapshot = null;
    this.history = new Map();
    this.lastAlerts = new Map();
    this.task = null;
    this.timer = null;
    this.stopping = false;
  }

  /** Concurrent slash commands join the active poll rather than starting a second one. */
  poll() {
    if (this.stopping) return Promise.resolve(this.snapshot);
    if (!this.task) this.task = this.collect().finally(() => { this.task = null; });
    return this.task;
  }

  async collect() {
    const config = this.store.snapshot();
    const timestamp = this.now();
    let discovered;
    try { discovered = await this.amp.getNetworkInstances(); }
    catch (error) {
      this.log.warn('AMP discovery unavailable', { kind: error.kind ?? 'unknown' });
      this.snapshot = { instances: (this.snapshot?.instances ?? []).map(value => ({ ...value, available: false, stale: true })), polledAt: timestamp, discoveryFailed: true };
      await this.deliver();
      return this.snapshot;
    }
    const cached = new Map((this.snapshot?.instances ?? []).map(instance => [instance.id, instance]));
    const instances = await mapLimit(discovered, config.settings.concurrency, async instance => {
      try { return await this.amp.getInstanceStatus(instance); }
      catch (error) {
        this.log.warn('AMP instance metrics unavailable', { instanceId: instance.id, kind: error.kind ?? 'unknown' });
        return {
          ...cached.get(instance.id), ...instance, appState: 'unknown', stale: true,
          updatedAt: cached.get(instance.id)?.updatedAt ?? null,
          players: cached.get(instance.id)?.players ?? { current: null, max: null }
        };
      }
    });
    const present = new Set(instances.map(instance => instance.id));
    for (const previous of cached.values()) {
      if (!present.has(previous.id)) instances.push({ ...previous, available: false, stale: true, appState: 'unknown', ampRunning: null });
    }
    const notifications = [];
    for (const instance of instances) {
      if (!instance.available) continue;
      const previous = this.history.get(instance.id);
      const current = { ...previous };
      if (instance.ampRunning !== null && instance.ampRunning !== undefined) current.ampRunning = instance.ampRunning;
      if (!instance.stale && instance.appState !== 'unknown') current.appState = instance.appState;
      const ampStopped = previous?.ampRunning === true && current.ampRunning === false;
      const appStopped = previous?.appState === 'running' && current.appState === 'stopped';
      const policy = config.settings.alerts;
      const transition = policy.mode === 'amp' ? ampStopped : policy.mode === 'application' ? appStopped : ampStopped || appStopped;
      if (transition) {
        this.emit('transition', { instanceId: instance.id, ampStopped, appStopped });
        const lastAlert = this.lastAlerts.get(instance.id) ?? -Infinity;
        if (policy.enabled && timestamp - lastAlert >= policy.cooldownSeconds * 1000) {
          notifications.push(instance);
          this.lastAlerts.set(instance.id, timestamp);
        }
      }
      // Startup history is intentionally empty; persisted old states never trigger alerts.
      this.history.set(instance.id, current);
    }
    this.snapshot = { instances, polledAt: timestamp, discoveryFailed: false };
    await this.store.update(data => {
      data.states = Object.fromEntries([...this.history].map(([id, state]) => [id, state]));
    });
    for (const instance of notifications) {
      try { await this.alert(instance); }
      catch { this.log.warn('Downtime alert could not be published', { instanceId: instance.id }); }
    }
    await this.deliver();
    return this.snapshot;
  }

  async deliver() {
    this.emit('snapshot', structuredClone(this.snapshot));
    try { await this.publish(this.snapshot); }
    catch { this.log.warn('Discord dashboard publication failed'); }
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => {
      void this.poll().catch(() => this.log.warn('Polling cycle failed'));
    }, this.store.snapshot().settings.pollIntervalMs);
    return this.poll();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.amp.close();
    await this.task?.catch(() => {});
    await this.store.flush();
  }
}