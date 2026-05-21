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
  setupMode?: LiveSetupMode
  timeoutMs?: number
  pollIntervalMs?: number
  onProgress?: (line: string) => void
}

type LiveDogfoodSessionOptions = LiveDogfoodOptions & {
  turnLimit?: number
}

type LiveSetupMode = 'prompt' | 'attach'

type LiveTarget = {
  requestedChannelId: string
  channel: DiscordChannel
  conversationChannelId: string
  discordUrl?: string
  createdThread?: DiscordChannel
  setupMessage?: DiscordMessage
}

type ObservedReplyMessage = {
  channelId: string
  content: string
  message: DiscordMessage
}

type ObservedReply = ObservedReplyMessage & {
  messages: ObservedReplyMessage[]
  source: 'final_delivery' | 'channel_history'
}

type LiveDogfoodTurn = {
  observedEvent: NormalizedDiscordEvent
  handoff: CentaurHandoffResult
  executionId?: string
  reply: ObservedReply
}

export type LiveDogfoodResult =
  | {
      ok: true
      target: LiveTarget
      observedEvent: NormalizedDiscordEvent
      handoff: CentaurHandoffResult
      executionId?: string
      reply: ObservedReply
    }
  | {
      ok: false
      target?: LiveTarget
      observedEvent?: NormalizedDiscordEvent
      error: string
      hint?: string
    }

export type LiveDogfoodSessionResult =
  | {
      ok: true
      target: LiveTarget
      turns: LiveDogfoodTurn[]
    }
  | {
      ok: false
      target?: LiveTarget
      turns: LiveDogfoodTurn[]
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
  const result = await runLiveDogfoodSession(config, { ...opts, turnLimit: 1 })
  if (!result.ok) {
    return {
      ok: false,
      ...(result.target ? { target: result.target } : {}),
      ...(result.observedEvent ? { observedEvent: result.observedEvent } : {}),
      error: result.error,
      hint: result.hint
    }
  }
  const turn = result.turns[0]
  if (!turn) {
    return {
      ok: false,
      target: result.target,
      error: 'live_chat_loop_missing_turn',
      hint: 'No completed live Discord turn was captured.'
    }
  }
  return {
    ok: true,
    target: result.target,
    observedEvent: turn.observedEvent,
    handoff: turn.handoff,
    ...(turn.executionId ? { executionId: turn.executionId } : {}),
    reply: turn.reply
  }
}

