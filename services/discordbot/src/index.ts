import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { prettyJSON } from 'hono/pretty-json'
import { requestId } from 'hono/request-id'
import { timeout } from 'hono/timeout'
import { CentaurHandoff } from './centaur/handoff'
import { startFinalDeliveryPoller } from './centaur/final-delivery'
import { centaurApiKey, loadConfig } from './config'
import { DiscordChannelResolver, DiscordClient } from './discord/client'
import { startDiscordGateway } from './discord/gateway'
import { createDiscordMessageProcessor } from './discord/process'
import type { DiscordGatewayPayload, DiscordMessage } from './discord/types'
import { logError, logInfo, logWarn } from './logging'
import {
  buildReadinessReport,
  initialBotIdentityState,
  type BotIdentityState
} from './readiness'

const config = loadConfig()
const discord = new DiscordClient(config)
const channels = new DiscordChannelResolver(discord)
const handoff = new CentaurHandoff(config)
const processDiscordMessage = createDiscordMessageProcessor({
  config,
  discord,
  channels,
  handoff
})
const botIdentityState: BotIdentityState = initialBotIdentityState(config)
const botIdentityReady = hydrateBotUserId()

async function processReadyDiscordMessage(message: DiscordMessage): Promise<void> {
  await botIdentityReady
  await processDiscordMessage(message)
}

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
      generator: () => crypto.randomUUID()
    })
  )

app
  .get('/health', c => {
    const readiness = buildReadinessReport(config, botIdentityState)
    return c.json({
      ok: true,
      service: 'discordbot',
      commit: process.env.COMMIT_SHA ?? 'local',
      ready: readiness.ready,
      gateway_enabled: config.DISCORD_GATEWAY_ENABLED,
      discord_configured: Boolean(config.DISCORD_BOT_TOKEN),
      centaur_configured: Boolean(centaurApiKey(config)),
      checks: readiness.checks,
      bot_identity: readiness.bot_identity
    })
  })
  .get('/health/ready', c => {
    const readiness = buildReadinessReport(config, botIdentityState)
    return c.json(
      { ok: readiness.ready, service: 'discordbot', ...readiness },
      readiness.ready ? 200 : 503
    )
  })

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
  runInBackground(c, processReadyDiscordMessage(message))
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
  onMessage: processReadyDiscordMessage
})

export default {
  port: config.PORT,
  fetch: app.fetch
}

async function hydrateBotUserId(): Promise<void> {
  if (config.DISCORD_BOT_USER_ID?.trim() || !config.DISCORD_BOT_TOKEN) return
  try {
    const user = await discord.fetchCurrentUser()
    if (user.id) {
      config.DISCORD_BOT_USER_ID = user.id
      botIdentityState.status = 'ready'
      botIdentityState.id = user.id
      botIdentityState.username = user.username
      delete botIdentityState.error
      logInfo('discord_bot_identity_loaded', { id: user.id, username: user.username })
    }
  } catch (error) {
    if (botIdentityState.status !== 'configured') {
      botIdentityState.status = 'failed'
    }
    botIdentityState.error = error instanceof Error ? error.message : String(error)
    logWarn('discord_bot_identity_load_failed', error)
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
