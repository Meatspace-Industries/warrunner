import { homeChannelIds, type AppConfig } from '../config'
import type {
  DiscordHistoryMessage,
  DiscordMessage,
  NormalizedDiscordEvent,
  NormalizedPart
} from './types'

export function normalizeDiscordMessage(opts: {
  message: DiscordMessage
  config: AppConfig
  parentChannelId?: string
  historyMessages?: DiscordMessage[]
}): NormalizedDiscordEvent | null {
  const message = opts.message
  if (!message.id || !message.channel_id || !message.guild_id) return null
  if (!message.author?.id || message.author.bot || message.webhook_id) return null
  if (opts.config.DISCORD_GUILD_ID && message.guild_id !== opts.config.DISCORD_GUILD_ID) return null
  const isMention = mentionsBot(message, opts.config)
  if (!isAllowedRoute(opts.config, message.channel_id, opts.parentChannelId, isMention)) return null
  if (!isAllowedMember(opts.config, message.member?.roles ?? [])) return null

  const parts = partsFromDiscordMessage(message, opts.config)
  if (!parts.length) return null

  const parentChannelId = opts.parentChannelId?.trim() || undefined
  const history = normalizeDiscordHistory(opts.historyMessages ?? [], {
    currentMessageId: message.id,
    config: opts.config,
    guildId: message.guild_id,
    channelId: message.channel_id
  })

  return {
    thread_key: `discord:${message.guild_id}:${parentChannelId ?? message.channel_id}:${message.channel_id}`,
    message_id: `discord:${message.guild_id}:${message.channel_id}:${message.id}`,
    guild_id: message.guild_id,
    channel_id: message.channel_id,
    ...(parentChannelId ? { parent_channel_id: parentChannelId } : {}),
    user_id: message.author.id,
    parts,
    ...(history.length ? { history_messages: history } : {}),
    discord: {
      message_id: message.id,
      channel_id: message.channel_id,
      ...(parentChannelId ? { parent_channel_id: parentChannelId } : {}),
      guild_id: message.guild_id,
      is_mention: isMention
    }
  }
}

export function normalizeDiscordHistory(
  messages: DiscordMessage[],
  opts: { currentMessageId: string; config: AppConfig; guildId?: string; channelId?: string }
): DiscordHistoryMessage[] {
  const history: DiscordHistoryMessage[] = []
  for (const message of messages) {
    if (!message.id || message.id === opts.currentMessageId) continue
    const guildId = message.guild_id ?? opts.guildId
    const channelId = message.channel_id ?? opts.channelId
    if (!guildId || !channelId || !message.author?.id) continue
    if (message.webhook_id) continue
    const parts = partsFromDiscordMessage(message, opts.config)
    if (!parts.length) continue
    history.push({
      message_id: `discord:${guildId}:${channelId}:${message.id}`,
      role: message.author.bot ? 'assistant' : 'user',
      parts,
      user_id: message.author.id,
      metadata: {
        platform: 'discord',
        history_backfill: true
      }
    })
  }
  return history
}

function isAllowedRoute(
  config: AppConfig,
  channelId: string,
  parentChannelId: string | undefined,
  isMention: boolean
): boolean {
  const homeIds = homeChannelIds(config)
  const intakeIds = new Set(config.WARRUNNER_INTAKE_CHANNEL_IDS)
  if (isMention) {
    return true
  }
  if (!homeIds.size && !intakeIds.size) return false
  if (parentChannelId && homeIds.has(parentChannelId)) return true
  if (homeIds.has(channelId)) {
    return (
      !config.WARRUNNER_REQUIRE_HOME_THREAD ||
      !config.WARRUNNER_HOME_CHANNEL_MENTION_REQUIRED ||
      isMention
    )
  }
  if (intakeIds.has(channelId)) return true
  return false
}

function isAllowedMember(config: AppConfig, memberRoleIds: string[]): boolean {
  const allowedRoleIds = new Set(config.WARRUNNER_ALLOWED_ROLE_IDS)
  if (!allowedRoleIds.size) return true
  return memberRoleIds.some(roleId => allowedRoleIds.has(roleId))
}

function partsFromDiscordMessage(message: DiscordMessage, config: AppConfig): NormalizedPart[] {
  const parts: NormalizedPart[] = []
  const text = normalizeDiscordText(message.content ?? '', config)
  const attachmentLines = attachmentText(message)
  const combined = [text, attachmentLines].filter(Boolean).join('\n\n').trim()
  if (combined) parts.push({ type: 'text', text: combined })
  return parts
}

export function normalizeDiscordText(input: string, config: AppConfig): string {
  let text = input
  for (const botId of botMentionIds(config)) {
    text = text.replaceAll(`<@${botId}>`, '').replaceAll(`<@!${botId}>`, '')
  }
  for (const roleId of botRoleMentionIds(config)) {
    text = text.replaceAll(`<@&${roleId}>`, '')
  }
  return text
    .replace(/<#(\d+)>/g, '#$1')
    .replace(/<@!?(\d+)>/g, '@$1')
    .replace(/<@&(\d+)>/g, '@role:$1')
    .replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ':$1:')
    .trim()
}

function mentionsBot(message: DiscordMessage, config: AppConfig): boolean {
  const ids = botMentionIds(config)
  const roleIds = botRoleMentionIds(config)
  if (!ids.length && !roleIds.length) return false
  if (message.mentions?.some(user => ids.includes(user.id))) return true
  if (message.mention_roles?.some(roleId => roleIds.includes(roleId))) return true
  const content = message.content ?? ''
  if (
    !message.mentions &&
    ids.some(id => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`))
  ) {
    return true
  }
  if (!message.mention_roles && roleIds.some(id => content.includes(`<@&${id}>`))) return true
  return false
}

function botMentionIds(config: AppConfig): string[] {
  const ids = [config.DISCORD_BOT_USER_ID, config.DISCORD_APPLICATION_ID]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
  return [...new Set(ids)]
}

function botRoleMentionIds(config: AppConfig): string[] {
  return [...new Set(config.WARRUNNER_MENTION_ROLE_IDS.map(value => value.trim()).filter(Boolean))]
}

function attachmentText(message: DiscordMessage): string {
  const attachments = message.attachments ?? []
  if (!attachments.length) return ''
  const lines = attachments
    .map(attachment => {
      const name = attachment.filename || attachment.id
      const url = attachment.url || attachment.proxy_url || ''
      return url ? `Attachment: ${name} (${url})` : `Attachment: ${name}`
    })
    .filter(Boolean)
  return lines.join('\n')
}
