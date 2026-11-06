import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Settings and mutable dashboard state share one local file, never credentials. */
export function defaults() {
  return {
    version: 1,
    guildId: null,
    networkUrl: null,
    overview: null,
    instances: {},
    hiddenInstances: [],
    states: {},
    pendingAlerts: [],
    settings: {
      pollIntervalMs: 30000,
      concurrency: 4,
      requestTimeoutMs: 10000,
      scheduleRefreshMs: 300000,
      scheduleTimeZone: 'UTC',
      alerts: { enabled: true, retentionSeconds: 300, cooldownSeconds: 0, mode: 'either' },
      amp: {
        discoveryMethod: 'ADSModule/GetInstances',
        discoveryParams: {},
        // AMP installations differ: verify this route with inspect-amp before deployment.
        proxyPathTemplate: 'API/ADSModule/Servers/{instanceId}/',
        childSession: 'login',
        useReportedEndpoints: true,
        instanceOverrides: {},
        metricKeys: { cpu: 'CPU Usage', memory: 'Memory Usage', players: 'Active Users' },
        appStateMap: { Running: 'running', Stopped: 'stopped', Starting: 'starting', Stopping: 'stopping', Restarting: 'restarting' }
      }
    }
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);

/** Reject bad files instead of silently replacing the operator's dashboard IDs. */
export function validateConfig(config) {
  if (!object(config) || config.version !== 1) throw new Error('Unsupported config version');
  const base = defaults();
  config.settings = {
    ...base.settings, ...config.settings,
    alerts: { ...base.settings.alerts, ...config.settings?.alerts },
    amp: {
      ...base.settings.amp, ...config.settings?.amp,
      metricKeys: { ...base.settings.amp.metricKeys, ...config.settings?.amp?.metricKeys },
      appStateMap: { ...base.settings.amp.appStateMap, ...config.settings?.amp?.appStateMap }
    }
  };
  if (config.guildId !== null && !snowflake(config.guildId)) throw new Error('Invalid guildId');
  if (config.networkUrl !== null && typeof config.networkUrl !== 'string') throw new Error('Invalid networkUrl');
  if (!object(config.instances) || !object(config.states) || !Array.isArray(config.pendingAlerts)) throw new Error('Invalid dashboard state');
  config.hiddenInstances ??= [];
  if (!Array.isArray(config.hiddenInstances) || !config.hiddenInstances.every(identifier => typeof identifier === 'string' && /^[\w-]+$/.test(identifier))) throw new Error('Invalid hidden instance list');
  const mapping = value => object(value) && snowflake(value.channelId) && Array.isArray(value.messageIds) && value.messageIds.every(snowflake);
  if (config.overview !== null && !mapping(config.overview)) throw new Error('Invalid overview mapping');
  if (!Object.entries(config.instances).every(([key, value]) => /^[\w-]+$/.test(key) && mapping(value))) throw new Error('Invalid instance mapping');
  if (!config.pendingAlerts.every(value => object(value) && snowflake(value.channelId) && snowflake(value.messageId) && Number.isFinite(value.deleteAt))) throw new Error('Invalid pending alerts');
  const settings = config.settings;
  if (!Number.isInteger(settings.pollIntervalMs) || settings.pollIntervalMs < 30000) throw new Error('pollIntervalMs must be at least 30000');
  if (!Number.isInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > 32) throw new Error('concurrency must be 1..32');
  if (!Number.isInteger(settings.requestTimeoutMs) || settings.requestTimeoutMs < 1000 || settings.requestTimeoutMs > 60000) throw new Error('Invalid requestTimeoutMs');
  if (!Number.isInteger(settings.scheduleRefreshMs) || settings.scheduleRefreshMs < 60000 || settings.scheduleRefreshMs > 86400000) throw new Error('Invalid scheduleRefreshMs');
  if (typeof settings.scheduleTimeZone !== 'string' || !settings.scheduleTimeZone) throw new Error('Invalid scheduleTimeZone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: settings.scheduleTimeZone }); }
  catch { throw new Error('Invalid scheduleTimeZone'); }
  const alerts = settings.alerts;
  if (typeof alerts.enabled !== 'boolean' || !['amp', 'application', 'either'].includes(alerts.mode)) throw new Error('Invalid alert policy');
  if (!(alerts.retentionSeconds === null || Number.isInteger(alerts.retentionSeconds) && alerts.retentionSeconds > 0) || !Number.isInteger(alerts.cooldownSeconds) || alerts.cooldownSeconds < 0) throw new Error('Invalid alert durations');
  const amp = settings.amp;
  if (!/^[\w]+\/[\w]+$/.test(amp.discoveryMethod) || !object(amp.discoveryParams) || !object(amp.instanceOverrides) || !object(amp.metricKeys) || !object(amp.appStateMap)) throw new Error('Invalid AMP adapter settings');
  if (!['login', 'root'].includes(amp.childSession) || typeof amp.proxyPathTemplate !== 'string' || !amp.proxyPathTemplate.includes('{instanceId}')) throw new Error('Invalid AMP child routing settings');
  if (typeof amp.useReportedEndpoints !== 'boolean') throw new Error('Invalid useReportedEndpoints setting');
  if (!Object.values(amp.metricKeys).every(value => typeof value === 'string' && value.length > 0) || !Object.values(amp.appStateMap).every(value => ['running', 'stopped', 'starting', 'stopping', 'restarting', 'unknown'].includes(value))) throw new Error('Invalid AMP normalization settings');
  for (const [id, override] of Object.entries(amp.instanceOverrides)) {
    if (!/^[\w-]+$/.test(id) || !object(override)) throw new Error('Invalid AMP instance override');
    if (override.url !== undefined) {
      const url = new URL(override.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid AMP override URL');
    }
    if (override.endpoints !== undefined && (!Array.isArray(override.endpoints) || override.endpoints.length > 10 || !override.endpoints.every(value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\r\n]/.test(value)))) throw new Error('Invalid override endpoints');
    if (override.metricKeys !== undefined && (!object(override.metricKeys) || !Object.values(override.metricKeys).every(value => typeof value === 'string' && value.length > 0))) throw new Error('Invalid override metric keys');
    if (override.appStateMap !== undefined && (!object(override.appStateMap) || !Object.values(override.appStateMap).every(value => ['running', 'stopped', 'starting', 'stopping', 'restarting', 'unknown'].includes(value)))) throw new Error('Invalid override application states');
  }
  return config;
}

/** Single-process serialized transactions. Snapshots cannot mutate in-memory state. */
export class ConfigStore {
  constructor(path = 'config.json') {
    this.path = path;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.data = validateConfig(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = defaults();
      await this.write(this.data);
    }
    return this.snapshot();
  }

  snapshot() {
    if (!this.data) throw new Error('ConfigStore is not loaded');
    return structuredClone(this.data);
  }

  /** Commit only after the filesystem replacement succeeds; failed work cannot poison the queue. */
  update(mutator) {
    const task = this.queue.then(async () => {
      const next = this.snapshot();
      await mutator(next);
      validateConfig(next);
      if (JSON.stringify(next) !== JSON.stringify(this.data)) {
        await this.write(next);
        this.data = next;
      }
      return this.snapshot();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async write(data) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async flush() { await this.queue; }
}