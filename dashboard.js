import { EmbedBuilder, ChannelType, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { playerSummary } from './monitor.js';
import { normalizeEndpoints } from './ampClient.js';

/** AMP-controlled text is display data, never Discord mentions or formatting commands. */
export function safeText(value, limit = 200) {
  return escapeMarkdown(String(value ?? '').replaceAll('@', '[at]').replace(/[\r\n\t]/g, ' ')).slice(0, limit);
}

function endpointText(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return safeText(url.href, 180);
  } catch { return safeText(String(value).split('?')[0].split('#')[0], 180); }
}

function publicStatus(instance) {
  if (!instance.available || instance.stale) return 'Checking status';
  if (instance.ampRunning === false || instance.appState === 'stopped') return 'Offline';
  switch (instance.appState) {
    case 'running': return 'Online';
    case 'starting': return 'Starting';
    case 'stopping': return 'Going offline';
    case 'restarting': return 'Restarting';
    default: return 'Checking status';
  }
}

function publicPlayers(instance) {
  if (!instance.available || instance.stale || instance.players?.current === null || instance.players?.current === undefined) return 'Player count updating';
  const count = instance.players.current;
  return `${count} ${count === 1 ? 'player' : 'players'}`;
}

/** One embed per tracked message keeps both per-embed and total message limits simple. */
export function buildOverviewEmbeds(snapshot, hiddenIds = []) {
  const hidden = new Set(hiddenIds);
  const visibleInstances = snapshot.instances.filter(instance => !hidden.has(instance.id));
  const summary = playerSummary(visibleInstances);
  const onlineCount = visibleInstances.filter(instance => publicStatus(instance) === 'Online').length;
  const unresolved = snapshot.discoveryFailed || visibleInstances.some(instance => publicStatus(instance) === 'Checking status');
  const total = visibleInstances.length;
  const availability = snapshot.discoveryFailed ? 'Server status is updating.' : total === 0 ? 'No servers to show right now.' : `${onlineCount} of ${total} ${total === 1 ? 'server' : 'servers'} online.`;
  const players = summary.complete ? `${summary.total} ${summary.total === 1 ? 'player' : 'players'} online.` : `At least ${summary.total} ${summary.total === 1 ? 'player' : 'players'} online.`;
  const heading = `**${availability}**\n${players}`;
  const fields = [...visibleInstances].sort((first, second) => `${first.friendlyName ?? first.name}/${first.id}`.localeCompare(`${second.friendlyName ?? second.name}/${second.id}`)).map(instance => ({
    name: safeText(instance.friendlyName ?? instance.name ?? 'Unnamed server', 100),
    value: `${publicStatus(instance)} | ${publicPlayers(instance)}`,
    inline: true
  }));
  const pages = [];
  let pageFields = [];
  let pageLength = heading.length;
  for (const field of fields) {
    const fieldLength = field.name.length + field.value.length;
    if (pageFields.length === 25 || pageLength + fieldLength > 5400) {
      pages.push(pageFields);
      pageFields = [];
      pageLength = heading.length;
    }
    pageFields.push(field);
    pageLength += fieldLength;
  }
  if (pageFields.length || pages.length === 0) pages.push(pageFields);
  return pages.map((page, index) => new EmbedBuilder()
    .setTitle('Server Status')
    .setDescription(page.length === 0 && total === 0 && snapshot.instances.length > 0 ? `${heading}\nNo public servers are currently shown.` : heading)
    .addFields(page)
    .setColor(snapshot.discoveryFailed || unresolved ? 0xe1a526 : total === 0 || onlineCount === total ? 0x239b65 : 0xd54a4a)
    .setFooter(pages.length > 1 ? { text: `${index + 1} of ${pages.length}` } : null)
    .setTimestamp(snapshot.polledAt));
}

