import { writeFile } from 'node:fs/promises';
import { ConfigStore } from './configStore.js';
import { AmpClient } from './ampClient.js';
import { environment, ampOptions } from './environment.js';

/** This read-only utility saves local API evidence, never sessions or credentials. */
async function inspect() {
  const env = environment({ discord: false });
  const store = new ConfigStore();
  const config = await store.load();
  const client = new AmpClient(ampOptions(env, config));
  const report = { inspectedAt: new Date().toISOString(), children: [] };
  try {
    report.apiSpec = await client.request('Core/GetAPISpec');
    report.discovery = await client.request(config.settings.amp.discoveryMethod, config.settings.amp.discoveryParams);
    try { report.instanceStatuses = await client.request('ADSModule/GetInstanceStatuses'); }
    catch (error) { report.instanceStatusesErrorKind = error.kind ?? 'unknown'; }
    const instances = await client.getNetworkInstances();
    for (const instance of instances) {
      if (instance.ampRunning === false) continue;
      try {
        const route = client.childRoute(instance);
        const apiSpec = await client.request('Core/GetAPISpec', {}, route.url, route.sessionUrl);
        const status = await client.request('Core/GetStatus', {}, route.url, route.sessionUrl);
        const readOnly = async method => {
          try { return { value: await client.request(method, {}, route.url, route.sessionUrl) }; }
          catch (error) { return { errorKind: error.kind ?? 'unknown' }; }
        };
        const schedule = config.settings.scheduleAutoDetect ? await readOnly('Core/GetScheduleData') : { disabled: true };
        const backupWillStopServer = config.settings.scheduleAutoDetect ? await readOnly('LocalFileBackupPlugin/BackupWillStopServer') : { disabled: true };
        const backups = config.settings.scheduleAutoDetect ? await readOnly('LocalFileBackupPlugin/GetBackups') : { disabled: true };
        if (schedule.value?.PopulatedTriggers) {
          for (const trigger of schedule.value.PopulatedTriggers) {
            if (trigger.TriggerType !== 'TimeIntervalTrigger') continue;
            try {
              trigger.interval = await client.request('Core/GetTimeIntervalTrigger', { Id: trigger.Id }, route.url, route.sessionUrl);
            } catch (error) {
              trigger.intervalErrorKind = error.kind ?? 'unknown';
            }
          }
        }
        client.scheduleCache.set(instance.id, {
          loadedAt: Date.now(),
          scheduleData: schedule.value ?? null,
          backupWillStopServer: backupWillStopServer.value ?? null
        });
        report.children.push({ instanceId: instance.id, apiSpec, status, schedule, backupWillStopServer, backups, maintenance: client.cachedMaintenance(instance.id) });
      } catch (error) { report.children.push({ instanceId: instance.id, errorKind: error.kind ?? 'unknown' }); }
    }
    const secrets = [env.ampPassword, env.ampToken, ...[...client.sessions.values()].map(session => session.id)].filter(Boolean);
    function sanitize(value) {
      if (Array.isArray(value)) return value.map(sanitize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|sessionid|secret/i.test(key)).map(([key, entry]) => [key, sanitize(entry)]));
      if (typeof value === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
      return value;
    }
    await writeFile('amp-inspection.json', `${JSON.stringify(sanitize(report), null, 2)}\n`, { mode: 0o600 });
    console.info('Saved local amp-inspection.json. It may contain hostnames, endpoints and user data; redact before sharing.');
    console.info(`Discovered ${instances.length} game instances; verified ${report.children.filter(child => child.status).length} child status requests.`);
  } finally { client.close(); }
}

inspect().catch(error => {
  console.error(error.name === 'AmpError' ? `AMP inspection failed (${error.kind}); check API settings and permissions.` : error.message);
  process.exitCode = 1;
});