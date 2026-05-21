import { pollFinalDeliveriesOnce } from '../centaur/final-delivery'
import { CentaurHandoff, type CentaurHandoffResult } from '../centaur/handoff'
import { homeChannelIds, loadConfig, type AppConfig } from '../config'
import { DiscordChannelResolver, DiscordClient } from '../discord/client'
import { startDiscordGateway, type DiscordGatewayHandle } from '../discord/gateway'
import { createDiscordMessageProcessor, type DiscordHandoff } from '../discord/process'
import type { DiscordChannel, DiscordMessage, NormalizedDiscordEvent } from '../discord/types'
import { runSmokePost, type SmokePostResult } from './smoke'

type LiveDogfoodOptions = {
  channelId?: string
  content?: string
  appliedTagIds?: string[]
  timeoutMs?: number
  pollIntervalMs?: number
  onProgress?: (line: string) => void
}

type LiveTarget = {
  requestedChannelId: string
  channel: DiscordChannel
  conversationChannelId: string
  createdThread?: DiscordChannel
  setupMessage?: DiscordMessage
}

type ObservedReply = {
  channelId: string
  content: string
  message: DiscordMessage
}

export type LiveDogfoodResult =
  | {
      ok: true
      target: LiveTarget
      observedEvent: NormalizedDiscordEvent
      handoff: CentaurHandoffResult
      reply: ObservedReply
    }
  | {
      ok: false
      target?: LiveTarget
      observedEvent?: NormalizedDiscordEvent
      error: string
      hint?: string
    }

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

