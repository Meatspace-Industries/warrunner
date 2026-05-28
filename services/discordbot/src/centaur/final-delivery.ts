import { centaurApiKey, mentionUserAliases, normalizeMentionAlias, type AppConfig } from '../config'
import { DiscordApiError, DiscordClient } from '../discord/client'
import type { DiscordTypingIndicator } from '../discord/typing'
import type {
  DiscordAllowedMentions,
  DiscordCreateMessageBody,
  DiscordMessage,
  DiscordMessageReference
} from '../discord/types'
import { logError } from '../logging'

const CONSUMER_ID = `discordbot-${process.pid}`
const FINAL_DELIVERY_CHUNK_CHARS = 1900
const DISCORD_USER_ID_RE = /^\d{1,32}$/
const DISCORD_USER_MENTION_RE = /<@!?(\d{1,32})>/g
const ALIAS_MENTION_RE = /(^|[\s([{"'])@([A-Za-z][A-Za-z0-9_.-]{0,63})\b/g
const NON_RETRYABLE_DISCORD_ERRORS = new Set([
  'missing_discord_delivery_target',
  'discord_forbidden',
  'discord_not_found',
  'discord_bad_request',
  'invalid_destination',
  'restricted_destination',
  'invalid_payload'
])

export type DeliveredFinalDelivery = {
  executionId: string
  messages: DiscordMessage[]
}

export type FailedFinalDelivery = {
  executionId: string
  error: string
  errorClass?: string
  channelId?: string
  guildId?: string
  messageId?: string
}

export type FinalDeliveryPollResult = {
  claimed: number
  delivered: DeliveredFinalDelivery[]
  failed: FailedFinalDelivery[]
}

export function startFinalDeliveryPoller(
  config: AppConfig,
  client: DiscordClient,
  typing?: DiscordTypingIndicator
): void {
  if (!centaurApiKey(config)) return
  const tick = async () => {
    try {
      await pollFinalDeliveriesOnce(config, client, typing)
    } catch (error) {
      logError('final_delivery_poll_failed', error)
    }
  }
  setInterval(tick, 2_000).unref?.()
  void tick()
}

export async function pollFinalDeliveriesOnce(
  config: AppConfig,
  client: DiscordClient,
  typing?: DiscordTypingIndicator
): Promise<FinalDeliveryPollResult> {
  const claimed = await centaur(config, '/agent/final-deliveries/claim', {
    consumer_id: CONSUMER_ID,
    platform: 'discord',
    limit: 5,
    lease_seconds: 60
  })
  const deliveries = Array.isArray(claimed.deliveries) ? claimed.deliveries : []
  const result: FinalDeliveryPollResult = {
    claimed: deliveries.length,
    delivered: [],
    failed: []
  }
  for (const delivery of deliveries) {
    const executionId = String(delivery.execution_id)
    const target = targetFromDelivery(delivery)
    try {
      const messages = await deliver(config, client, delivery, target)
      await centaur(
        config,
        `/agent/final-deliveries/${encodeURIComponent(executionId)}/delivered`,
        { consumer_id: CONSUMER_ID },
        delivery
      )
      result.delivered.push({ executionId, messages })
    } catch (error) {
      const errorMessage = discordDeliveryErrorMessage(error)
      const errorClass = discordDeliveryErrorClass(error)
      result.failed.push({
        executionId,
        error: errorMessage,
        ...(errorClass ? { errorClass } : {}),
        ...(target.channelId ? { channelId: target.channelId } : {}),
        ...(target.guildId ? { guildId: target.guildId } : {}),
        ...(target.messageId ? { messageId: target.messageId } : {})
      })
      await centaur(
        config,
        `/agent/final-deliveries/${encodeURIComponent(executionId)}/failed`,
        {
          consumer_id: CONSUMER_ID,
          error: errorMessage,
          retry_after_seconds: 10,
          ...(errorClass ? { error_class: errorClass, non_retryable: true } : {})
        },
        delivery
      ).catch(failError => logError('final_delivery_mark_failed_failed', failError))
    } finally {
      typing?.stop({
        threadKey: cleanString(delivery.thread_key),
        channelId: target.channelId
      })
    }
  }
  return result
}

type DiscordDeliveryTarget = {
  channelId?: string
  guildId?: string
  messageId?: string
}

async function deliver(
  config: AppConfig,
  client: DiscordClient,
  delivery: any,
  target: DiscordDeliveryTarget = targetFromDelivery(delivery)
): Promise<DiscordMessage[]> {
  if (!target.channelId) throw new Error('missing_discord_delivery_target')
  const payload = delivery.final_payload ?? {}
  const text = extractText(payload)
  const prepared = prepareDiscordMessage(text, payload, config)
  const chunks = splitFinalDeliveryText(prepared.content)
  const messages: DiscordMessage[] = []
  for (const [index, chunk] of chunks.entries()) {
    const body: DiscordCreateMessageBody = {
      content: chunk,
      allowed_mentions: allowedMentionsForContent(chunk, prepared.allowedMentionUserIds)
    }
    const reference = index === 0 ? messageReferenceFromTarget(target) : undefined
    if (reference) body.message_reference = reference
    messages.push(await client.createMessage(target.channelId, body))
  }
  return messages
}

function targetFromDelivery(delivery: any): {
  channelId?: string
  guildId?: string
  messageId?: string
} {
  const meta = delivery.delivery ?? {}
  const guildId = cleanString(meta.guild_id ?? delivery.guild_id)
  const messageId = discordMessageId(
    meta.message_id ?? meta.discord_message_id ?? delivery.message_id ?? delivery.discord_message_id
  )
  const channelId = String(meta.thread_id ?? meta.channel_id ?? meta.channel ?? '').trim()
  if (channelId) return { channelId, guildId, messageId }

  const threadKey = String(delivery.thread_key ?? '')
  const parts = threadKey.split(':')
  if (parts[0] === 'discord' && parts.length >= 4) {
    return {
      channelId: parts.slice(3).join(':'),
      guildId: guildId || parts[1],
      messageId
    }
  }
  return { guildId, messageId }
}

function messageReferenceFromTarget(target: {
  channelId?: string
  guildId?: string
  messageId?: string
}): DiscordMessageReference | undefined {
  if (!target.messageId) return undefined
  return {
    message_id: target.messageId,
    ...(target.channelId ? { channel_id: target.channelId } : {}),
    ...(target.guildId ? { guild_id: target.guildId } : {}),
    fail_if_not_exists: false
  }
}

function discordMessageId(value: unknown): string | undefined {
  const text = cleanString(value)
  if (!text) return undefined
  const parts = text.split(':')
  if (parts[0] === 'discord' && parts.length >= 4) return parts.at(-1)?.trim() || undefined
  return text
}

function cleanString(value: unknown): string | undefined {
  const text = value === undefined || value === null ? '' : String(value).trim()
  return text || undefined
}

function extractText(payload: any): string {
  const value = firstNonEmpty(
    payload?.result_text,
    payload?.result,
    payload?.text,
    payload?.final_text,
    payload?.message
  )
  if (value) return value

  const executionId = String(payload?.execution_id ?? '').trim()
  const suffix = executionId ? ` Execution: ${executionId}.` : ''
  return `Execution completed, but no final text was captured.${suffix}`
}

function prepareDiscordMessage(
  content: string,
  payload: any,
  config: AppConfig
): { content: string; allowedMentionUserIds: string[] } {
  const payloadAllowedUsers = sanitizedAllowedMentionUserIds(payload)
  const allowedUsers = new Set(payloadAllowedUsers)
  const aliases = mentionUserAliases(config)
  const aliasUserIds = new Set(aliases.values())

  const rewritten = content.replace(ALIAS_MENTION_RE, (full, prefix: string, alias: string) => {
    const userId = aliases.get(normalizeMentionAlias(alias))
    if (!userId) return full
    allowedUsers.add(userId)
    return `${prefix}<@${userId}>`
  })

  for (const userId of rawMentionUserIds(rewritten)) {
    if (allowedUsers.has(userId) || aliasUserIds.has(userId)) {
      allowedUsers.add(userId)
    }
  }

  return {
    content: rewritten,
    allowedMentionUserIds: [...allowedUsers]
  }
}

function allowedMentionsForContent(
  content: string,
  allowedMentionUserIds: string[]
): DiscordAllowedMentions {
  const allowed = new Set(allowedMentionUserIds)
  return allowedMentionsFromUserIds(rawMentionUserIds(content).filter(userId => allowed.has(userId)))
}

function allowedMentionsFromUserIds(userIds: unknown[]): DiscordAllowedMentions {
  const users = uniqueStrings(userIds)
    .map(userId => userId.trim())
    .filter(userId => DISCORD_USER_ID_RE.test(userId))
    .slice(0, 100)
  return users.length > 0 ? { parse: [], users } : { parse: [] }
}

function sanitizedAllowedMentionUserIds(payload: any): string[] {
  return allowedMentionsFromUserIds(allowedMentionUserIds(payload)).users ?? []
}

function allowedMentionUserIds(payload: any): unknown[] {
  if (Array.isArray(payload?.allowed_mention_user_ids)) {
    return payload.allowed_mention_user_ids
  }
  if (Array.isArray(payload?.allowed_mentions?.users)) {
    return payload.allowed_mentions.users
  }
  return []
}

function rawMentionUserIds(content: string): string[] {
  return [...content.matchAll(DISCORD_USER_MENTION_RE)].flatMap(match => (match[1] ? [match[1]] : []))
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = cleanString(value)
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text) return text
  }
  return ''
}

export function splitFinalDeliveryText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const chunks: string[] = []
  let remaining = trimmed
  while (remaining.length > FINAL_DELIVERY_CHUNK_CHARS) {
    let splitAt = remaining.lastIndexOf('\n\n', FINAL_DELIVERY_CHUNK_CHARS)
    if (splitAt <= FINAL_DELIVERY_CHUNK_CHARS * 0.3) {
      splitAt = remaining.lastIndexOf('\n', FINAL_DELIVERY_CHUNK_CHARS)
    }
    if (splitAt <= FINAL_DELIVERY_CHUNK_CHARS * 0.3) {
      splitAt = remaining.lastIndexOf(' ', FINAL_DELIVERY_CHUNK_CHARS)
    }
    if (splitAt <= FINAL_DELIVERY_CHUNK_CHARS * 0.3) splitAt = FINAL_DELIVERY_CHUNK_CHARS
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function discordDeliveryErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function discordDeliveryErrorClass(error: unknown): string | null {
  if (error instanceof DiscordApiError) {
    if (error.status === 400) return 'discord_bad_request'
    if (error.status === 403) return 'discord_forbidden'
    if (error.status === 404) return 'discord_not_found'
  }
  const normalized = discordDeliveryErrorMessage(error).trim().toLowerCase()
  for (const errorClass of NON_RETRYABLE_DISCORD_ERRORS) {
    if (normalized.includes(errorClass)) return errorClass
  }
  return null
}

async function centaur(
  config: AppConfig,
  path: string,
  body: unknown,
  trace?: any
): Promise<any> {
  const apiKey = centaurApiKey(config)
  const response = await fetch(new URL(path, config.CENTAUR_API_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...centaurTraceHeaders(trace),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  const parsed: any = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(parsed?.detail?.message ?? parsed?.detail ?? parsed?.error ?? response.statusText)
  }
  return parsed
}

function centaurTraceHeaders(trace: any): Record<string, string> {
  const traceId = String(trace?.trace_id ?? '').trim()
  const threadKey = String(trace?.thread_key ?? '').trim()
  const traceparent = String(trace?.traceparent ?? '').trim()
  return {
    ...(traceId ? { 'X-Trace-Id': traceId } : {}),
    ...(threadKey ? { 'X-Centaur-Thread-Key': threadKey } : {}),
    ...(traceparent ? { traceparent } : {})
  }
}
