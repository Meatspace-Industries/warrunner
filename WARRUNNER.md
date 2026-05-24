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
- Configure `WARRUNNER_HOME_CHANNEL_IDS` or `discordbot.homeChannelIds` for a
  normal Discord home channel. By default, only bot-mentioned messages in the
  home channel start a turn.
- `WARRUNNER_INTAKE_CHANNEL_IDS` can allow explicit intake channels when needed,
  but the default deployment expects thread context instead of many channel
  listeners.

Required secret keys for the Discord deployment:

- `DISCORD_BOT_TOKEN`
- `DISCORDBOT_API_KEY`
- Centaur's normal API/sandbox/model secrets

## Codex Auth

Warrunner's default Meatspace deployment uses Codex with ChatGPT login auth,
not OpenAI API billing. Run `codex login` locally first, then create the
cluster Secret from the resulting `~/.codex/auth.json`:

```sh
meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh
```

Re-run the same script after changing `~/.config/warrunner/deploy.env` or after
refreshing local Codex login. To refresh only the Codex auth Secret without
touching Discord or database secrets:

```sh
meatspace/scripts/warrunner-bootstrap-k8s-secrets.sh --codex-auth-only
```

The Helm values in `meatspace/infra/helm/values.warrunner.yaml` point
`sandbox.codexAuth.existingSecretName` at `warrunner-codex-auth`. When that
Secret is configured, the Kubernetes sandbox backend mounts it only into Codex
sandbox Pods, omits the `OPENAI_API_KEY` harness stub for those Pods, and the
sandbox entrypoint installs the mounted ChatGPT auth file before
`codex app-server` starts.

The same values file sets `CENTAUR_DISABLED_INFRA_SECRETS=OPENAI_API_KEY` on
the API deployment so Warrunner's generated iron-proxy configs do not reference
or resolve an OpenAI API key at all.

Keep runtime state under `/var/lib/meepo`; do not write mutable state into image
or release directories.