export async function runLiveDogfoodSession(
  config: AppConfig = loadConfig(),
  opts: LiveDogfoodSessionOptions = {}
): Promise<LiveDogfoodSessionResult> {
  if (!config.DISCORD_GATEWAY_ENABLED) {
    return {
      ok: false,
      turns: [],
      error: 'discord_gateway_disabled',
      hint: 'Set DISCORD_GATEWAY_ENABLED=true for live Discord-window dogfooding.'
    }
  }

  const requestedChannelId = selectTargetChannelId(config, opts.channelId)
  if (!requestedChannelId) {
    return {
      ok: false,
      turns: [],
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
  const startedAt = Date.now()
  const setupMode = opts.setupMode ?? 'prompt'
  const turns: LiveDogfoodTurn[] = []

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
        turns,
        error: `live_target_not_routable:${requestedChannel.id}`,
        hint: route.hint
      }
    }

    const targetId = () => target?.conversationChannelId ?? requestedChannelId
    const tracker = new LiveTurnTracker()
    const channels = new DiscordChannelResolver(discord)
    const handoff = new ObservingHandoff(
      config,
      event => event.channel_id === targetId() || event.parent_channel_id === requestedChannelId,
      value => {
        tracker.accept(value)
      }
    )
    gatewayHandle = startLiveGateway(config, discord, channels, handoff)
    if (!gatewayHandle) {
      return {
        ok: false,
        turns,
        error: 'discord_gateway_not_started',
        hint: 'Verify DISCORD_BOT_TOKEN is set and DISCORD_GATEWAY_ENABLED=true.'
      }
    }

    if (setupMode === 'attach') {
      if (isForumChannel(requestedChannel)) {
        gatewayHandle?.stop()
        return {
          ok: false,
          turns,
          error: `live_attach_requires_conversation_channel:${requestedChannel.id}`,
          hint: 'Pass an existing forum thread id, home channel id, or omit --attach so live dogfood can create a forum thread.'
        }
      }
      target = targetFromChannel(config, requestedChannelId, requestedChannel)
    } else {
      const setup = await runSmokePost(config, {
        channelId: requestedChannelId,
        content: opts.content || livePrompt(botUser.id, timeoutMs),
        appliedTagIds: opts.appliedTagIds
      })
      if (!setup.ok) {
        gatewayHandle?.stop()
        return {
          ok: false,
          turns,
          error: setup.error,
          hint: setup.hint
        }
      }
      target = targetFromSmoke(config, requestedChannelId, setup)
    }
    opts.onProgress?.(formatLiveTarget(target, botUser.id, timeoutMs))

    discord.armReplyObserver()
    const turnLimit = sessionTurnLimit(opts.turnLimit)
    let replyCursor = 0
    while (turns.length < turnLimit) {
      const accepted = await tracker.next(
        turns.length,
        remainingTimeout(timeoutMs, startedAt),
        `timed out waiting for Discord message ${turns.length + 1} in ${target.conversationChannelId}`
      )
      opts.onProgress?.(`PASS live Discord message accepted: ${accepted.event.message_id}`)

      const observedReply = await waitForReply({
        config,
        discord,
        channelId: accepted.event.channel_id,
        botUserId: botUser.id,
        afterMessageId: accepted.event.discord.message_id,
        executionId: accepted.executionId,
        fromIndex: replyCursor,
        timeoutMs: remainingTimeout(timeoutMs, startedAt),
        pollIntervalMs
      })
      replyCursor = observedReply.index + 1
      opts.onProgress?.(`PASS live Discord reply observed: ${observedReply.reply.message.id}`)
      turns.push({
        observedEvent: accepted.event,
        handoff: accepted.handoff,
        ...(accepted.executionId ? { executionId: accepted.executionId } : {}),
        reply: observedReply.reply
      })
    }

    return { ok: true, target, turns }
  } catch (error) {
    const lastTurn = turns.at(-1)
    return {
      ok: false,
      turns,
      target,
      observedEvent: lastTurn?.observedEvent,
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
    ...(result.target.discordUrl ? [`PASS Discord URL: ${result.target.discordUrl}`] : []),
    `PASS workflow handoff: ${result.handoff.status}`,
    ...(result.executionId ? [`PASS workflow execution: ${result.executionId}`] : []),
    `PASS normalized user text: ${result.observedEvent.parts[0]?.text ?? '(missing)'}`,
    `PASS Discord reply posted: ${result.reply.message.id}`,
    ...(result.reply.messages.length > 1
      ? [`PASS Discord reply messages: ${result.reply.messages.map(reply => reply.message.id).join(', ')}`]
      : []),
    `PASS Discord reply source: ${result.reply.source}`,
    `PASS reply preview: ${result.reply.content.slice(0, 160)}`
  ].join('\n')
}

export function formatLiveDogfoodSession(result: LiveDogfoodSessionResult): string {
  if (!result.ok) {
    const hint = result.hint ? `\n      ${result.hint}` : ''
    const completed = result.turns.length ? `\nPASS live session turns completed: ${result.turns.length}` : ''
    return `FAIL live Discord dogfood session: ${result.error}${completed}${hint}`
  }
  const target = result.target.createdThread
    ? `${channelLabel(result.target.channel)} -> ${result.target.createdThread.name ?? result.target.createdThread.id} (${result.target.conversationChannelId})`
    : `${channelLabel(result.target.channel)} (${result.target.conversationChannelId})`
  return [
    'PASS live Discord dogfood session completed',
    `PASS target: ${target}`,
    ...(result.target.discordUrl ? [`PASS Discord URL: ${result.target.discordUrl}`] : []),
    `PASS turns completed: ${result.turns.length}`,
    ...result.turns.map((turn, index) => {
      const text = turn.observedEvent.parts[0]?.text ?? '(missing)'
      const messageCount =
        turn.reply.messages.length > 1 ? ` (${turn.reply.messages.length} Discord messages)` : ''
      const execution = turn.executionId ? ` [${turn.executionId}]` : ''
      return `PASS turn ${index + 1}: ${text} -> ${turn.reply.message.id}${messageCount}${execution} via ${turn.reply.source}`
    })
  ].join('\n')
}