/** Missing resource readings remain explicit rather than fabricating zero usage. */
export function buildInstanceEmbed(instance, polledAt) {
  const current = instance.available && !instance.stale;
  const memory = instance.memory;
  const ram = current && memory?.current !== null && memory?.current !== undefined && memory.unit
    ? `${memory.current}${memory.max === null ? '' : ` / ${memory.max}`} ${safeText(memory.unit, 30)}` : 'Unavailable';
  const players = current && instance.players?.current !== null && instance.players?.current !== undefined
    ? `${instance.players.current}${instance.players.max > 0 ? ` / ${instance.players.max}` : ''}` : 'Unavailable';
  const addresses = [...new Set((instance.endpoints ?? []).map(endpointText).filter(Boolean))];
  const fields = [
    { name: 'state', value: publicStatus(instance), inline: true },
    { name: 'CPU', value: current && instance.cpu !== null && instance.cpu !== undefined ? `${instance.cpu}%` : 'Unavailable', inline: true },
    { name: 'RAM', value: ram, inline: true },
    { name: 'Players', value: players, inline: true }
  ];
  let maintenance = '';
  const manualScheduleText = instance.manualScheduleText;
  const events = manualScheduleText ? [] : instance.scheduleEvents ?? [];
  let displayed = 0;
  for (const event of events) {
    const line = `${safeText(event.label, 80)} - ${safeText(event.interval, 120)}\nNext: <t:${Math.floor(event.nextAt / 1000)}:F> (<t:${Math.floor(event.nextAt / 1000)}:R>)`;
    if (maintenance && maintenance.length + line.length + 1 > 950) {
      fields.push({ name: 'Scheduled maintenance', value: maintenance, inline: false });
      maintenance = '';
    }
    if (fields.length >= 8) break;
    maintenance += `${maintenance ? '\n' : ''}${line}`;
    displayed++;
  }
  if (displayed < events.length && maintenance) maintenance += `\n${events.length - displayed} more schedules`;
  else if (displayed < events.length) fields.at(-1).value += `\n${events.length - displayed} more schedules`;
  if (manualScheduleText) maintenance = manualScheduleText.split(/\r?\n/).map(line => safeText(line, 1000)).join('\n').slice(0, 1024);
  if (maintenance) fields.push({ name: 'Scheduled maintenance', value: maintenance, inline: false });
  if (addresses.length) fields.push({ name: 'Addresses:', value: addresses.join('\n').slice(0, 1024), inline: false });
  return new EmbedBuilder().setTitle(safeText(instance.friendlyName ?? instance.name ?? 'Unnamed server', 256))
    .setColor(!instance.available || instance.stale ? 0xe1a526 : instance.ampRunning === false || instance.appState === 'stopped' ? 0xd54a4a : 0x239b65)
    .addFields(fields)
    .setFooter({ text: instance.updatedAt ? `Last metrics: ${new Date(instance.updatedAt).toISOString()}` : 'No successful metrics yet' })
    .setTimestamp(polledAt);
}

const missingMessage = error => Number(error.code) === 10008;
const payload = embed => ({ content: '', embeds: [embed], allowedMentions: { parse: [] } });
const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];

/** Serialize binds, polling edits and alert cleanup to avoid message/config races. */
export class Dashboard {
  constructor({ client, store, guildId, log = console, now = Date.now }) {
    Object.assign(this, { client, store, guildId, log, now });
    this.queue = Promise.resolve();
    this.cleanupTimer = null;
  }

  serial(action) {
    const task = this.queue.then(action);
    this.queue = task.catch(() => {});
    return task;
  }

  async channel(id) {
    const channel = await this.client.channels.fetch(id);
    if (!channel || channel.guildId !== this.guildId || channel.type !== ChannelType.GuildText) throw new Error('Dashboard needs a text channel in the configured guild');
    if (!channel.permissionsFor(this.client.user)?.has(required)) throw new Error('Bot needs View Channel, Send Messages, Embed Links and Read Message History');
    return channel;
  }