export async function runLiveDogfood(
  config: AppConfig = loadConfig(),
  opts: LiveDogfoodOptions = {}
): Promise<LiveDogfoodResult> {
  if (!config.DISCORD_GATEWAY_ENABLED) {
    return {
      ok: false,
      error: 'discord_gateway_disabled',
      hint: 'Set DISCORD_GATEWAY_ENABLED=true for live Discord-window dogfooding.'
    }
  }

  const requestedChannelId = selectTargetChannelId(config, opts.channelId)
  if (!requestedChannelId) {
    return {
      ok: false,
      error: 'missing_live_channel_id',
      hint:
        'Pass a channel id, set WARRUNNER_DOGFOOD_SMOKE_CHANNEL_ID, or configure a Warrunner home forum/home channel.'
    }
  }

  const timeoutMs = positiveInt(opts.timeoutMs) ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = positiveInt(opts.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS
  const discord = new ObservingDiscordClient(config)
  let gatewayHandle: DiscordGatewayHandle | null = null
  let target: LiveTarget | undefined
  let observed: { event: NormalizedDiscordEvent; handoff: CentaurHandoffResult } | null = null
  const startedAt = Date.now()

  try {
    const botUser = await discord.fetchCurrentUser()
    if (!config.DISCORD_BOT_USER_ID?.trim() && !config.DISCORD_APPLICATION_ID?.trim() && botUser.id) {
      config.DISCORD_BOT_USER_ID = botUser.id
    }

    const requestedChannel = await discord.fetchChannel(requestedChannelId)
    const route = liveRouteStatus(config, requestedChannel)
    if (!route.ok) {
      return {
        ok: false,
        error: `live_target_not_routable:${requestedChannel.id}`,
        hint: route.hint
      }
    }

    let resolveObserved: (value: {
      event: NormalizedDiscordEvent
      handoff: CentaurHandoffResult
    }) => void = () => {}
    const observedPromise = new Promise<{
      event: NormalizedDiscordEvent
      handoff: CentaurHandoffResult
    }>(resolve => {
      resolveObserved = resolve
    })
    const targetId = () => target?.conversationChannelId ?? requestedChannelId
    const channels = new DiscordChannelResolver(discord)
    const handoff = new ObservingHandoff(
      config,
      event => event.channel_id === targetId() || event.parent_channel_id === requestedChannelId,
      value => {
        observed = value
        resolveObserved(value)
      }
    )
    gatewayHandle = startLiveGateway(config, discord, channels, handoff)
    if (!gatewayHandle) {
      return {
        ok: false,
        error: 'discord_gateway_not_started',
        hint: 'Verify DISCORD_BOT_TOKEN is set and DISCORD_GATEWAY_ENABLED=true.'
      }
    }

    const setup = await runSmokePost(config, {
      channelId: requestedChannelId,
      content: opts.content || livePrompt(botUser.id, timeoutMs),
      appliedTagIds: opts.appliedTagIds
    })
    if (!setup.ok) {
      gatewayHandle?.stop()
      return {
        ok: false,
        error: setup.error,
        hint: setup.hint
      }
    }
    target = targetFromSmoke(requestedChannelId, setup)
    opts.onProgress?.(formatLiveTarget(target, botUser.id, timeoutMs))

    discord.armReplyObserver()
    const accepted = await withTimeout(
      observedPromise,
      timeoutMs,
      `timed out waiting for a Discord message in ${target.conversationChannelId}`
    )
    observed = accepted
    opts.onProgress?.(`PASS live Discord message accepted: ${accepted.event.message_id}`)

    const reply = await waitForReply({
      config,
      discord,
      channelId: accepted.event.channel_id,
      timeoutMs: remainingTimeout(timeoutMs, startedAt),
      pollIntervalMs
    })
    opts.onProgress?.(`PASS live Discord reply observed: ${reply.message.id}`)

    return { ok: true, target, observedEvent: accepted.event, handoff: accepted.handoff, reply }
  } catch (error) {
    return {
      ok: false,
      target,
      observedEvent: observed?.event,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Keep this command running while you send a real message in Discord. Verify Centaur workers can produce final deliveries.'
    }
  } finally {
    gatewayHandle?.stop()
  }
}

export function formatLiveDogfood(result: LiveDogfoodResult): string {
  if (!result.ok) {
    const hint = result.hint ? `\n      ${result.hint}` : ''
    const event = result.observedEvent ? `\nPASS live Discord message accepted: ${result.observedEvent.message_id}` : ''
    return `FAIL live Discord chat loop: ${result.error}${event}${hint}`
  }

  const target = result.target.createdThread
    ? `${channelLabel(result.target.channel)} -> ${result.target.createdThread.name ?? result.target.createdThread.id} (${result.target.conversationChannelId})`
    : `${channelLabel(result.target.channel)} (${result.target.conversationChannelId})`
  return [
    'PASS live Discord chat loop completed',
    `PASS target: ${target}`,
    `PASS workflow handoff: ${result.handoff.status}`,
    `PASS normalized user text: ${result.observedEvent.parts[0]?.text ?? '(missing)'}`,
    `PASS Discord reply posted: ${result.reply.message.id}`,
    `PASS reply preview: ${result.reply.content.slice(0, 160)}`
  ].join('\n')
}

class ObservingHandoff extends CentaurHandoff implements DiscordHandoff {
  readonly isTarget: (event: NormalizedDiscordEvent) => boolean
  readonly onAccepted: (value: {
    event: NormalizedDiscordEvent
    handoff: CentaurHandoffResult
  }) => void

  constructor(
    config: AppConfig,
    isTarget: (event: NormalizedDiscordEvent) => boolean,
    onAccepted: (value: { event: NormalizedDiscordEvent; handoff: CentaurHandoffResult }) => void
  ) {
    super(config)
    this.isTarget = isTarget
    this.onAccepted = onAccepted
  }

  override async emit(event: NormalizedDiscordEvent): Promise<CentaurHandoffResult> {
    const result = await super.emit(event)
    if (result.ok && this.isTarget(event)) {
      this.onAccepted({ event, handoff: result })
    }
    return result
  }
}

class ObservingDiscordClient extends DiscordClient {
  readonly observedReplies: ObservedReply[] = []
  replyObserverArmed = false

  armReplyObserver(): void {
    this.replyObserverArmed = true
  }

  override async createMessage(
    channelId: string,
    body: { content: string; allowed_mentions?: { parse: string[] } }
  ): Promise<DiscordMessage> {
    const message = await super.createMessage(channelId, body)
    if (this.replyObserverArmed) {
      this.observedReplies.push({
        channelId,
        content: body.content,
        message
      })
    }
    return message
  }
}

function startLiveGateway(
  config: AppConfig,
  discord: DiscordClient,
  channels: DiscordChannelResolver,
  handoff: DiscordHandoff
): DiscordGatewayHandle | null {
  return startDiscordGateway({
    config,
    client: discord,
    channelResolver: channels,
    onMessage: createDiscordMessageProcessor({ config, discord, channels, handoff })
  })
}

async function waitForReply(opts: {
  config: AppConfig
  discord: ObservingDiscordClient
  channelId: string
  timeoutMs: number
  pollIntervalMs: number
}): Promise<ObservedReply> {
  const started = Date.now()
  while (Date.now() - started < opts.timeoutMs) {
    await pollFinalDeliveriesOnce(opts.config, opts.discord)
    const reply = opts.discord.observedReplies.find(item => item.channelId === opts.channelId)
    if (reply) return reply
    await sleep(opts.pollIntervalMs)
  }
  throw new Error(`timed out waiting for a Discord final-delivery reply in ${opts.channelId}`)
}

function selectTargetChannelId(config: AppConfig, channelId: string | undefined): string | undefined {
  return firstNonEmpty(
    channelId,
    process.env.WARRUNNER_DOGFOOD_SMOKE_CHANNEL_ID,
    config.WARRUNNER_HOME_FORUM_CHANNEL_ID,
    config.WARRUNNER_HOME_CHANNEL_ID,
    config.WARRUNNER_HOME_CHANNEL_IDS[0],
    config.WARRUNNER_INTAKE_CHANNEL_IDS[0]
  )
}

function liveRouteStatus(
  config: AppConfig,
  channel: DiscordChannel
): { ok: true; detail: string } | { ok: false; hint: string } {
  const homeIds = homeChannelIds(config)
  const intakeIds = new Set(config.WARRUNNER_INTAKE_CHANNEL_IDS)
  if (!homeIds.size && !intakeIds.size) {
    return { ok: true, detail: 'no route filter configured' }
  }

  const channelId = channel.id.trim()
  const parentId = channel.parent_id?.trim()
  if (parentId && homeIds.has(parentId)) {
    return { ok: true, detail: `parent forum ${parentId} is configured as home` }
  }
  if (homeIds.has(channelId)) {
    return { ok: true, detail: `${channelId} is configured as home` }
  }
  if (intakeIds.has(channelId)) {
    return { ok: true, detail: `${channelId} is configured as intake` }
  }

  if (parentId) {
    return {
      ok: false,
      hint: [
        `The target is a thread whose parent ${parentId} is not configured.`,
        `Set WARRUNNER_HOME_FORUM_CHANNEL_ID=${parentId} or include the thread id in WARRUNNER_HOME_CHANNEL_IDS.`
      ].join(' ')
    }
  }
  if (channel.type === 15 || channel.type === 16) {
    return {
      ok: false,
      hint: [
        'The target forum/media channel is not configured.',
        `Set WARRUNNER_HOME_FORUM_CHANNEL_ID=${channelId} or include it in WARRUNNER_HOME_CHANNEL_IDS.`
      ].join(' ')
    }
  }
  return {
    ok: false,
    hint: `The target channel is not configured. Add ${channelId} to WARRUNNER_HOME_CHANNEL_IDS or WARRUNNER_INTAKE_CHANNEL_IDS.`
  }
}

function targetFromSmoke(requestedChannelId: string, result: Extract<SmokePostResult, { ok: true }>): LiveTarget {
  return {
    requestedChannelId,
    channel: result.channel,
    conversationChannelId: result.createdThread?.id ?? result.channel.id,
    ...(result.createdThread ? { createdThread: result.createdThread } : {}),
    ...(result.message ? { setupMessage: result.message } : {})
  }
}

function livePrompt(botUserId: string | undefined, timeoutMs: number): string {
  const mention = botUserId ? `<@${botUserId}>` : '@Warrunner'
  const seconds = Math.round(timeoutMs / 1_000)
  return [
    'Warrunner live dogfood is listening.',
    `Reply here with a real request from Discord. In a home channel, include ${mention}.`,
    `The CLI is waiting ${seconds}s for workflow handoff and a Discord reply.`
  ].join('\n')
}

function formatLiveTarget(target: LiveTarget, botUserId: string | undefined, timeoutMs: number): string {
  const mention = botUserId ? `<@${botUserId}>` : '@Warrunner'
  const seconds = Math.round(timeoutMs / 1_000)
  if (target.createdThread) {
    return `PASS live target ready: ${channelLabel(target.channel)} -> ${target.createdThread.name ?? target.createdThread.id} (${target.conversationChannelId}); reply in that thread within ${seconds}s.`
  }
  return `PASS live target ready: ${channelLabel(target.channel)} (${target.conversationChannelId}); send a Discord message mentioning ${mention} within ${seconds}s.`
}

function channelLabel(channel: DiscordChannel): string {
  return channel.name ? `#${channel.name}` : channel.id
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function remainingTimeout(timeoutMs: number, startedAt: number): number {
  return Math.max(1_000, timeoutMs - (Date.now() - startedAt))
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
