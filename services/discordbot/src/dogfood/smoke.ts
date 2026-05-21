import { loadConfig, type AppConfig } from '../config'
import { DiscordApiError, DiscordClient } from '../discord/client'
import type { DiscordChannel, DiscordMessage } from '../discord/types'

type SmokePostOptions = {
  channelId?: string
  content?: string
  appliedTagIds?: string[]
}

export type SmokePostResult =
  | {
      ok: true
      channel: DiscordChannel
      createdThread?: DiscordChannel
      message?: DiscordMessage
      content: string
    }
  | {
      ok: false
      error: string
      hint?: string
    }

const DEFAULT_SMOKE_CONTENT = 'Warrunner dogfood smoke check: Discord write path is live.'
const DEFAULT_SMOKE_THREAD_NAME = 'Warrunner dogfood smoke'

const POSTABLE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12])
const FORUM_CHANNEL_TYPES = new Set([15, 16])

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
    if (FORUM_CHANNEL_TYPES.has(channel.type)) {
      const createdThread = await discord.createForumThread(channel.id, {
        name: DEFAULT_SMOKE_THREAD_NAME,
        message: {
          content,
          allowed_mentions: { parse: [] }
        },
        ...((opts.appliedTagIds ?? []).length ? { applied_tags: opts.appliedTagIds } : {})
      })
      return { ok: true, channel, createdThread, message: createdThread.message, content }
    }
    if (!POSTABLE_CHANNEL_TYPES.has(channel.type)) {
      return {
        ok: false,
        error: `channel_not_postable:${channelTypeName(channel.type)}`,
        hint: 'Use a text channel, announcement channel, existing thread id, forum channel, or media channel.'
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
  if (result.createdThread) {
    const threadName = result.createdThread.name ?? result.createdThread.id
    const messageId = result.message?.id ?? '(created with thread)'
    return [
      `PASS Discord smoke forum thread: ${channelName} -> ${threadName} (${result.createdThread.id})`,
      `PASS message id: ${messageId}`,
      `PASS content: ${result.content}`
    ].join('\n')
  }
  return [
    `PASS Discord smoke post: ${channelName} (${result.channel.id})`,
    `PASS message id: ${result.message?.id ?? '(missing)'}`,
    `PASS content: ${result.content}`
  ].join('\n')
}

function channelTypeName(type: number): string {
  return CHANNEL_TYPES[type] ?? `type_${type}`
}
