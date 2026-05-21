import { pollFinalDeliveriesOnce } from '../centaur/final-delivery'
import { CentaurHandoff, type CentaurHandoffResult } from '../centaur/handoff'
import { homeChannelIds, loadConfig, type AppConfig } from '../config'
import { DiscordChannelResolver, DiscordClient } from '../discord/client'
import { startDiscordGateway, type DiscordGatewayHandle } from '../discord/gateway'
import { createDiscordMessageProcessor, type DiscordHandoff } from '../discord/process'
import type {
  DiscordChannel,
  DiscordCreateMessageBody,
  DiscordMessage,
  NormalizedDiscordEvent
} from '../discord/types'
import { runSmokePost, type SmokePostResult } from './smoke'

type LiveDogfoodOptions = {
  channelId?: string
  content?: string
  appliedTagIds?: string[]
  setupMode?: LiveSetupMode
  operatorUserId?: string
  timeoutMs?: number
  pollIntervalMs?: number
  onProgress?: (line: string) => void
}

type LiveDogfoodSessionOptions = LiveDogfoodOptions & {
  turnLimit?: number
  untilTimeout?: boolean
}

type LiveSetupMode = 'prompt' | 'attach'

type LiveTarget = {
  requestedChannelId: string
  channel: DiscordChannel
  conversationChannelId: string
  operatorUserId?: string
  discordUrl?: string
  createdThread?: DiscordChannel
  setupMessage?: DiscordMessage
}

export type ObservedReplyMessage = {
  channelId: string
  content: string
  message: DiscordMessage
}

type ObservedReply = ObservedReplyMessage & {
  messages: ObservedReplyMessage[]
  source: 'final_delivery' | 'channel_history'
}

type StoredFinalDeliveryReply = {
  executionId: string
  firstIndex: number
  lastIndex: number
  reply: ObservedReply
}

type LiveDogfoodTurn = {
  observedEvent: NormalizedDiscordEvent
  handoff: CentaurHandoffResult
  executionId?: string
  reply: ObservedReply
}

type AcceptedLiveDogfoodTurn = {
  observedEvent: NormalizedDiscordEvent
  handoff: CentaurHandoffResult
  executionId?: string
}

type AcceptedLiveDiscordMessage = {
  event: NormalizedDiscordEvent
  handoff: CentaurHandoffResult
  executionId?: string
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
      handoff?: CentaurHandoffResult
      executionId?: string
      error: string
      hint?: string
    }

