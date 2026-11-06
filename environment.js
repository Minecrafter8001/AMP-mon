/** Validate startup input before connecting to either service. Never log raw secrets. */
export function environment({ discord = true, amp = true } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  const names = [
    ...(discord ? ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'] : []),
    ...(amp ? ['AMP_URL', 'AMP_USERNAME'] : [])
  ];
  for (const name of names) if (!process.env[name]?.trim()) throw new Error(`Missing ${name}; configure .env using .env.example`);
  if (amp && !process.env.AMP_PASSWORD && !process.env.AMP_LOGIN_TOKEN) throw new Error('Set AMP_PASSWORD or AMP_LOGIN_TOKEN');
  if (discord) for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID']) {
    if (!/^\d{17,20}$/.test(process.env[name])) throw new Error(`Invalid ${name}`);
  }
  return {
    discordToken: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    ampUrl: process.env.AMP_URL,
    ampUsername: process.env.AMP_USERNAME,
    ampPassword: process.env.AMP_PASSWORD ?? '',
    ampToken: process.env.AMP_LOGIN_TOKEN ?? ''
  };
}

/** Shared constructor input for the bot and read-only compatibility inspector. */
export function ampOptions(env, config) {
  return {
    url: env.ampUrl, username: env.ampUsername, password: env.ampPassword, token: env.ampToken,
    settings: {
      ...config.settings.amp,
      scheduleRefreshMs: config.settings.scheduleRefreshMs,
      scheduleTimeZone: config.settings.scheduleTimeZone
    },
    timeoutMs: config.settings.requestTimeoutMs
  };
}