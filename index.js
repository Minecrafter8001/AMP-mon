import { Client, Events, GatewayIntentBits } from 'discord.js';
import { ConfigStore } from './configStore.js';
import { AmpClient, baseUrl } from './ampClient.js';
import { Dashboard } from './dashboard.js';
import { Monitor } from './monitor.js';
import { commandHandler } from './commands.js';
import { environment, ampOptions } from './environment.js';

/** No Message Content/member intents are needed for slash commands and dashboard edits. */
async function main() {
  const env = environment();
  const store = new ConfigStore();
  const config = await store.load();
  const networkUrl = baseUrl(env.ampUrl);
  if (config.guildId && config.guildId !== env.guildId || config.networkUrl && config.networkUrl !== networkUrl) throw new Error('Existing config belongs to a different guild or AMP network; use a separate working directory');
  await store.update(data => { data.guildId = env.guildId; data.networkUrl = networkUrl; });
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const amp = new AmpClient(ampOptions(env, config));
  const dashboard = new Dashboard({ client, store, guildId: env.guildId });
  const monitor = new Monitor({ amp, store, publish: snapshot => dashboard.publish(snapshot), alert: instance => dashboard.alert(instance) });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    console.info('Stopping monitor and flushing configuration.');
    try { await monitor.stop(); await dashboard.stop(); await store.flush(); }
    finally { client.destroy(); }
  }
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  client.on(Events.Error, () => console.warn('Discord client error; check connectivity.'));
  client.on(Events.InteractionCreate, commandHandler({ guildId: env.guildId, monitor, dashboard, store }));
  client.once(Events.ClientReady, () => {
    if (stopping) return;
    console.info('Discord ready; starting AMP network monitoring.');
    void (async () => {
      await dashboard.startCleanup();
      await monitor.start();
    })().catch(async () => {
      console.error('Monitoring startup failed; check configuration and service permissions.');
      process.exitCode = 1;
      await shutdown();
    });
  });
  try { await client.login(env.discordToken); }
  catch { await shutdown(); throw new Error('Discord login failed; check credentials and connectivity'); }
}

main().catch(error => {
  const controlled = /^(Missing |Set AMP_|Invalid DISCORD_|Node.js |Existing config |Discord login failed)/.test(error.message);
  console.error(controlled ? error.message : 'Startup failed; check config.json, AMP URL, settings and service permissions.');
  process.exitCode = 1;
});