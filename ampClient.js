/** Native AMP transport. All credentials and session tokens stay in memory. */
export class AmpError extends Error {
  constructor(message, kind = 'api') { super(message); this.name = 'AmpError'; this.kind = kind; }
}

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[\w-]+$/.test(value);

/** Keep reverse-proxy prefixes and reject credentials embedded in configured URLs. */
export function baseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AmpError('AMP URL must be an HTTP(S) base URL without credentials or query', 'config');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/** Only the single-property result envelope is unwrapped, matching the official client. */
function unwrap(value) {
  return record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'result') ? value.result : value;
}

/** Flatten ADS target groups, preserving host identity and stable internal keys. */
export function normalizeInstances(response) {
  const instances = new Map();
  function visit(entries, host = { id: 'local', name: 'Local' }) {
    for (const entry of entries) {
      if (!record(entry)) throw new AmpError('Unexpected ADS discovery entry', 'schema');
      if (Array.isArray(entry.AvailableInstances)) {
        visit(entry.AvailableInstances, {
          id: String(entry.InstanceID ?? entry.TargetID ?? entry.Id ?? host.id),
          name: String(entry.FriendlyName ?? entry.DisplayName ?? entry.Name ?? host.name)
        });
        continue;
      }
      if (!identifier(entry.InstanceID)) throw new AmpError('ADS discovery did not provide an InstanceID', 'schema');
      const module = String(entry.Module ?? entry.ModuleName ?? '');
      if (/^ADS(?:Module)?$/i.test(module)) continue;
      instances.set(entry.InstanceID, {
        id: entry.InstanceID,
        // Prefer AMP's raw instance name over display-oriented friendly labels.
        name: String(entry.InstanceName ?? entry.Name ?? entry.FriendlyName ?? entry.DisplayName ?? 'Unnamed instance'),
        module,
        host,
        ampRunning: typeof entry.Running === 'boolean' ? entry.Running : null,
        rawAppState: entry.AppState,
        rawEndpoints: Array.isArray(entry.Endpoints) ? entry.Endpoints : [],
        available: true
      });
    }
  }
  if (Array.isArray(response)) visit(response);
  else if (record(response) && Array.isArray(response.AvailableInstances)) visit(response.AvailableInstances);
  else throw new AmpError('Unsupported ADS discovery shape; inspect AMP and configure the adapter', 'schema');
  return [...instances.values()];
}

/** A configured exact metric key avoids guessing game-specific telemetry or units. */
export function normalizeStatus(instance, status, settings, now = Date.now()) {
  const metrics = record(status?.Metrics) ? status.Metrics : {};
  const cpu = metrics[settings.metricKeys.cpu];
  const memory = metrics[settings.metricKeys.memory];
  const users = metrics[settings.metricKeys.players];
  const rawState = status?.State ?? status?.AppState ?? instance.rawAppState;
  const appState = instance.ampRunning === false ? 'stopped' : settings.appStateMap[String(rawState)] ?? 'unknown';
  const stopped = instance.ampRunning === false || appState === 'stopped';
  return {
    ...instance, appState, stale: false, updatedAt: now,
    cpu: number(cpu?.Percent),
    memory: { current: number(memory?.RawValue ?? memory?.Current), max: number(memory?.MaxValue ?? memory?.Max), unit: typeof memory?.Units === 'string' ? memory.Units : null },
    players: { current: stopped ? 0 : number(users?.RawValue ?? users?.Current), max: number(users?.MaxValue ?? users?.Max) },
    endpoints: (instance.rawEndpoints ?? []).map(endpoint => typeof endpoint === 'string' ? endpoint : String(endpoint?.Endpoint ?? endpoint?.Uri ?? '')).filter(Boolean)
  };
}

export class AmpClient {
  constructor({ url, username, password = '', token = '', settings, timeoutMs = 10000, fetchImpl = fetch }) {
    this.url = baseUrl(url);
    this.credentials = { username, password, token, rememberMe: false };
    this.settings = settings;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.sessions = new Map();
    this.abortController = new AbortController();
  }

  session(url) {
    if (!this.sessions.has(url)) this.sessions.set(url, { id: '', loginPromise: null });
    return this.sessions.get(url);
  }

