import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';

/** Guild registration plus runtime checks both enforce administrative configuration. */
export const commands = [
  new SlashCommandBuilder().setName('monitor-setup').setDescription('Configure the network status dashboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option.setName('channel').setDescription('Dashboard text channel').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('monitor-add').setDescription('Track one AMP instance in a text channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('instance_name').setDescription('AMP instance name').setRequired(true).setAutocomplete(true).setMaxLength(100))
    .addChannelOption(option => option.setName('channel').setDescription('Tracking text channel').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('monitor-hide').setDescription('Hide a server from the public status overview')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('instance_name').setDescription('Server name to hide').setRequired(true).setAutocomplete(true).setMaxLength(100)),
  new SlashCommandBuilder().setName('monitor-show').setDescription('Show a hidden server in the public status overview')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('instance_name').setDescription('Hidden server name to restore').setRequired(true).setAutocomplete(true).setMaxLength(100))
];

const instanceCommands = new Set(['monitor-add', 'monitor-hide', 'monitor-show']);

function resolveInstance(snapshot, name) {
  const matches = snapshot.instances.filter(instance => instance.name === name && instance.available);
  if (matches.length === 0) throw new Error('Unknown AMP instance name. Choose a server from autocomplete.');
  if (matches.length > 1) throw new Error('That AMP instance name is ambiguous. Give the instances unique names in AMP, then try again.');
  return matches[0];
}

function autocompleteChoices(interaction, snapshot, hiddenIds) {
  if (!instanceCommands.has(interaction.commandName) || !snapshot || snapshot.discoveryFailed) return [];
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'instance_name') return [];
  const hidden = new Set(hiddenIds);
  const query = String(focused.value).toLocaleLowerCase();
  const seen = new Set();
  return snapshot.instances
    .filter(instance => instance.available)
    .filter(instance => interaction.commandName === 'monitor-show' ? hidden.has(instance.id) : interaction.commandName === 'monitor-hide' ? !hidden.has(instance.id) : true)
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
        if (interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.respond([]);
          return;
        }
        const config = store.snapshot();
        const snapshot = monitor.snapshot && !monitor.snapshot.discoveryFailed
          ? monitor.snapshot
          : monitor.discoveredInstances ? { instances: monitor.discoveredInstances, discoveryFailed: false } : null;
        await interaction.respond(autocompleteChoices(interaction, snapshot, config.hiddenInstances));
      } catch {
        try { await interaction.respond([]); } catch { log.warn('Autocomplete response could not be delivered'); }
      }
      return;
    }
    if (!interaction.isChatInputCommand() || !commands.some(command => command.name === interaction.commandName)) return;
    try {
      if (interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: 'Manage Server permission in the configured guild is required.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const snapshot = monitor.snapshot && !monitor.snapshot.discoveryFailed ? monitor.snapshot : await monitor.poll();
      if (!snapshot || snapshot.discoveryFailed) throw new Error('AMP discovery is unavailable; try again after connectivity is restored.');
      if (instanceCommands.has(interaction.commandName)) {
        const instance = resolveInstance(snapshot, interaction.options.getString('instance_name', true));
        if (interaction.commandName === 'monitor-hide' || interaction.commandName === 'monitor-show') {
          const hidden = interaction.commandName === 'monitor-hide';
          await dashboard.setHidden(instance.id, hidden, snapshot);
          await interaction.editReply({ content: `${instance.name} ${hidden ? 'hidden from' : 'shown in'} the public status overview.`, allowedMentions: { parse: [] } });
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
      const content = error.name === 'Error' && /^(Choose |Unknown AMP instance name|That AMP instance name|AMP discovery|Bot needs|Dashboard needs)/.test(error.message)
        ? error.message : 'Dashboard setup failed. Check bot channel permissions and the operator logs.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch { log.warn('Interaction reply could not be delivered'); }
    }
  };
}