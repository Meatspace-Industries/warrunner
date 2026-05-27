# Warrunner Overlay

This overlay holds Meatspace-specific Centaur extensions. It is built as a
small image and mounted into the Centaur API at `/app/overlay/org` and sandbox
pods at `/home/agent/overlay/org`.

Current contents:

- `workflows/discord_thread_turn.py` adapts Discord forum-thread messages into
  a durable Centaur agent turn.
- `services/sandbox/SYSTEM_PROMPT.md` adds Warrunner operating guidance without
  replacing upstream Centaur code.
- `.agents/skills/warrunner-discord/SKILL.md` gives the sandbox a concise
  playbook for Discord/forum based work.
- `tools/discord_history` is a credential-free shape for local Discord history
  search once exports are available.

Build locally:

```bash
docker build -t ghcr.io/meatspace-industries/warrunner-overlay:sha-$(git rev-parse --short HEAD) meatspace/overlay
```
