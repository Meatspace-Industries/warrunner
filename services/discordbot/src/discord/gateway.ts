import { type AppConfig } from '../config'
import { logError, logInfo, logWarn } from '../logging'
import { DiscordChannelResolver, DiscordClient } from './client'
import type { DiscordChannel, DiscordGatewayPayload, DiscordMessage } from './types'

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

const INTENT_GUILDS = 1 << 0
const INTENT_GUILD_MESSAGES = 1 << 9
const INTENT_MESSAGE_CONTENT = 1 << 15

export type DiscordGatewayHandle = {
  stop(): void
}

export function startDiscordGateway(opts: {
  config: AppConfig
  client: DiscordClient
  channelResolver: DiscordChannelResolver
  onMessage(message: DiscordMessage): Promise<void>
}): DiscordGatewayHandle | null {
  if (!opts.config.DISCORD_GATEWAY_ENABLED) return null
  if (!opts.config.DISCORD_BOT_TOKEN) {
    logWarn('discord_gateway_not_started', { reason: 'missing_DISCORD_BOT_TOKEN' })
    return null
  }
  const runner = new DiscordGatewayRunner(opts)
  runner.start()
  return runner
}

class DiscordGatewayRunner implements DiscordGatewayHandle {
  readonly config: AppConfig
  readonly client: DiscordClient
  readonly channelResolver: DiscordChannelResolver
  readonly onMessage: (message: DiscordMessage) => Promise<void>
  sequence: number | null = null
  heartbeatTimer: ReturnType<typeof setInterval> | null = null
  reconnectTimer: ReturnType<typeof setTimeout> | null = null
  socket: WebSocket | null = null
  stopped = false

  constructor(opts: {
    config: AppConfig
    client: DiscordClient
    channelResolver: DiscordChannelResolver
    onMessage(message: DiscordMessage): Promise<void>
  }) {
    this.config = opts.config
    this.client = opts.client
    this.channelResolver = opts.channelResolver
    this.onMessage = opts.onMessage
  }

  start(): void {
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeatTimer = null
    this.reconnectTimer = null
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const gatewayUrl = await this.client.gatewayBotUrl()
      const url = `${gatewayUrl}?v=10&encoding=json`
      const socket = new WebSocket(url)
      this.socket = socket
      socket.onopen = () => logInfo('discord_gateway_open')
      socket.onmessage = event => this.handleMessage(String(event.data))
      socket.onclose = event => {
        logWarn('discord_gateway_closed', { code: event.code, reason: event.reason })
        this.scheduleReconnect()
      }
      socket.onerror = event => {
        logWarn('discord_gateway_error', event)
      }
    } catch (error) {
      logError('discord_gateway_connect_failed', error)
      this.scheduleReconnect()
    }
  }

  handleMessage(raw: string): void {
    let payload: DiscordGatewayPayload
    try {
      payload = JSON.parse(raw) as DiscordGatewayPayload
    } catch {
      logWarn('discord_gateway_invalid_payload')
      return
    }
    if (typeof payload.s === 'number') this.sequence = payload.s

    switch (payload.op) {
      case OP_HELLO:
        this.startHeartbeat(payload.d)
        this.identify()
        return
      case OP_HEARTBEAT:
        this.heartbeat()
        return
      case OP_HEARTBEAT_ACK:
        return
      case OP_RECONNECT:
      case OP_INVALID_SESSION:
        this.reconnectNow()
        return
      case OP_DISPATCH:
        this.handleDispatch(payload.t, payload.d)
        return
      default:
        return
    }
  }

  handleDispatch(type: string | null | undefined, data: unknown): void {
    if (type === 'THREAD_CREATE' && isDiscordChannel(data)) {
      this.channelResolver.remember(data)
      return
    }
    if (type !== 'MESSAGE_CREATE' || !isDiscordMessage(data)) return
    void this.onMessage(data).catch(error => logError('discord_message_processing_failed', error))
  }

  startHeartbeat(data: unknown): void {
    const interval = helloInterval(data)
    if (!interval) {
      logWarn('discord_gateway_missing_heartbeat_interval')
      return
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => this.heartbeat(), interval)
    this.heartbeatTimer.unref?.()
    this.heartbeat()
  }

  heartbeat(): void {
    this.send({ op: OP_HEARTBEAT, d: this.sequence })
  }

  identify(): void {
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.config.DISCORD_BOT_TOKEN,
        intents: INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
        properties: {
          os: 'linux',
          browser: 'warrunner',
          device: 'warrunner'
        }
      }
    })
  }

  send(payload: unknown): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(payload))
  }

  reconnectNow(): void {
    if (this.socket) this.socket.close()
    this.scheduleReconnect()
  }

  scheduleReconnect(): void {
    if (this.stopped) return
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, this.config.DISCORD_GATEWAY_RECONNECT_MS)
    this.reconnectTimer.unref?.()
  }
}

function helloInterval(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const value = (data as { heartbeat_interval?: unknown }).heartbeat_interval
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function isDiscordMessage(data: unknown): data is DiscordMessage {
  if (!data || typeof data !== 'object') return false
  const candidate = data as Partial<DiscordMessage>
  return typeof candidate.id === 'string' && typeof candidate.channel_id === 'string'
}

function isDiscordChannel(data: unknown): data is DiscordChannel {
  if (!data || typeof data !== 'object') return false
  const candidate = data as Partial<DiscordChannel>
  return typeof candidate.id === 'string' && typeof candidate.type === 'number'
}
