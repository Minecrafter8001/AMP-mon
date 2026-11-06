import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';

/** Guild registration plus runtime checks both enforce administrative configuration. */
export const commands = [
  new SlashCommandBuilder().setName('monitor').setDescription('Configure AMP network monitoring')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand => subcommand.setName('setup').setDescription('Add a network overview to a channel')
      .addChannelOption(option => option.setName('channel').setDescription('Dashboard text channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(subcommand => subcommand.setName('add').setDescription('Track an AMP instance in a channel')
      .addStringOption(option => option.setName('instance_name').setDescription('AMP instance name').setRequired(true).setAutocomplete(true).setMaxLength(100))
      .addChannelOption(option => option.setName('channel').setDescription('Tracking text channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(subcommand => subcommand.setName('hide').setDescription('Hide a server from the public overview')
      .addStringOption(option => option.setName('instance_name').setDescription('Server name to hide').setRequired(true).setAutocomplete(true).setMaxLength(100)))
    .addSubcommand(subcommand => subcommand.setName('show').setDescription('Show a hidden server in the public overview')
      .addStringOption(option => option.setName('instance_name').setDescription('Hidden server name to restore').setRequired(true).setAutocomplete(true).setMaxLength(100)))
    .addSubcommand(subcommand => subcommand.setName('address').setDescription('Set manual connection addresses')
      .addStringOption(option => option.setName('instance_name').setDescription('AMP instance name').setRequired(true).setAutocomplete(true).setMaxLength(100))
      .addStringOption(option => option.setName('addresses').setDescription('One address per line, or clear to remove them').setRequired(true).setMaxLength(1000)))
    .addSubcommand(subcommand => subcommand.setName('alerts').setDescription('Configure alert destinations for a server')
      .addStringOption(option => option.setName('instance_name').setDescription('AMP instance name').setRequired(true).setAutocomplete(true).setMaxLength(100))
      .addBooleanOption(option => option.setName('overview').setDescription('Send alerts to overview channels').setRequired(true))
      .addBooleanOption(option => option.setName('instance').setDescription('Send alerts to server status channels').setRequired(true)))
    .addSubcommand(subcommand => subcommand.setName('schedule').setDescription('Set custom maintenance schedule text')
      .addStringOption(option => option.setName('instance_name').setDescription('AMP instance name').setRequired(true).setAutocomplete(true).setMaxLength(100))
      .addStringOption(option => option.setName('text').setDescription('Schedule text, or clear to remove the override').setRequired(true).setMaxLength(1000)))
    .addSubcommand(subcommand => subcommand.setName('remove-channel').setDescription('Remove an overview or instance dashboard from a channel')
      .addChannelOption(option => option.setName('channel').setDescription('Channel to remove; defaults to this channel').addChannelTypes(ChannelType.GuildText))
      .addStringOption(option => option.setName('instance_name').setDescription('Instance name; omit for the network overview').setAutocomplete(true).setMaxLength(100)))
];

const instanceCommands = new Set(['add', 'hide', 'show', 'address', 'alerts', 'schedule', 'remove-channel']);

export function parseManualAddresses(input) {
  if (typeof input !== 'string') throw new Error('Addresses must be text.');
  const value = input.trim();
  if (/^clear$/i.test(value)) return null;
  const addresses = [...new Set(value.split(/\r?\n/).map(address => address.trim()).filter(Boolean))];
  if (!addresses.length) throw new Error('Addresses must contain one address per line, or use "clear".');
  if (addresses.length > 10 || addresses.some(address => address.length > 180 || /[\u0000-\u001f]/.test(address))) {
    throw new Error('Provide at most 10 addresses, each no longer than 180 characters.');
  }
  return addresses;
}

function resolveInstance(snapshot, name, allowUnavailable = false) {
  const matches = snapshot.instances.filter(instance => instance.name === name && (allowUnavailable || instance.available));
  if (matches.length === 0) throw new Error('Unknown AMP instance name. Choose a server from autocomplete.');
  if (matches.length > 1) throw new Error('That AMP instance name is ambiguous. Give the instances unique names in AMP, then try again.');
  return matches[0];
}

function autocompleteChoices(interaction, subcommand, snapshot, hiddenIds) {
  if (!instanceCommands.has(subcommand) || !snapshot || (snapshot.discoveryFailed && subcommand !== 'remove-channel')) return [];
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'instance_name') return [];
  const hidden = new Set(hiddenIds);
  const query = String(focused.value).toLocaleLowerCase();
  const seen = new Set();
  return snapshot.instances
    .filter(instance => instance.available || subcommand === 'remove-channel')
    .filter(instance => subcommand === 'show' ? hidden.has(instance.id) : subcommand === 'hide' ? !hidden.has(instance.id) : true)
    .filter(instance => instance.name.toLocaleLowerCase().includes(query))
    .filter(instance => {
      if (seen.has(instance.name)) return false;
      seen.add(instance.name);
      return true;
    })
    .slice(0, 25)
    .map(instance => ({ name: instance.name.slice(0, 100), value: instance.name.slice(0, 100) }));
}

export function commandHandler({ guildId, monitor, dashboard, store, log = console }) {
  return async interaction => {
    if (interaction.isAutocomplete()) {
      try {
        if (interaction.commandName !== 'monitor' || interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.respond([]);
          return;
        }
        const config = store.snapshot();
        await interaction.respond(autocompleteChoices(interaction, interaction.options.getSubcommand(), monitor.snapshot, config.hiddenInstances));
      } catch {
        try { await interaction.respond([]); } catch { log.warn('Autocomplete response could not be delivered'); }
      }
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'monitor') return;
    try {
      if (interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: 'Manage Server permission in the configured guild is required.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'remove-channel') {
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('Choose a text channel in this guild.');
        const name = interaction.options.getString('instance_name');
        let id = null;
        if (name) {
          const snapshot = monitor.snapshot ?? await monitor.poll();
          if (!snapshot) throw new Error('AMP discovery is unavailable; try again after connectivity is restored.');
          id = resolveInstance(snapshot, name, true).id;
        }
        const result = await dashboard.removeChannel(id, channel.id);
        const content = result.removed
          ? `Dashboard removed from <#${channel.id}>.${result.cleanupFailed ? ' Old messages could not be deleted; remove them manually.' : ''}`
          : 'No matching dashboard is configured in that channel.';
        await interaction.editReply({ content, allowedMentions: { parse: [] } });
        return;
      }
      const snapshot = monitor.snapshot && !monitor.snapshot.discoveryFailed ? monitor.snapshot : await monitor.poll();
      if (!snapshot || snapshot.discoveryFailed) throw new Error('AMP discovery is unavailable; try again after connectivity is restored.');
      if (instanceCommands.has(subcommand)) {
        const instance = resolveInstance(snapshot, interaction.options.getString('instance_name', true));
        if (subcommand === 'alerts') {
          const overview = interaction.options.getBoolean('overview', true);
          const instanceChannel = interaction.options.getBoolean('instance', true);
          await store.update(config => { config.settings.alerts.instanceRouting[instance.id] = { overview, instance: instanceChannel }; });
          await interaction.editReply({ content: `Alert destinations updated: overview ${overview ? 'on' : 'off'}, server channels ${instanceChannel ? 'on' : 'off'}.`, allowedMentions: { parse: [] } });
          return;
        }
        if (subcommand === 'schedule') {
          const text = interaction.options.getString('text', true).trim();
          if (!text) throw new Error('Schedule text cannot be empty.');
          const scheduleText = /^clear$/i.test(text) ? null : text;
          await dashboard.setManualSchedule(instance.id, scheduleText, snapshot);
          await interaction.editReply({ content: scheduleText === null ? 'Custom schedule cleared.' : 'Custom schedule updated.', allowedMentions: { parse: [] } });
          return;
        }
        if (subcommand === 'hide' || subcommand === 'show') {
          const hidden = subcommand === 'hide';
          await dashboard.setHidden(instance.id, hidden, snapshot);
          await interaction.editReply({ content: `${instance.name} ${hidden ? 'hidden from' : 'shown in'} the public status overview.`, allowedMentions: { parse: [] } });
          return;
        }
        if (subcommand === 'address') {
          const addresses = parseManualAddresses(interaction.options.getString('addresses', true));
          await dashboard.setManualAddresses(instance.id, addresses, snapshot);
          await interaction.editReply({
            content: addresses ? `Manual addresses updated for ${instance.friendlyName ?? instance.name}.` : `Manual addresses cleared for ${instance.friendlyName ?? instance.name}.`,
            allowedMentions: { parse: [] }
          });
          return;
        }
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('Choose a text channel in this guild.');
        await dashboard.channel(channel.id);
        await dashboard.bind(instance.id, channel.id, snapshot);
        await interaction.editReply({ content: `Dashboard configured in <#${channel.id}>.${instance.stale ? ' Metrics are currently unavailable for this instance; check AMP permissions and routing.' : ''}`, allowedMentions: { parse: [] } });
        return;
      }
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('Choose a text channel in this guild.');
      await dashboard.channel(channel.id);
      await dashboard.bind(null, channel.id, snapshot);
      await interaction.editReply({ content: `Dashboard configured in <#${channel.id}>.`, allowedMentions: { parse: [] } });
    } catch (error) {
      log.warn('Monitor configuration command failed', { command: interaction.commandName });
      // Only controlled validation messages are exposed; transport payloads are never relayed.
      const content = error.name === 'Error' && /^(Choose |Unknown AMP instance name|That AMP instance name|AMP discovery|Bot needs|Dashboard needs|Addresses |Schedule text )/.test(error.message)
        ? error.message : 'Dashboard setup failed. Check bot channel permissions and the operator logs.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch { log.warn('Interaction reply could not be delivered'); }
    }
  };
}