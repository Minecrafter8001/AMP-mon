import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';

/** Guild registration plus runtime checks both enforce administrative configuration. */
export const commands = [
  new SlashCommandBuilder().setName('monitor-setup').setDescription('Configure the network status dashboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option.setName('channel').setDescription('Dashboard text channel').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('monitor-add').setDescription('Track one AMP instance in a text channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('instance_name').setDescription('Exact AMP instance name, not its friendly display name').setRequired(true).setMaxLength(100))
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
      let instance = null;
      if (interaction.commandName === 'monitor-add') {
        const name = interaction.options.getString('instance_name', true);
        const matches = snapshot.instances.filter(value => value.name === name && value.available);
        if (matches.length === 0) throw new Error('Unknown AMP instance name. Use the exact non-friendly instance name shown in the overview.');
        if (matches.length > 1) throw new Error('That AMP instance name is ambiguous. Give the instances unique names in AMP, then try again.');
        [instance] = matches;
      }
      await dashboard.bind(instance?.id ?? null, channel.id, snapshot);
      await interaction.editReply({ content: `Dashboard configured in <#${channel.id}>.${instance?.stale ? ' Metrics are currently unavailable for this instance; check AMP permissions and routing.' : ''}`, allowedMentions: { parse: [] } });
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