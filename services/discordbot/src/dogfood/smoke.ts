import { loadConfig, type AppConfig } from '../config'
import { DiscordApiError, DiscordClient } from '../discord/client'
import type { DiscordChannel, DiscordMessage } from '../discord/types'

type SmokePostOptions = {
  channelId?: string
  content?: string
}

export type SmokePostResult =
  | {
      ok: true
      channel: DiscordChannel
      message: DiscordMessage
      content: string
    }
  | {
      ok: false
      error: string
      hint?: string
    }

const DEFAULT_SMOKE_CONTENT = 'Warrunner dogfood smoke check: Discord write path is live.'

const POSTABLE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12])

const CHANNEL_TYPES: Record<number, string> = {
  0: 'guild_text',
  5: 'guild_announcement',
  10: 'announcement_thread',
  11: 'public_thread',
  12: 'private_thread',
  15: 'guild_forum',
  16: 'guild_media'
}

export async function runSmokePost(
  config: AppConfig = loadConfig(),
  opts: SmokePostOptions = {}
): Promise<SmokePostResult> {
  const channelId = opts.channelId?.trim()
  if (!channelId) {
    return {
      ok: false,
      error: 'missing_smoke_channel_id',
      hint: 'Pass a channel or thread id, or set WARRUNNER_DOGFOOD_SMOKE_CHANNEL_ID.'
    }
  }

  const content = opts.content?.trim() || DEFAULT_SMOKE_CONTENT
  const discord = new DiscordClient(config)
  try {
    await discord.fetchCurrentUser()
    const channel = await discord.fetchChannel(channelId)
    if (!POSTABLE_CHANNEL_TYPES.has(channel.type)) {
      return {
        ok: false,
        error: `channel_not_postable:${channelTypeName(channel.type)}`,
        hint: 'Use a text channel, announcement channel, or an existing thread id. Forum channel ids cannot receive messages directly.'
      }
    }
    const message = await discord.createMessage(channel.id, {
      content,
      allowed_mentions: { parse: [] }
    })
    return { ok: true, channel, message, content }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DiscordApiError
          ? `discord_${error.status}:${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
      hint: 'Check DISCORD_BOT_TOKEN, target channel id, and bot send-message permissions.'
    }
  }
}

export function formatSmokePost(result: SmokePostResult): string {
  if (!result.ok) {
    const hint = result.hint ? `\n      ${result.hint}` : ''
    return `FAIL Discord smoke post: ${result.error}${hint}`
  }
  const channelName = result.channel.name ? `#${result.channel.name}` : result.channel.id
  return [
    `PASS Discord smoke post: ${channelName} (${result.channel.id})`,
    `PASS message id: ${result.message.id}`,
    `PASS content: ${result.content}`
  ].join('\n')
}

function channelTypeName(type: number): string {
  return CHANNEL_TYPES[type] ?? `type_${type}`
}