  /** New IDs are persisted after each successful send, not only after the full network. */
  async upsert(mapping, embeds, save) {
    const channel = await this.channel(mapping.channelId);
    for (let index = 0; index < embeds.length; index++) {
      let message;
      if (mapping.messageIds[index]) {
        try { message = await channel.messages.fetch(mapping.messageIds[index]); }
        catch (error) { if (!missingMessage(error)) throw error; }
      }
      if (message) {
        if (message.author.id !== this.client.user.id) throw new Error('Stored dashboard message is not owned by this bot');
        try { await message.edit(payload(embeds[index])); }
        catch (error) { if (!missingMessage(error)) throw error; message = null; }
      }
      if (!message) {
        message = await channel.send(payload(embeds[index]));
        mapping.messageIds[index] = message.id;
        await save(mapping);
      }
    }
    while (mapping.messageIds.length > embeds.length) {
      const id = mapping.messageIds.at(-1);
      await this.deleteOwned(channel, id);
      mapping.messageIds.pop();
      await save(mapping);
    }
  }

  async deleteOwned(channel, id) {
    try {
      const message = await channel.messages.fetch(id);
      if (message.author.id !== this.client.user.id) throw new Error('Refusing to delete another author\'s message');
      await message.delete();
    } catch (error) { if (!missingMessage(error)) throw error; }
  }

  saveMapping(id, mapping) {
    return this.store.update(config => {
      const mappings = id === null ? config.overview : (config.instances[id] ??= []);
      const index = mappings.findIndex(value => value.channelId === mapping.channelId);
      if (index < 0) mappings.push(structuredClone(mapping));
      else mappings[index] = structuredClone(mapping);
    });
  }

  render(id, snapshot, config = this.store.snapshot()) {
    if (id === null) return buildOverviewEmbeds(snapshot, config.hiddenInstances);
    const instance = snapshot.instances.find(value => value.id === id) ?? { id, name: id, available: false, players: { current: null, max: null } };
    const ampSettings = config.settings.amp;
    const reported = instance.reportedEndpoints ?? normalizeEndpoints(instance.rawEndpoints ?? instance.endpoints);
    const endpoints = ampSettings.instanceOverrides[id]?.endpoints ?? (ampSettings.useReportedEndpoints ? reported : []);
    const manualScheduleText = ampSettings.instanceOverrides[id]?.scheduleText;
    const scheduleEvents = config.settings.scheduleAutoDetect ? instance.scheduleEvents : [];
    return [buildInstanceEmbed({ ...instance, endpoints, manualScheduleText, scheduleEvents }, snapshot.polledAt)];
  }

  publish(snapshot) {
    return this.serial(async () => {
      const config = this.store.snapshot();
      const mappings = [
        ...config.overview.map(mapping => [null, mapping]),
        ...Object.entries(config.instances).flatMap(([id, channels]) => channels.map(mapping => [id, mapping]))
      ];
      for (const [id, mapping] of mappings) {
        try { await this.upsert(mapping, this.render(id, snapshot, config), updated => this.saveMapping(id, updated)); }
        catch { this.log.warn('Dashboard update failed; check channel permissions', { instanceId: id, channelId: mapping.channelId }); }
      }
    });
  }

  /** Adding a channel leaves existing bindings and messages intact. */
  bind(id, channelId, snapshot) {
    return this.serial(async () => {
      await this.channel(channelId);
      const config = this.store.snapshot();
      const mappings = id === null ? config.overview : config.instances[id] ?? [];
      const mapping = mappings.find(value => value.channelId === channelId) ?? { channelId, messageIds: [] };
      await this.upsert(mapping, this.render(id, snapshot, config), updated => this.saveMapping(id, updated));
      await this.saveMapping(id, mapping);
    });
  }

  removeChannel(id, channelId) {
    return this.serial(async () => {
      const config = this.store.snapshot();
      const mappings = id === null ? config.overview : config.instances[id] ?? [];
      const mapping = mappings.find(value => value.channelId === channelId);
      if (!mapping) return { removed: false, cleanupFailed: false };
      await this.store.update(data => {
        if (id === null) data.overview = data.overview.filter(value => value.channelId !== channelId);
        else {
          data.instances[id] = data.instances[id].filter(value => value.channelId !== channelId);
          if (!data.instances[id].length) delete data.instances[id];
        }
      });
      try {
        const channel = await this.channel(channelId);
        for (const messageId of mapping.messageIds) await this.deleteOwned(channel, messageId);
        return { removed: true, cleanupFailed: false };
      } catch {
        this.log.warn('Removed dashboard messages could not be deleted', { channelId, instanceId: id });
        return { removed: true, cleanupFailed: true };
      }
    });
  }

