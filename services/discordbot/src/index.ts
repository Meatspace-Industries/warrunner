import { ulid } from '@std/ulid'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { prettyJSON } from 'hono/pretty-json'
import { requestId } from 'hono/request-id'
import { timeout } from 'hono/timeout'
import { CentaurHandoff } from './centaur/handoff'
import { startFinalDeliveryPoller } from './centaur/final-delivery'
import { centaurApiKey, loadConfig } from './config'
import { DiscordChannelResolver, DiscordClient } from './discord/client'
import { startDiscordGateway } from './discord/gateway'
import { normalizeDiscordMessage } from './discord/normalize'
import type { DiscordGatewayPayload, DiscordMessage } from './discord/types'
import { logError, logInfo, logWarn } from './logging'

const config = loadConfig()
const discord = new DiscordClient(config)
const channels = new DiscordChannelResolver(discord)
const handoff = new CentaurHandoff(config)

type Variables = {
  requestId: string
}

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void
}

export const app = new Hono<{ Variables: Variables }>()
  .use(prettyJSON())
  .use('*', async (c, next) => {
    await next()
    if (config.NODE_ENV !== 'test') {
      logInfo('http_request', c.req.method, c.req.path, c.res.status)
    }
  })
  .use('*', timeout(5_000))
  .use(
    requestId({
      headerName: 'X-Discordbot-Request-ID',
      generator: () => ulid()
    })
  )

app
  .get('/health', c =>
    c.json({
      ok: true,
      service: 'discordbot',
      commit: process.env.COMMIT_SHA ?? 'local',
      gateway_enabled: config.DISCORD_GATEWAY_ENABLED,
      discord_configured: Boolean(config.DISCORD_BOT_TOKEN),
      centaur_configured: Boolean(centaurApiKey(config))
    })
  )
  .get('/health/ready', c => c.redirect('/health'))

const apiKeyMiddleware: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
  if (!config.DISCORDBOT_API_KEY) {
    return c.json({ ok: false, error: 'discordbot_api_key_not_configured' }, 503)
  }
  const authorization = c.req.header('authorization') ?? ''
  if (authorization !== `Bearer ${config.DISCORDBOT_API_KEY}`) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  await next()
}

app.post('/api/discord/events', apiKeyMiddleware, async c => {
  const body = await c.req.json<DiscordGatewayPayload | DiscordMessage>()
  const message = unwrapMessageCreate(body)
  if (!message) return c.json({ ok: false, error: 'unsupported_discord_event' }, 400)
  runInBackground(c, processDiscordMessage(message))
  return c.json({ ok: true })
})

app.post('/api/discord/messages', apiKeyMiddleware, async c => {
  const body = await c.req.json<{ channel_id: string; content: string }>()
  if (!body.channel_id || !body.content) {
    return c.json({ ok: false, error: 'missing_channel_id_or_content' }, 400)
  }
  const response = await discord.createMessage(body.channel_id, {
    content: body.content,
    allowed_mentions: { parse: [] }
  })
  return c.json({ ok: true, channel_id: response.channel_id, id: response.id })
})

startFinalDeliveryPoller(config, discord)
startDiscordGateway({
  config,
  client: discord,
  channelResolver: channels,
  onMessage: processDiscordMessage
})

export default {
  port: config.PORT,
  fetch: app.fetch
}

async function processDiscordMessage(message: DiscordMessage): Promise<void> {
  const parentChannelId = await parentChannelIdFor(message)
  const shallow = normalizeDiscordMessage({
    message,
    config,
    parentChannelId
  })
  if (!shallow) return

  const historyMessages =
    config.WARRUNNER_HISTORY_LIMIT > 0
      ? await discord
          .fetchMessages({
            channelId: message.channel_id,
            before: message.id,
            limit: config.WARRUNNER_HISTORY_LIMIT
          })
          .catch(error => {
            logWarn('discord_history_fetch_failed', error)
            return []
          })
      : []
  const normalized = normalizeDiscordMessage({
    message,
    config,
    parentChannelId,
    historyMessages
  })
  if (!normalized) return

  const result = await handoff.emit(normalized)
  if (!result.ok) {
    logError('centaur_handoff_failed', {
      status: result.status,
      body: result.body,
      thread_key: normalized.thread_key
    })
  }
}

async function parentChannelIdFor(message: DiscordMessage): Promise<string | undefined> {
  try {
    return await channels.parentChannelId(message.channel_id)
  } catch (error) {
    logWarn('discord_channel_parent_lookup_failed', {
      channel_id: message.channel_id,
      error
    })
    return undefined
  }
}

function unwrapMessageCreate(body: DiscordGatewayPayload | DiscordMessage): DiscordMessage | null {
  if ('op' in body && body.t === 'MESSAGE_CREATE' && isDiscordMessage(body.d)) return body.d
  return isDiscordMessage(body) ? body : null
}

function isDiscordMessage(value: unknown): value is DiscordMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DiscordMessage>
  return typeof candidate.id === 'string' && typeof candidate.channel_id === 'string'
}

function runInBackground(c: Context, promise: Promise<void>): void {
  const guarded = promise.catch((error: unknown) => {
    logError('discord_event_processing_failed', error)
  })
  const executionCtx = getExecutionContext(c)
  if (executionCtx) {
    executionCtx.waitUntil(guarded)
    return
  }
  void guarded
}

function getExecutionContext(c: Context): WaitUntilContext | null {
  try {
    return c.executionCtx
  } catch {
    return null
  }
}
