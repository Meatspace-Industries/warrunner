# Warrunner Discordbot

Discordbot is Warrunner's Discord/forum-thread integration for Centaur.

It runs two loops:

- Discord Gateway `MESSAGE_CREATE` ingest. Messages in configured home forum
  threads become `discord_thread_turn` workflow runs. Messages in configured
  home channels are also accepted when they mention the bot by default.
- Centaur final-delivery polling. Completed `platform: discord` deliveries are
  posted back into the same Discord thread.

## Local Emulated E2E

This does not require live Discord credentials:

```bash
pnpm --filter discordbot test
```

The E2E test starts an in-process fake Discord API and fake Centaur API, then
verifies:

- `/api/discord/events` accepts a Discord thread message.
- Discordbot resolves the parent forum channel and fetches thread history.
- Discordbot starts a `discord_thread_turn` workflow run.
- Discordbot claims a final delivery and posts the final answer back to the
  Discord thread API.

## Live Dogfood Checklist

1. Create or reuse a Discord application and bot with these Gateway intents:
   `Guilds`, `Guild Messages`, and `Message Content`.
2. Invite the bot to the guild and grant it access to the Warrunner home forum
   channel.
3. Run Centaur API with the Warrunner overlay mounted and `DISCORDBOT_API_KEY`
   present in the API environment.
4. Run Discordbot:

```bash
DISCORD_BOT_TOKEN=... \
DISCORDBOT_API_KEY=... \
CENTAUR_API_URL=http://localhost:8000 \
DISCORD_GUILD_ID=... \
DISCORD_BOT_USER_ID=... \
WARRUNNER_HOME_FORUM_CHANNEL_ID=... \
WARRUNNER_HOME_CHANNEL_IDS=... \
pnpm --filter discordbot dev
```

Before starting the long-running process, run the same environment through the
preflight:

```bash
pnpm --filter discordbot dogfood:preflight
```

The preflight verifies the Discord bot identity, Gateway URL, configured
forum/home channels, Centaur health, and that `discord_thread_turn` is
registered by the API.

5. In Discord, create a forum post under the configured home forum channel.
6. Send a message in that forum thread. Mentioning the bot is optional if the
   thread belongs to the configured home forum.
7. Alternatively, mention the bot in a configured home channel.
8. Verify that the final answer appears in the same Discord thread or home
   channel.

Set `WARRUNNER_HOME_CHANNEL_MENTION_REQUIRED=false` only if the home channel is
dedicated to Warrunner and every message there should start a turn.

For a remote deployment, set the same values through Helm using
`meatspace/infra/helm/values.warrunner.yaml` and the `centaur-infra-env` Secret.
