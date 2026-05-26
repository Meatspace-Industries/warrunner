---
name: warrunner-discord
description: Use when a task arrives from a Warrunner Discord forum thread or home channel.
---

# Warrunner Discord Threads

Use this skill when a task arrives from a Discord forum thread.

Workflow:

1. Treat the current thread as the source of truth for user intent and prior
   context.
2. Keep the final response suitable for posting directly into Discord: concise,
   clear, and without Slack-specific phrasing.
3. If the task involves code execution, only touch repositories that the active
   environment configuration permits.
4. If a Discord history lookup tool is available, use it for prior context
   before guessing from memory.

Avoid:

- Direct writes to protected branches.
- Adding Google Cloud runtime dependencies.
- Storing mutable runtime state inside release directories.
