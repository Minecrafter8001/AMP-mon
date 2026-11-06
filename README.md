# AMP-mon

AMP-mon monitors a CubeCoders AMP network with a Discord overview and optional per-server dashboards.

### screenshots: 

<img width="289" height="158" alt="image" src="https://github.com/user-attachments/assets/59261797-cf56-4b0b-8e57-c19f772675ff"/> 
<img width="245" height="185" alt="image" src="https://github.com/user-attachments/assets/bc5c3452-2eef-4c26-8b64-9d034f8fa940" />




## Requirements

- Node.js 24 or newer and npm.
- An AMP Controller or Hybrid and an account with permission to view the intended instances, status, schedules, and backup settings.
- A Discord bot installed in one server with the `bot` and `applications.commands` scopes.
- Bot channel permissions: View Channel, Send Messages, Embed Links, and Read Message History.
- Manage Server permission for people configuring the bot.

## Setup

1. Install dependencies with `npm ci`.
2. Create `.env` using `.env.example`, then configure:

   | Setting | Value |
   | --- | --- |
   | `DISCORD_TOKEN` | Discord bot token. |
   | `DISCORD_CLIENT_ID` | Discord application ID. |
   | `DISCORD_GUILD_ID` | Discord server ID. |
   | `AMP_URL` | AMP Controller or Hybrid web address, for example `http://192.168.1.50:8080/`. |
   | `AMP_USERNAME` | AMP monitoring account. |
   | `AMP_PASSWORD` | AMP account password, if using password authentication. |
   | `AMP_LOGIN_TOKEN` | Optional AMP service-login token. |

   HTTP sends AMP credentials and sessions unencrypted. Use it only on a trusted network or VPN.

3. Run `npm run deploy-commands`. This clears existing guild commands for this application, then registers `/monitor`.
4. Run `npm start`.

The bot creates `config.json` on first run. Keep `.env`, `config.json`, and inspection reports private. Stop the bot before editing `config.json`, then restart it.

## Commands

All commands require Manage Server permission. Select an AMP instance by its non-friendly instance name; autocomplete is available.

| Command | Purpose |
| --- | --- |
| `/monitor setup [channel]` | Add a network overview to a channel. |
| `/monitor add instance_name [channel]` | Add a server's status dashboard to a channel. |
| `/monitor remove-channel [channel] [instance_name]` | Remove the overview, or the named server's dashboard, from a channel. |
| `/monitor hide instance_name` | Hide a server from public overviews and their player totals. |
| `/monitor show instance_name` | Show a hidden server in the overviews again. |
| `/monitor address instance_name addresses` | Set manual join addresses, one per line; enter `clear` to remove them. |
| `/monitor alerts instance_name overview instance` | Enable or disable alerts in overview and server-status channels for that server. |
| `/monitor schedule instance_name text` | Set custom maintenance text; enter `clear` to remove it. |

When a channel is omitted, the current text channel is used. Overviews and server dashboards can be added to multiple channels. Removing a binding attempts to delete its bot-owned messages; if cleanup fails, remove those messages manually.

Manual addresses take precedence over AMP-reported addresses. If neither source provides an address, the field is omitted. Set `settings.amp.useReportedEndpoints` to `false` in `config.json` to use only manual addresses.

## Alerts And Schedules

By default the bot polls every 30 seconds and sends a temporary alert to overview channels when it observes a server go from running to stopped. Hidden servers do not alert in public overviews. Use `/monitor alerts` to choose destinations per server.

The `settings.alerts` section of `config.json` controls alerts:

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable or disable downtime alerts. |
| `mode` | `either` | Watch AMP process state (`amp`), game state (`application`), or both (`either`). |
| `retentionSeconds` | `300` | Time before deleting alerts; set to `null` to keep them. |
| `cooldownSeconds` | `0` | Minimum time between alerts for the same server. |
| `scheduleWindowSeconds` | `300` | Seconds before or after a detected schedule when downtime is described as scheduled. |

With schedule autodetection enabled, server dashboards show qualifying restart schedules and backups that AMP reports will stop the game server. Set `settings.scheduleAutoDetect` to `false` to disable these checks. Set `settings.scheduleTimeZone` to the IANA time zone used by AMP's scheduler; its default is `UTC`.

Custom schedule text replaces the detected schedule in the dashboard but does not set an alert time. Scheduled alert wording is inferred from proximity to a detected event; it does not prove what caused the downtime. A restart completed between polls may not be observed.

## Troubleshooting

- **The bot does not start:** Check Node.js is version 24 or newer and the required `.env` settings are populated.
- **Commands do not appear:** Run `npm run deploy-commands`, restart the bot, and check its Discord application scopes and your Manage Server permission.
- **A server or metric is missing:** Confirm the AMP account can access it and AMP reports the required values. Run `npm run inspect-amp` for a local diagnostic report; it may contain private server information.
- **A dashboard does not update:** Check the bot's channel permissions and logs. Deleted dashboard messages are recreated on the next update when possible.
- **Schedule times look wrong:** Check `settings.scheduleTimeZone` matches AMP's scheduler and that the AMP account can view schedules and backup settings.