export type LiveDogfoodSessionResult =
  | {
      ok: true
      target: LiveTarget
      turns: LiveDogfoodTurn[]
      stopReason: 'turn_limit' | 'idle_timeout'
    }
  | {
      ok: false
      target?: LiveTarget
      turns: LiveDogfoodTurn[]
      observedEvent?: NormalizedDiscordEvent
      handoff?: CentaurHandoffResult
      executionId?: string
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
      ...(result.handoff ? { handoff: result.handoff } : {}),
      ...(result.executionId ? { executionId: result.executionId } : {}),
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
  let acceptedTurn: AcceptedLiveDogfoodTurn | undefined
  const untilTimeout = opts.untilTimeout === true
  const operatorUserId = opts.operatorUserId?.trim()

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

    const tracker = new LiveTurnTracker()
    const channels = new DiscordChannelResolver(discord)
    const pendingLiveMessages: DiscordMessage[] = []
    const handoff = new ObservingHandoff(
      config,
      event => Boolean(target && liveEventMatchesTarget(event, target, operatorUserId)),
      value => {
        tracker.accept(value)
      }
    )
    const processMessage = createDiscordMessageProcessor({ config, discord, channels, handoff })
    const processLiveMessage = serializeDiscordMessageProcessor(
      dedupeDiscordMessageProcessor(message => {
        if (!liveMessageMatchesOperator(message, operatorUserId)) return Promise.resolve()
        if (!target) {
          pendingLiveMessages.push(message)
          return Promise.resolve()
        }
        if (message.channel_id !== target.conversationChannelId) return Promise.resolve()
        return processMessage(message)
      })
    )
    gatewayHandle = startLiveGateway(config, discord, channels, processLiveMessage)
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
      target = targetFromChannel(config, requestedChannelId, requestedChannel, operatorUserId)
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
      target = targetFromSmoke(config, requestedChannelId, setup, operatorUserId)
    }
    await drainPendingLiveMessages(pendingLiveMessages, target, operatorUserId, processMessage)
    const historyIntakeSeenMessageIds = new Set<string>()
    let historyCursor = target.setupMessage?.id ?? (await latestMessageId(discord, target.conversationChannelId))
    opts.onProgress?.(formatLiveTarget(target, botUser.id, timeoutMs))

    discord.armReplyObserver()
    const turnLimit = sessionTurnLimit(opts.turnLimit)
    let replyCursor = 0
    const finalDeliveryReplies = new FinalDeliveryReplyTracker()
    while (untilTimeout || turns.length < turnLimit) {
      const nextMessageTimeout = `timed out waiting for Discord message ${turns.length + 1} in ${target.conversationChannelId}`
      let accepted: AcceptedLiveDiscordMessage
      try {
        accepted = await waitForAcceptedTurn({
          tracker,
          index: turns.length,
          discord,
          channelId: target.conversationChannelId,
          afterMessageId: historyCursor,
          processMessage: processLiveMessage,
          seenMessageIds: historyIntakeSeenMessageIds,
          operatorUserId,
          timeoutMs: waitTimeoutMs({ timeoutMs, startedAt, resetEachWait: untilTimeout }),
          pollIntervalMs,
          timeoutMessage: nextMessageTimeout,
          onProgress: opts.onProgress
        })
        historyCursor = accepted.event.discord.message_id
      } catch (error) {
        if (untilTimeout && turns.length > 0 && errorMessage(error) === nextMessageTimeout) {
          opts.onProgress?.(`PASS live Discord session idle timeout after ${turns.length} turns`)
          return { ok: true, target, turns, stopReason: 'idle_timeout' }
        }
        throw error
      }
      acceptedTurn = {
        observedEvent: accepted.event,
        handoff: accepted.handoff,
        ...(accepted.executionId ? { executionId: accepted.executionId } : {})
      }
      if (!accepted.handoff.ok) {
        return {
          ok: false,
          turns,
          target,
          observedEvent: accepted.event,
          handoff: accepted.handoff,
          error: `workflow_handoff_failed:${accepted.handoff.status}`,
          hint: 'Verify Centaur API health, DISCORDBOT_API_KEY, and the discord_thread_turn workflow registration.'
        }
      }
      opts.onProgress?.(`PASS live Discord message accepted: ${accepted.event.message_id}`)

      const observedReply = await waitForReply({
        config,
        discord,
        channelId: accepted.event.channel_id,
        botUserId: botUser.id,
        afterMessageId: accepted.event.discord.message_id,
        executionId: accepted.executionId,
        finalDeliveryReplies,
        fromIndex: replyCursor,
        timeoutMs: waitTimeoutMs({ timeoutMs, startedAt, resetEachWait: untilTimeout }),
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
      acceptedTurn = undefined
    }

    return { ok: true, target, turns, stopReason: 'turn_limit' }
  } catch (error) {
    return {
      ok: false,
      turns,
      target,
      ...(acceptedTurn ? { observedEvent: acceptedTurn.observedEvent } : {}),
      ...(acceptedTurn ? { handoff: acceptedTurn.handoff } : {}),
      ...(acceptedTurn?.executionId ? { executionId: acceptedTurn.executionId } : {}),
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
    const target = result.target?.discordUrl ? `\nPASS Discord URL: ${result.target.discordUrl}` : ''
    const event = result.observedEvent ? `\nPASS live Discord message accepted: ${result.observedEvent.message_id}` : ''
    const handoff = result.handoff ? `\n${workflowHandoffLine(result.handoff)}` : ''
    const execution = result.executionId ? `\nPASS workflow execution: ${result.executionId}` : ''
    const eventUrl = result.observedEvent
      ? acceptedDiscordMessageUrl(result.observedEvent)
      : undefined
    const eventUrlLine = eventUrl ? `\nPASS Discord message URL: ${eventUrl}` : ''
    return `FAIL live Discord chat loop: ${result.error}${target}${event}${eventUrlLine}${handoff}${execution}${hint}`
  }

  const target = result.target.createdThread
    ? `${channelLabel(result.target.channel)} -> ${result.target.createdThread.name ?? result.target.createdThread.id} (${result.target.conversationChannelId})`
    : `${channelLabel(result.target.channel)} (${result.target.conversationChannelId})`
  return [
    'PASS live Discord chat loop completed',
    `PASS target: ${target}`,
    ...(result.target.operatorUserId ? [`PASS operator user filter: ${result.target.operatorUserId}`] : []),
    ...(result.target.discordUrl ? [`PASS Discord URL: ${result.target.discordUrl}`] : []),
    `PASS workflow handoff: ${result.handoff.status}`,
    ...(result.executionId ? [`PASS workflow execution: ${result.executionId}`] : []),
    `PASS normalized user text: ${result.observedEvent.parts[0]?.text ?? '(missing)'}`,
    ...lineIf('PASS Discord message URL', acceptedDiscordMessageUrl(result.observedEvent)),
    `PASS Discord reply posted: ${result.reply.message.id}`,
    ...lineIf('PASS Discord reply URL', replyDiscordMessageUrl(result.reply, result.observedEvent.guild_id)),
    ...(result.reply.messages.length > 1
      ? [`PASS Discord reply messages: ${result.reply.messages.map(reply => reply.message.id).join(', ')}`]
      : []),
    `PASS Discord reply source: ${result.reply.source}`,
    `PASS reply preview: ${result.reply.content.slice(0, 160)}`
  ].join('\n')
}

export function formatLiveDogfoodSession(
  result: LiveDogfoodSessionResult,
  opts: { mode?: 'session' | 'chat' } = {}
): string {
  const mode = opts.mode ?? 'session'
  if (!result.ok) {
    const hint = result.hint ? `\n      ${result.hint}` : ''
    const target = result.target?.discordUrl ? `\nPASS Discord URL: ${result.target.discordUrl}` : ''
    const completed = result.turns.length
      ? `\nPASS live ${mode} turns completed: ${result.turns.length}`
      : ''
    const event = result.observedEvent ? `\nPASS live Discord message accepted: ${result.observedEvent.message_id}` : ''
    const handoff = result.handoff ? `\n${workflowHandoffLine(result.handoff)}` : ''
    const execution = result.executionId ? `\nPASS workflow execution: ${result.executionId}` : ''
    const eventUrl = result.observedEvent
      ? acceptedDiscordMessageUrl(result.observedEvent)
      : undefined
    const eventUrlLine = eventUrl ? `\nPASS Discord message URL: ${eventUrl}` : ''
    return `FAIL live Discord dogfood ${mode}: ${result.error}${target}${completed}${event}${eventUrlLine}${handoff}${execution}${hint}`
  }
  const target = result.target.createdThread
    ? `${channelLabel(result.target.channel)} -> ${result.target.createdThread.name ?? result.target.createdThread.id} (${result.target.conversationChannelId})`
    : `${channelLabel(result.target.channel)} (${result.target.conversationChannelId})`
  return [
    `PASS live Discord dogfood ${mode} completed`,
    `PASS target: ${target}`,
    ...(result.target.operatorUserId ? [`PASS operator user filter: ${result.target.operatorUserId}`] : []),
    ...(result.target.discordUrl ? [`PASS Discord URL: ${result.target.discordUrl}`] : []),
    `PASS turns completed: ${result.turns.length}`,
    `PASS stop reason: ${result.stopReason}`,
    ...result.turns.map((turn, index) => {
      const text = turn.observedEvent.parts[0]?.text ?? '(missing)'
      const messageCount =
        turn.reply.messages.length > 1 ? ` (${turn.reply.messages.length} Discord messages)` : ''
      const execution = turn.executionId ? ` [${turn.executionId}]` : ''
      const requestUrl = acceptedDiscordMessageUrl(turn.observedEvent)
      const replyUrl = replyDiscordMessageUrl(turn.reply, turn.observedEvent.guild_id)
      const urls = requestUrl && replyUrl ? ` (${requestUrl} -> ${replyUrl})` : ''
      return `PASS turn ${index + 1}: ${text} -> ${turn.reply.message.id}${messageCount}${execution} via ${turn.reply.source}${urls}`
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
    if (!this.isTarget(event)) {
      return { ok: true, status: 204, body: { skipped: 'live_non_target_discord_event' } }
    }
    const result = await super.emit(event)
    const executionId = handoffExecutionId(result)
    this.onAccepted({ event, handoff: result, ...(executionId ? { executionId } : {}) })
    return result
  }
}

class LiveTurnTracker {
  readonly accepted: AcceptedLiveDiscordMessage[] = []
  readonly acceptedMessageIds = new Set<string>()
  readonly acceptedDiscordMessageIds = new Set<string>()

  accept(value: AcceptedLiveDiscordMessage): void {
    if (this.acceptedMessageIds.has(value.event.message_id)) return
    this.acceptedMessageIds.add(value.event.message_id)
    this.acceptedDiscordMessageIds.add(value.event.discord.message_id)
    this.accepted.push(value)
  }

  hasDiscordMessageId(messageId: string): boolean {
    return this.acceptedDiscordMessageIds.has(messageId)
  }

  peek(index: number): AcceptedLiveDiscordMessage | undefined {
    return this.accepted[index]
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
    body: DiscordCreateMessageBody
  ): Promise<DiscordMessage> {
    const message = await super.createMessage(channelId, body)
    const observedMessage =
      body.message_reference && !message.message_reference
        ? { ...message, message_reference: body.message_reference }
        : message
    if (this.replyObserverArmed) {
      this.observedReplies.push({
        channelId,
        content: body.content,
        message: observedMessage
      })
    }
    return message
  }
}

class FinalDeliveryReplyTracker {
  readonly replies: StoredFinalDeliveryReply[] = []
  readonly seenExecutionIds = new Set<string>()

  record(
    deliveries: Array<{ executionId: string; messages: DiscordMessage[] }>,
    discord: ObservingDiscordClient
  ): void {
    for (const delivery of deliveries) {
      if (this.seenExecutionIds.has(delivery.executionId)) continue
      const indexes = delivery.messages
        .map(message =>
          discord.observedReplies.findIndex(reply => reply.message.id === message.id)
        )
        .filter(index => index >= 0)
      if (!indexes.length) continue

      const firstIndex = Math.min(...indexes)
      const lastIndex = Math.max(...indexes)
      const reply = discord.observedReplies[firstIndex]
      if (!reply) continue

      const messages = indexes
        .sort((left, right) => left - right)
        .map(index => discord.observedReplies[index])
        .filter(message => message !== undefined)
      this.replies.push({
        executionId: delivery.executionId,
        firstIndex,
        lastIndex,
        reply: { ...reply, messages, source: 'final_delivery' }
      })
      this.seenExecutionIds.add(delivery.executionId)
    }
  }

  take(opts: {
    executionId?: string
    channelId: string
    acceptedMessageId: string
    fromIndex: number
  }): { reply: ObservedReply; index: number } | undefined {
    const index = this.replies.findIndex(
      item =>
        (opts.executionId
          ? item.executionId === opts.executionId
          : referencesDiscordMessage(item.reply.message, opts.acceptedMessageId)) &&
        item.reply.channelId === opts.channelId &&
        item.firstIndex >= opts.fromIndex
    )
    if (index < 0) return undefined
    const [item] = this.replies.splice(index, 1)
    if (!item) return undefined
    return { reply: item.reply, index: item.lastIndex }
  }
}

function startLiveGateway(
  config: AppConfig,
  discord: DiscordClient,
  channels: DiscordChannelResolver,
  processMessage: (message: DiscordMessage) => Promise<void>
): DiscordGatewayHandle | null {
  return startDiscordGateway({
    config,
    client: discord,
    channelResolver: channels,
    onMessage: processMessage
  })
}

function dedupeDiscordMessageProcessor(
  processMessage: (message: DiscordMessage) => Promise<void>
): (message: DiscordMessage) => Promise<void> {
  const seenMessageIds = new Set<string>()
  return async message => {
    if (!message.id) return
    if (seenMessageIds.has(message.id)) return
    seenMessageIds.add(message.id)
    await processMessage(message)
  }
}

function serializeDiscordMessageProcessor(
  processMessage: (message: DiscordMessage) => Promise<void>
): (message: DiscordMessage) => Promise<void> {
  let queue = Promise.resolve()
  return message => {
    const next = queue.then(() => processMessage(message))
    queue = next.catch(() => {})
    return next
  }
}

async function drainPendingLiveMessages(
  pending: DiscordMessage[],
  target: LiveTarget,
  operatorUserId: string | undefined,
  processMessage: (message: DiscordMessage) => Promise<void>
): Promise<void> {
  const messages = pending.splice(0, pending.length)
  for (const message of messages) {
    if (message.channel_id !== target.conversationChannelId) continue
    if (!liveMessageMatchesOperator(message, operatorUserId)) continue
    await processMessage(message)
  }
}

function liveEventMatchesTarget(
  event: NormalizedDiscordEvent,
  target: LiveTarget,
  operatorUserId: string | undefined
): boolean {
  if (event.channel_id !== target.conversationChannelId) return false
  return !operatorUserId || event.user_id === operatorUserId
}

function liveMessageMatchesOperator(
  message: DiscordMessage,
  operatorUserId: string | undefined
): boolean {
  return !operatorUserId || message.author?.id === operatorUserId
}

async function waitForAcceptedTurn(opts: {
  tracker: LiveTurnTracker
  index: number
  discord: ObservingDiscordClient
  channelId: string
  afterMessageId?: string
  processMessage: (message: DiscordMessage) => Promise<void>
  seenMessageIds: Set<string>
  operatorUserId?: string
  timeoutMs: number
  pollIntervalMs: number
  timeoutMessage: string
  onProgress?: (line: string) => void
}): Promise<AcceptedLiveDiscordMessage> {
  const started = Date.now()
  let cursor = opts.afterMessageId
  while (Date.now() - started < opts.timeoutMs) {
    const accepted = opts.tracker.peek(opts.index)
    if (accepted) return accepted

    const polled = await processChannelHistoryIntake({
      discord: opts.discord,
      channelId: opts.channelId,
      afterMessageId: cursor,
      processMessage: opts.processMessage,
      seenMessageIds: opts.seenMessageIds,
      tracker: opts.tracker,
      operatorUserId: opts.operatorUserId,
      onProgress: opts.onProgress
    })
    cursor = polled.afterMessageId

    const acceptedAfterPoll = opts.tracker.peek(opts.index)
    if (acceptedAfterPoll) return acceptedAfterPoll

    await sleep(Math.min(opts.pollIntervalMs, remainingTimeout(opts.timeoutMs, started)))
  }
  throw new Error(opts.timeoutMessage)
}

async function processChannelHistoryIntake(opts: {
  discord: ObservingDiscordClient
  channelId: string
  afterMessageId?: string
  processMessage: (message: DiscordMessage) => Promise<void>
  seenMessageIds: Set<string>
  tracker: LiveTurnTracker
  operatorUserId?: string
  onProgress?: (line: string) => void
}): Promise<{ afterMessageId?: string }> {
  const messages = await opts.discord
    .fetchMessages({
      channelId: opts.channelId,
      after: opts.afterMessageId,
      limit: 25
    })
    .catch(() => [])
  let cursor = opts.afterMessageId
  // DiscordClient normalizes channel history to oldest-to-newest; preserve chat order here.
  for (const message of messages) {
    if (message.channel_id !== opts.channelId) continue
    cursor = message.id || cursor
    if (!message.id || message.author?.bot || message.webhook_id) continue
    if (!liveMessageMatchesOperator(message, opts.operatorUserId)) continue
    if (opts.seenMessageIds.has(message.id) || opts.tracker.hasDiscordMessageId(message.id)) continue
    opts.seenMessageIds.add(message.id)
    opts.onProgress?.(`PASS live Discord history intake: ${message.id}`)
    await opts.processMessage(message)
  }
  return { ...(cursor ? { afterMessageId: cursor } : {}) }
}

async function latestMessageId(
  discord: ObservingDiscordClient,
  channelId: string
): Promise<string | undefined> {
  const messages = await discord.fetchMessages({ channelId, limit: 1 }).catch(() => [])
  return messages.at(-1)?.id
}

async function waitForReply(opts: {
  config: AppConfig
  discord: ObservingDiscordClient
  channelId: string
  botUserId?: string
  afterMessageId: string
  executionId?: string
  finalDeliveryReplies: FinalDeliveryReplyTracker
  fromIndex: number
  timeoutMs: number
  pollIntervalMs: number
}): Promise<{ reply: ObservedReply; index: number }> {
  const started = Date.now()
  while (Date.now() - started < opts.timeoutMs) {
    const cached = opts.finalDeliveryReplies.take({
      executionId: opts.executionId,
      channelId: opts.channelId,
      acceptedMessageId: opts.afterMessageId,
      fromIndex: opts.fromIndex
    })
    if (cached) return cached

    const deliveryResult = await pollFinalDeliveriesOnce(opts.config, opts.discord)
    opts.finalDeliveryReplies.record(deliveryResult.delivered, opts.discord)
    const delivered = opts.finalDeliveryReplies.take({
      executionId: opts.executionId,
      channelId: opts.channelId,
      acceptedMessageId: opts.afterMessageId,
      fromIndex: opts.fromIndex
    })
    if (delivered) return delivered

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
  const firstReplyIndex = messages.findIndex(
    message =>
      message.channel_id === opts.channelId &&
      message.author?.id === botUserId &&
      !locallyDeliveredIds.has(message.id) &&
      Boolean(String(message.content ?? '').trim()) &&
      referencesDiscordMessage(message, opts.afterMessageId)
  )
  if (firstReplyIndex < 0) return undefined

  const replies: ObservedReplyMessage[] = []
  for (const message of messages.slice(firstReplyIndex)) {
    if (message.channel_id !== opts.channelId) break
    if (message.author?.id !== botUserId) break
    if (locallyDeliveredIds.has(message.id)) break
    const content = String(message.content ?? '').trim()
    if (!content) break
    if (replies.length > 0 && referencesOtherDiscordMessage(message, opts.afterMessageId)) break
    replies.push({ channelId: opts.channelId, content: String(message.content ?? ''), message })
  }

  const first = replies[0]
  if (!first) return undefined
  return { ...first, messages: replies, source: 'channel_history' }
}

function referencesDiscordMessage(message: DiscordMessage, messageId: string): boolean {
  return (
    message.message_reference?.message_id === messageId ||
    message.referenced_message?.id === messageId
  )
}

function referencesOtherDiscordMessage(message: DiscordMessage, messageId: string): boolean {
  const referencedMessageId = message.message_reference?.message_id ?? message.referenced_message?.id
  return Boolean(referencedMessageId && referencedMessageId !== messageId)
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
    return {
      ok: false,
      hint:
        'No Warrunner Discord route is configured. Set WARRUNNER_HOME_FORUM_CHANNEL_ID, WARRUNNER_HOME_CHANNEL_IDS, or WARRUNNER_INTAKE_CHANNEL_IDS before live dogfood.'
    }
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
  result: Extract<SmokePostResult, { ok: true }>,
  operatorUserId?: string
): LiveTarget {
  const conversationChannelId = result.createdThread?.id ?? result.channel.id
  const discordUrl = discordChannelUrl(config, result, conversationChannelId)
  return {
    requestedChannelId,
    channel: result.channel,
    conversationChannelId,
    ...(operatorUserId ? { operatorUserId } : {}),
    ...(discordUrl ? { discordUrl } : {}),
    ...(result.createdThread ? { createdThread: result.createdThread } : {}),
    ...(result.message ? { setupMessage: result.message } : {})
  }
}

function targetFromChannel(
  config: AppConfig,
  requestedChannelId: string,
  channel: DiscordChannel,
  operatorUserId?: string
): LiveTarget {
  const conversationChannelId = channel.id
  const discordUrl = discordChannelUrlForChannel(config, channel, conversationChannelId)
  return {
    requestedChannelId,
    channel,
    conversationChannelId,
    ...(operatorUserId ? { operatorUserId } : {}),
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
  const operator = target.operatorUserId
    ? [`PASS operator user filter: ${target.operatorUserId}`]
    : []
  if (target.createdThread || isThreadChannel(target.channel)) {
    return [
      `PASS live target ready: ${conversationLabel(target)} (${target.conversationChannelId}); reply in that thread within ${seconds}s.`,
      ...operator,
      ...(target.discordUrl ? [`PASS Discord URL: ${target.discordUrl}`] : [])
    ].join('\n')
  }
  return [
    `PASS live target ready: ${channelLabel(target.channel)} (${target.conversationChannelId}); send a Discord message mentioning ${mention} within ${seconds}s.`,
    ...operator,
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

export function acceptedDiscordMessageUrl(event: NormalizedDiscordEvent): string | undefined {
  return discordMessageUrl(event.guild_id, event.channel_id, event.discord.message_id)
}

export function replyDiscordMessageUrl(
  reply: ObservedReplyMessage,
  fallbackGuildId?: string
): string | undefined {
  return discordMessageUrl(
    reply.message.guild_id ?? fallbackGuildId,
    reply.channelId,
    reply.message.id
  )
}

export function discordMessageUrl(
  guildId: string | undefined,
  channelId: string | undefined,
  messageId: string | undefined
): string | undefined {
  if (!guildId || !channelId || !messageId) return undefined
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

function lineIf(label: string, value: string | undefined): string[] {
  return value ? [`${label}: ${value}`] : []
}

function workflowHandoffLine(handoff: CentaurHandoffResult): string {
  return `${handoff.ok ? 'PASS' : 'FAIL'} workflow handoff: ${handoff.status}`
}

function isForumChannel(channel: DiscordChannel): boolean {
  return channel.type === 15 || channel.type === 16
}

function isThreadChannel(channel: DiscordChannel): boolean {
  return channel.type === 10 || channel.type === 11 || channel.type === 12
}

function remainingTimeout(timeoutMs: number, startedAt: number): number {
  return Math.max(1, timeoutMs - (Date.now() - startedAt))
}

function waitTimeoutMs(opts: {
  timeoutMs: number
  startedAt: number
  resetEachWait: boolean
}): number {
  return opts.resetEachWait ? opts.timeoutMs : remainingTimeout(opts.timeoutMs, opts.startedAt)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