  /** HTTP redirects are refused: session tokens must never follow an untrusted Location. */
  async post(url, method, parameters, sessionId) {
    if (!/^[\w]+\/[\w]+$/.test(method)) throw new AmpError('Invalid API method', 'config');
    let response;
    try {
      response = await this.fetch(new URL(`API/${method}`, url), {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.cubecoders-ampapi' },
        body: JSON.stringify({ ...parameters, SESSIONID: sessionId }),
        signal: AbortSignal.any([this.abortController.signal, AbortSignal.timeout(this.timeoutMs)])
      });
    } catch {
      throw new AmpError('AMP request failed or timed out', 'transport');
    }
    if (response.status === 401) throw new AmpError('AMP session expired', 'auth');
    if (response.status === 403) throw new AmpError('AMP permission denied', 'permission');
    if (!response.ok) throw new AmpError(`AMP HTTP ${response.status}`, response.status === 429 || response.status >= 500 ? 'transient' : 'http');
    let result;
    try { result = unwrap(await response.json()); }
    catch { throw new AmpError('AMP returned invalid JSON', 'schema'); }
    if (result?.Title === 'Unauthorized Access') throw new AmpError('AMP session expired', 'auth');
    if (result?.Error || result?.Status === false || result?.success === false) throw new AmpError('AMP rejected API operation; check account permissions and API compatibility', 'api');
    return result;
  }

  /** All concurrent callers share one login attempt for each root/child session scope. */
  async login(url = this.url) {
    const session = this.session(url);
    if (!session.loginPromise) {
      session.loginPromise = (async () => {
        const result = await this.post(url, 'Core/Login', this.credentials, '');
        if (typeof result?.sessionID !== 'string' || !result.sessionID) throw new AmpError('AMP login did not return sessionID', 'auth');
        session.id = result.sessionID;
        return session.id;
      })().finally(() => { session.loginPromise = null; });
    }
    return session.loginPromise;
  }

  /** Only read operations are used by this bot; a confirmed expiry permits one replay. */
  async request(method, parameters = {}, url = this.url, sessionUrl = url) {
    const session = this.session(sessionUrl);
    if (!session.id) await this.login(sessionUrl);
    const usedId = session.id;
    try { return await this.readPost(url, method, parameters, usedId); }
    catch (error) {
      if (error.kind !== 'auth') throw error;
      // Another concurrent request may already have refreshed this session.
      if (session.id === usedId) session.id = '';
      if (!session.id) await this.login(sessionUrl);
      return this.readPost(url, method, parameters, session.id);
    }
  }

  /** One bounded retry for server throttling/errors; the next poll handles longer outages. */
  async readPost(url, method, parameters, sessionId) {
    try { return await this.post(url, method, parameters, sessionId); }
    catch (error) {
      if (error.kind !== 'transient') throw error;
      const { setTimeout } = await import('node:timers/promises');
      await setTimeout(500, undefined, { signal: this.abortController.signal });
      return this.post(url, method, parameters, sessionId);
    }
  }

  async getNetworkInstances() {
    return normalizeInstances(await this.request(this.settings.discoveryMethod, this.settings.discoveryParams));
  }

  /** Operator-provided overrides are trusted configuration, never URLs from discovery. */
  childRoute(instance) {
    if (!identifier(instance.id)) throw new AmpError('Invalid instance ID', 'config');
    const override = this.settings.instanceOverrides[instance.id];
    if (override?.url) return { url: baseUrl(override.url), sessionUrl: baseUrl(override.url) };
    const path = this.settings.proxyPathTemplate.replaceAll('{instanceId}', encodeURIComponent(instance.id));
    if (path.startsWith('/') || path.includes('..') || path.includes('\\') || /^[a-z]+:/i.test(path)) throw new AmpError('Proxy route must be relative to the root AMP URL', 'config');
    const url = baseUrl(new URL(path, this.url).href);
    if (new URL(url).origin !== new URL(this.url).origin) throw new AmpError('Proxy route changed origin', 'config');
    return { url, sessionUrl: this.settings.childSession === 'root' ? this.url : url };
  }

  async getInstanceStatus(instance) {
    const override = this.settings.instanceOverrides[instance.id] ?? {};
    const settings = {
      ...this.settings,
      metricKeys: { ...this.settings.metricKeys, ...override.metricKeys },
      appStateMap: { ...this.settings.appStateMap, ...override.appStateMap }
    };
    const input = { ...instance, rawEndpoints: override.endpoints ?? instance.rawEndpoints };
    if (instance.ampRunning === false) return normalizeStatus(input, {}, settings);
    const route = this.childRoute(instance);
    const status = await this.request('Core/GetStatus', {}, route.url, route.sessionUrl);
    if (!record(status) || !record(status.Metrics)) throw new AmpError('Unsupported GetStatus response; inspect AMP metrics', 'schema');
    return normalizeStatus(input, status, settings);
  }

  close() { this.abortController.abort(); }
}