import { EmbedBuilder, ChannelType, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { playerSummary } from './monitor.js';

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
    inline: false
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
    ? `${instance.players.current}${instance.players.max === null || instance.players.max === undefined ? '' : ` / ${instance.players.max}`}` : 'Unavailable';
  return new EmbedBuilder().setTitle(safeText(instance.friendlyName ?? instance.name ?? 'Unnamed server', 256))
    .setColor(!instance.available || instance.stale ? 0xe1a526 : instance.ampRunning === false || instance.appState === 'stopped' ? 0xd54a4a : 0x239b65)
    .addFields(
      { name: 'Execution state', value: publicStatus(instance), inline: true },
      { name: 'CPU', value: current && instance.cpu !== null && instance.cpu !== undefined ? `${instance.cpu}%` : 'Unavailable', inline: true },
      { name: 'RAM', value: ram, inline: true },
      { name: 'Players', value: players, inline: true },
      { name: 'Host', value: safeText(instance.host?.name ?? 'Unknown') || 'Unknown', inline: true },
      { name: 'Connection endpoints', value: (instance.endpoints ?? []).map(endpointText).join('\n').slice(0, 1024) || 'Not reported by AMP' }
    ).setFooter({ text: instance.updatedAt ? `Last metrics: ${new Date(instance.updatedAt).toISOString()}` : 'No successful metrics yet' })
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
      if (id === null) config.overview = structuredClone(mapping);
      else config.instances[id] = structuredClone(mapping);
    });
  }

  render(id, snapshot, config = this.store.snapshot()) {
    if (id === null) return buildOverviewEmbeds(snapshot, config.hiddenInstances);
    const instance = snapshot.instances.find(value => value.id === id) ?? { id, name: id, available: false, players: { current: null, max: null } };
    return [buildInstanceEmbed(instance, snapshot.polledAt)];
  }

  publish(snapshot) {
    return this.serial(async () => {
      const config = this.store.snapshot();
      const mappings = [...(config.overview ? [[null, config.overview]] : []), ...Object.entries(config.instances)];
      for (const [id, mapping] of mappings) {
        try { await this.upsert(mapping, this.render(id, snapshot, config), updated => this.saveMapping(id, updated)); }
        catch { this.log.warn('Dashboard update failed; check channel permissions', { instanceId: id, channelId: mapping.channelId }); }
      }
    });
  }

  /** Rebinding removes old messages only after new messages are successfully tracked. */
  bind(id, channelId, snapshot) {
    return this.serial(async () => {
      await this.channel(channelId);
      const config = this.store.snapshot();
      const old = id === null ? config.overview : config.instances[id];
      const mapping = old?.channelId === channelId ? old : { channelId, messageIds: [] };
      await this.upsert(mapping, this.render(id, snapshot, config), updated => this.saveMapping(id, updated));
      await this.saveMapping(id, mapping);
      if (old && old.channelId !== channelId) {
        try {
          const channel = await this.channel(old.channelId);
          for (const messageId of old.messageIds) await this.deleteOwned(channel, messageId);
        } catch { this.log.warn('Old dashboard cleanup failed', { channelId: old.channelId }); }
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

  alert(instance) {
    return this.serial(async () => {
      const config = this.store.snapshot();
      if (!config.overview || !config.settings.alerts.enabled || config.hiddenInstances.includes(instance.id)) return;
      const channel = await this.channel(config.overview.channelId);
      const message = await channel.send({ content: `Downtime detected: ${safeText(instance.name, 120)} is stopped.`, allowedMentions: { parse: [] } });
      const retention = config.settings.alerts.retentionSeconds;
      if (retention !== null) await this.store.update(data => {
        data.pendingAlerts.push({ channelId: channel.id, messageId: message.id, deleteAt: this.now() + retention * 1000 });
      });
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