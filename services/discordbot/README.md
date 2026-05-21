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

For a single terminal-visible dogfood transcript of the core Discord path:

```bash
pnpm --filter discordbot dogfood:emulated
```

For the full local Warrunner Discord dogfood gate bundle:

```bash
just warrunner-dogfood-gates
```

This runs the Discordbot suite, type check, emulated dogfood loop, Discord API
config tests, and Warrunner Helm render assertions. It also builds the
Discordbot and Meatspace overlay images when Docker is available; use
`just warrunner-dogfood-gates --docker` to require image builds.

The E2E test starts an in-process fake Discord API and fake Centaur API, then
verifies:

- `/api/discord/events` accepts a Discord thread message.
- Discordbot can identify to a Discord-like Gateway and consume a
  `MESSAGE_CREATE` dispatch over WebSocket.
- Discordbot resolves the parent forum channel and fetches thread history.
- Discordbot starts a `discord_thread_turn` workflow run.
- A Gateway message can complete the emulated chat loop through workflow handoff,
  final-delivery claim, and Discord reply posting.
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
WARRUNNER_HOME_FORUM_CHANNEL_ID=... \
WARRUNNER_HOME_CHANNEL_IDS=... \
pnpm --filter discordbot dev
```

Before starting the long-running process, run the same environment through the
preflight:

```bash
pnpm --filter discordbot dogfood:preflight
```

To dogfood against an existing Meatspace host environment without copying
secrets into the repo, use the host wrapper. It defaults to
`/var/lib/meepo/hermes/.env`, runs from the repo root, opens the Discord target
automatically for live/session commands, and writes live/session JSON
transcripts under `/var/lib/meepo/warrunner/dogfood-transcripts`. For
live/session commands, it validates transcript directory writability before
starting pnpm or opening a Discord target:

```bash
just warrunner-live-dogfood preflight
just warrunner-live-dogfood session
```

To pass an explicit target channel or forum id:

```bash
just warrunner-live-dogfood session -- <channel-or-forum-id>
```

The lower-level dogfood CLI can also be pointed at the host env file directly:

```bash
pnpm --filter discordbot dogfood:preflight -- --dogfood-env-file=/var/lib/meepo/hermes/.env
pnpm --filter discordbot dogfood:session -- --dogfood-env-file=/var/lib/meepo/hermes/.env --open
```

You can also set `WARRUNNER_DOGFOOD_ENV_FILE=/var/lib/meepo/hermes/.env` once
and omit the flag. The direct Bun CLI also accepts `--env-file`; prefer
`--dogfood-env-file` with pnpm because pnpm reserves `--env-file`.
Set `WARRUNNER_DOGFOOD_TRANSCRIPT_DIR`, or pass `--transcript-dir`, to write a
live/session JSON transcript somewhere else under `/var/lib/meepo`.

Warrunner accepts the existing Meepo Discord aliases when the Warrunner-specific
values are not set: `MEEPO_DISCORD_GUILD_ID` for `DISCORD_GUILD_ID`,
`MEEPO_FORUM_CHANNEL_ID` for `WARRUNNER_HOME_FORUM_CHANNEL_ID`,
`DISCORD_FREE_RESPONSE_CHANNELS` for `WARRUNNER_HOME_CHANNEL_IDS`, and
`MEEPO_ALLOWED_ROLE_IDS`/`DISCORD_ALLOWED_ROLES` for
`WARRUNNER_ALLOWED_ROLE_IDS`.

The preflight verifies the Discord bot identity, Gateway URL, configured
forum/home channels, Centaur health, and that `discord_thread_turn` is
registered by the API.

`/health` is a liveness endpoint. `/health/ready` is the dogfood readiness gate
and returns non-200 until Discord credentials, Gateway ingest, the dogfood guild
id, Centaur credentials, route config, and bot mention identity are ready.

To intentionally verify the bot can write to Discord before turning on the
Gateway loop, post a smoke message to a text channel, an existing thread, or a
forum/media channel. Forum/media channel ids create a new smoke thread:

```bash
pnpm --filter discordbot dogfood:smoke -- <channel-or-thread-id>
```

You can also set `WARRUNNER_DOGFOOD_SMOKE_CHANNEL_ID` and run
`pnpm --filter discordbot dogfood:smoke`.
For tag-required forums, set `WARRUNNER_DOGFOOD_SMOKE_TAG_IDS` to a comma- or
space-separated list of tag ids.

To exercise the real Discord-window loop from one terminal, run:

```bash
pnpm --filter discordbot dogfood:live -- <channel-or-forum-id>
```

`dogfood:live` runs the preflight, starts the Gateway consumer, creates a
dogfood post or thread, waits for you to send a real Discord message there,
hands that message to `discord_thread_turn`, polls Centaur final deliveries, and
only passes after a Discord reply is posted. The target must be configured as a
Warrunner home forum, home channel, or intake channel; unroutable targets fail
before any Discord post is created. If no channel id is passed, it uses
`WARRUNNER_DOGFOOD_SMOKE_CHANNEL_ID`, then the configured home forum/home
channel. When the target is ready, the command prints a direct Discord URL for
the created thread or home channel. Set `WARRUNNER_DOGFOOD_LIVE_TIMEOUT_MS` to
change the default 180-second wait.
Pass `--open`, or set `WARRUNNER_DOGFOOD_OPEN_DISCORD=true`, to open the printed
Discord URL automatically when the live target is ready.
Pass `--transcript-dir <dir>`, or set `WARRUNNER_DOGFOOD_TRANSCRIPT_DIR`, to
write a JSON transcript containing the target URL, accepted Discord message ids,
workflow execution ids, handoff statuses, and every Discord reply id/content,
including chunked final answers. Live dogfood uses the execution id when
available so unrelated same-channel final deliveries do not satisfy the wrong
turn. The Meatspace host wrapper defaults this to
`/var/lib/meepo/warrunner/dogfood-transcripts`. If a
transcript directory is configured, live/session dogfood exits nonzero when the
transcript cannot be written. Both the host wrapper and the direct dogfood CLI
validate the transcript directory before Discord preflight or live chat begins.

For iterative dogfooding from the Discord window, run a short live session:

```bash
pnpm --filter discordbot dogfood:session -- <channel-or-forum-id>
```

This uses the same setup as `dogfood:live`, but waits for multiple Discord
messages and prints each accepted message plus the Discord reply id. It defaults
to three turns; pass `--turns <n>` or set `WARRUNNER_DOGFOOD_SESSION_TURNS` to
change that count. Pass `--timeout-ms <ms>` to extend a long manual session
without editing env. Use the printed Discord URL as the window to keep chatting
with Warrunner. For the tightest local loop, run
`pnpm --filter discordbot dogfood:session -- --open --turns 12 --timeout-ms 600000 <channel-or-forum-id>`.
To reattach to an already-open forum thread or home channel without posting a
new setup prompt, pass `--attach`:

```bash
pnpm --filter discordbot dogfood:session -- --attach --open --turns 12 --timeout-ms 600000 <thread-or-home-channel-id>
```

`DISCORD_BOT_USER_ID` is optional; Discordbot infers it from the bot token
before processing inbound messages. Setting it explicitly avoids that startup
lookup.

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
The `Publish Warrunner Images` workflow publishes the `warrunner-discordbot`
and `warrunner-overlay` images referenced by that values file.
