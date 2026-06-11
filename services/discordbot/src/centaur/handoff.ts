import { centaurApiKey, type AppConfig } from '../config'
import type { NormalizedDiscordEvent } from '../discord/types'

export type CentaurHandoffResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: unknown }

export class CentaurHandoff {
  readonly config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
  }

  async emit(event: NormalizedDiscordEvent): Promise<CentaurHandoffResult> {
    const url = new URL('/workflows/runs', this.config.CENTAUR_API_URL)
    const apiKey = centaurApiKey(this.config)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        workflow_name: 'discord_thread_turn',
        trigger_key: event.message_id,
        eager_start: true,
        input: {
          thread_key: event.thread_key,
          parts: event.parts,
          history_messages: event.history_messages ?? [],
          message_id: event.message_id,
          user_id: event.user_id,
          metadata: {
            source: 'discordbot',
            discord: event.discord,
            is_mention: event.discord.is_mention ?? false,
            ...(event.requester ? { requester: event.requester } : {})
          },
          delivery: {
            platform: 'discord',
            guild_id: event.guild_id,
            channel_id: event.channel_id,
            thread_id: event.channel_id,
            parent_channel_id: event.parent_channel_id,
            message_id: event.discord.message_id,
            recipient_user_id: event.user_id
          }
        }
      })
    })

    const body = await readResponseBody(response)
    return { ok: response.ok, status: response.status, body }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
