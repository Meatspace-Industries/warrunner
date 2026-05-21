# Warrunner

Warrunner is Meatspace's Discord-first fork of
[`paradigmxyz/centaur`](https://github.com/paradigmxyz/centaur).

This fork keeps upstream Centaur at the repo root and places Meatspace-specific
behavior under `meatspace/`:

- `services/discordbot` listens to Discord Gateway `MESSAGE_CREATE` events,
  accepts messages from configured home/forum threads, starts
  `discord_thread_turn` workflow runs, and posts final Centaur deliveries back
  to Discord.
- `meatspace/overlay` is the organization overlay image. It contains the
  Discord workflow, sandbox prompt guidance, and optional Meatspace tools.
- `meatspace/infra/helm/values.warrunner.yaml` is the default Helm values file
  for the Discord/forum-thread deployment shape.

## Discord Model

Warrunner is intentionally home-thread based:

- Configure `WARRUNNER_HOME_FORUM_CHANNEL_ID` or `discordbot.homeForumChannelId`
  to the Discord forum channel that owns Warrunner work threads.
- Messages in child threads of that forum become Centaur thread keys in the
  form `discord:<guild_id>:<parent_channel_id>:<thread_id>`.
- `WARRUNNER_INTAKE_CHANNEL_IDS` can allow explicit intake channels when needed,
  but the default deployment expects thread context instead of many channel
  listeners.

Required secret keys for the Discord deployment:

- `DISCORD_BOT_TOKEN`
- `DISCORDBOT_API_KEY`
- Centaur's normal API/sandbox/model secrets

Keep runtime state under `/var/lib/meepo`; do not write mutable state into image
or release directories.