  async setHidden(instanceId, hidden, snapshot) {
    await this.store.update(config => {
      const ids = new Set(config.hiddenInstances);
      if (hidden) ids.add(instanceId);
      else ids.delete(instanceId);
      config.hiddenInstances = [...ids];
    });
    await this.publish(snapshot);
  }

  async setManualAddresses(instanceId, addresses, snapshot) {
    await this.store.update(config => {
      const overrides = config.settings.amp.instanceOverrides;
      if (addresses === null) {
        if (!overrides[instanceId]) return;
        delete overrides[instanceId].endpoints;
        if (Object.keys(overrides[instanceId]).length === 0) delete overrides[instanceId];
        return;
      }
      const override = overrides[instanceId] ??= {};
      override.endpoints = [...addresses];
    });
    await this.publish(snapshot);
  }

  async setManualSchedule(instanceId, scheduleText, snapshot) {
    await this.store.update(config => {
      const overrides = config.settings.amp.instanceOverrides;
      if (scheduleText === null) {
        if (!overrides[instanceId]) return;
        delete overrides[instanceId].scheduleText;
        if (Object.keys(overrides[instanceId]).length === 0) delete overrides[instanceId];
      } else {
        (overrides[instanceId] ??= {}).scheduleText = scheduleText;
      }
    });
    await this.publish(snapshot);
  }

  alert(instance, scheduled = null) {
    return this.serial(async () => {
      const config = this.store.snapshot();
      if (!config.settings.alerts.enabled) return;
      const routing = config.settings.alerts.instanceRouting[instance.id] ?? { overview: true, instance: false };
      const channels = new Set();
      if (routing.overview && !config.hiddenInstances.includes(instance.id)) {
        for (const mapping of config.overview) channels.add(mapping.channelId);
      }
      if (routing.instance) {
        for (const mapping of config.instances[instance.id] ?? []) channels.add(mapping.channelId);
      }
      const name = safeText(instance.friendlyName ?? instance.name, 120);
      const activity = scheduled?.state === 'scheduled-backup' ? 'scheduled backup' : 'scheduled restart';
      const content = scheduled ? `${name} is down for ${activity}.` : `Downtime detected: ${name} is stopped.`;
      for (const channelId of channels) {
        try {
          const channel = await this.channel(channelId);
          const message = await channel.send({ content, allowedMentions: { parse: [] } });
          const retention = config.settings.alerts.retentionSeconds;
          if (retention !== null) await this.store.update(data => {
            data.pendingAlerts.push({ channelId: channel.id, messageId: message.id, deleteAt: this.now() + retention * 1000 });
          });
        } catch { this.log.warn('Downtime alert could not be published', { channelId }); }
      }
    });
  }

  cleanupAlerts() {
    return this.serial(async () => {
      for (const alert of this.store.snapshot().pendingAlerts.filter(value => value.deleteAt <= this.now())) {
        try {
          await this.deleteOwned(await this.channel(alert.channelId), alert.messageId);
        } catch (error) {
          if (Number(error.code) !== 10003) { this.log.warn('Alert cleanup failed', { channelId: alert.channelId }); continue; }
        }
        await this.store.update(config => { config.pendingAlerts = config.pendingAlerts.filter(value => value.messageId !== alert.messageId); });
      }
    });
  }

  startCleanup() {
    this.cleanupTimer = setInterval(() => { void this.cleanupAlerts().catch(() => this.log.warn('Alert cleanup cycle failed')); }, 15000);
    return this.cleanupAlerts();
  }

  async stop() { clearInterval(this.cleanupTimer); await this.queue; }
}