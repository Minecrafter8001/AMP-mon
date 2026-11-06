import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';

/** Guild registration plus runtime checks both enforce administrative configuration. */
export const commands = [
  new SlashCommandBuilder().setName('monitor-setup').setDescription('Configure the network status dashboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option.setName('channel').setDescription('Dashboard text channel').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('monitor-add').setDescription('Track one AMP instance in a text channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('instance_id').setDescription('Exact AMP internal InstanceID, not its display name').setRequired(true).setMaxLength(100))
    .addChannelOption(option => option.setName('channel').setDescription('Tracking text channel').addChannelTypes(ChannelType.GuildText))
];

export function commandHandler({ guildId, monitor, dashboard, log = console }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || !commands.some(command => command.name === interaction.commandName)) return;
    try {
      if (interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: 'Manage Server permission in the configured guild is required.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('Choose a text channel in this guild.');
      await dashboard.channel(channel.id);
      const snapshot = monitor.snapshot && !monitor.snapshot.discoveryFailed ? monitor.snapshot : await monitor.poll();
      if (!snapshot || snapshot.discoveryFailed) throw new Error('AMP discovery is unavailable; try again after connectivity is restored.');
      const id = interaction.commandName === 'monitor-add' ? interaction.options.getString('instance_id', true) : null;
      if (id !== null && !snapshot.instances.some(instance => instance.id === id && instance.available)) throw new Error('Unknown InstanceID. Use the exact internal key of a currently discovered AMP instance.');
      await dashboard.bind(id, channel.id, snapshot);
      await interaction.editReply({ content: `Dashboard configured in <#${channel.id}>.${id && snapshot.instances.find(instance => instance.id === id)?.stale ? ' Metrics are currently unavailable for this instance; check AMP permissions and routing.' : ''}`, allowedMentions: { parse: [] } });
    } catch (error) {
      log.warn('Monitor configuration command failed', { command: interaction.commandName });
      // Only controlled validation messages are exposed; transport payloads are never relayed.
      const content = error.name === 'Error' && /^(Choose |Unknown InstanceID|AMP discovery|Bot needs|Dashboard needs)/.test(error.message)
        ? error.message : 'Dashboard setup failed. Check bot channel permissions and the operator logs.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch { log.warn('Interaction reply could not be delivered'); }
    }
  };
}