class ObservingHandoff extends CentaurHandoff implements DiscordHandoff {
  readonly isTarget: (event: NormalizedDiscordEvent) => boolean
  readonly onAccepted: (value: {
    event: NormalizedDiscordEvent
    handoff: CentaurHandoffResult
    executionId?: string
  }) => void

  constructor(
    config: AppConfig,
    isTarget: (event: NormalizedDiscordEvent) => boolean,
    onAccepted: (value: {
      event: NormalizedDiscordEvent
      handoff: CentaurHandoffResult
      executionId?: string
    }) => void
  ) {
    super(config)
    this.isTarget = isTarget
    this.onAccepted = onAccepted
  }

  override async emit(event: NormalizedDiscordEvent): Promise<CentaurHandoffResult> {
    const result = await super.emit(event)
    if (result.ok && this.isTarget(event)) {
      const executionId = handoffExecutionId(result)
      this.onAccepted({ event, handoff: result, ...(executionId ? { executionId } : {}) })
    }
    return result
  }
}

class LiveTurnTracker {
  readonly accepted: Array<{
    event: NormalizedDiscordEvent
    handoff: CentaurHandoffResult
    executionId?: string
  }> = []
  readonly waiters: Array<() => void> = []

  accept(value: {
    event: NormalizedDiscordEvent
    handoff: CentaurHandoffResult
    executionId?: string
  }): void {
    this.accepted.push(value)
    const waiters = this.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  async next(
    index: number,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<{
    event: NormalizedDiscordEvent
    handoff: CentaurHandoffResult
    executionId?: string
  }> {
    if (this.accepted[index]) return this.accepted[index]
    await withTimeout(
      new Promise<void>(resolve => {
        this.waiters.push(resolve)
      }),
      timeoutMs,
      timeoutMessage
    )
    const accepted = this.accepted[index]
    if (!accepted) throw new Error(timeoutMessage)
    return accepted
  }
}

class ObservingDiscordClient extends DiscordClient {
  readonly observedReplies: ObservedReplyMessage[] = []
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
  botUserId?: string
  afterMessageId: string
  executionId?: string
  fromIndex: number
  timeoutMs: number
  pollIntervalMs: number
}): Promise<{ reply: ObservedReply; index: number }> {
  const started = Date.now()
  while (Date.now() - started < opts.timeoutMs) {
    const deliveryResult = await pollFinalDeliveriesOnce(opts.config, opts.discord)
    for (const delivery of deliveryResult.delivered) {
      if (opts.executionId && delivery.executionId !== opts.executionId) continue
      const messageIds = delivery.messages
        .filter(message => message.channel_id === opts.channelId)
        .map(message => message.id)
      if (!messageIds.length) continue

      const indexes = messageIds
        .map(id =>
          opts.discord.observedReplies.findIndex(
            (item, index) => index >= opts.fromIndex && item.message.id === id
          )
        )
        .filter(index => index >= 0)
      if (!indexes.length) continue

      const firstIndex = Math.min(...indexes)
      const lastIndex = Math.max(...indexes)
      const reply = opts.discord.observedReplies[firstIndex]
      if (reply) {
        const messages = indexes
          .sort((left, right) => left - right)
          .map(index => opts.discord.observedReplies[index])
          .filter(message => message !== undefined)
        return { reply: { ...reply, messages, source: 'final_delivery' }, index: lastIndex }
      }
    }

    const observed = await observeBotReplyFromDiscord(opts)
    if (observed) return { reply: observed, index: opts.discord.observedReplies.length - 1 }
    await sleep(opts.pollIntervalMs)
  }
  throw new Error(`timed out waiting for a Discord final-delivery reply in ${opts.channelId}`)
}

async function observeBotReplyFromDiscord(opts: {
  discord: ObservingDiscordClient
  channelId: string
  botUserId?: string
  afterMessageId: string
}): Promise<ObservedReply | undefined> {
  const botUserId = opts.botUserId?.trim()
  if (!botUserId) return undefined

  const messages = await opts.discord
    .fetchMessages({
      channelId: opts.channelId,
      after: opts.afterMessageId,
      limit: 25
    })
    .catch(() => [])
  const locallyDeliveredIds = new Set(opts.discord.observedReplies.map(reply => reply.message.id))
  const replies = messages
    .filter(message => message.channel_id === opts.channelId)
    .filter(message => message.author?.id === botUserId)
    .filter(message => !locallyDeliveredIds.has(message.id))
    .filter(message => String(message.content ?? '').trim())
    .map(message => ({
      channelId: opts.channelId,
      content: String(message.content ?? ''),
      message
    }))

  const first = replies[0]
  if (!first) return undefined
  return { ...first, messages: replies, source: 'channel_history' }
}

function handoffExecutionId(result: CentaurHandoffResult): string | undefined {
  if (!result.ok || !isRecord(result.body)) return undefined
  const value = result.body.execution_id
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

function targetFromSmoke(
  config: AppConfig,
  requestedChannelId: string,
  result: Extract<SmokePostResult, { ok: true }>
): LiveTarget {
  const conversationChannelId = result.createdThread?.id ?? result.channel.id
  const discordUrl = discordChannelUrl(config, result, conversationChannelId)
  return {
    requestedChannelId,
    channel: result.channel,
    conversationChannelId,
    ...(discordUrl ? { discordUrl } : {}),
    ...(result.createdThread ? { createdThread: result.createdThread } : {}),
    ...(result.message ? { setupMessage: result.message } : {})
  }
}

function targetFromChannel(
  config: AppConfig,
  requestedChannelId: string,
  channel: DiscordChannel
): LiveTarget {
  const conversationChannelId = channel.id
  const discordUrl = discordChannelUrlForChannel(config, channel, conversationChannelId)
  return {
    requestedChannelId,
    channel,
    conversationChannelId,
    ...(discordUrl ? { discordUrl } : {})
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
  if (target.createdThread || isThreadChannel(target.channel)) {
    return [
      `PASS live target ready: ${conversationLabel(target)} (${target.conversationChannelId}); reply in that thread within ${seconds}s.`,
      ...(target.discordUrl ? [`PASS Discord URL: ${target.discordUrl}`] : [])
    ].join('\n')
  }
  return [
    `PASS live target ready: ${channelLabel(target.channel)} (${target.conversationChannelId}); send a Discord message mentioning ${mention} within ${seconds}s.`,
    ...(target.discordUrl ? [`PASS Discord URL: ${target.discordUrl}`] : [])
  ].join('\n')
}

function channelLabel(channel: DiscordChannel): string {
  return channel.name ? `#${channel.name}` : channel.id
}

function conversationLabel(target: LiveTarget): string {
  if (!target.createdThread) return channelLabel(target.channel)
  return `${channelLabel(target.channel)} -> ${target.createdThread.name ?? target.createdThread.id}`
}

function discordChannelUrl(
  config: AppConfig,
  result: Extract<SmokePostResult, { ok: true }>,
  channelId: string
): string | undefined {
  const guildId = result.createdThread?.guild_id ?? result.channel.guild_id ?? config.DISCORD_GUILD_ID
  return guildId ? `https://discord.com/channels/${guildId}/${channelId}` : undefined
}

function discordChannelUrlForChannel(
  config: AppConfig,
  channel: DiscordChannel,
  channelId: string
): string | undefined {
  const guildId = channel.guild_id ?? config.DISCORD_GUILD_ID
  return guildId ? `https://discord.com/channels/${guildId}/${channelId}` : undefined
}

function isForumChannel(channel: DiscordChannel): boolean {
  return channel.type === 15 || channel.type === 16
}

function isThreadChannel(channel: DiscordChannel): boolean {
  return channel.type === 10 || channel.type === 11 || channel.type === 12
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

function sessionTurnLimit(value: number | undefined): number {
  return positiveInt(value) ?? 1
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
