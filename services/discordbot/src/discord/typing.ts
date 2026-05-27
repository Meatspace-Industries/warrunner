import { DiscordApiError, type DiscordClient } from './client'
import { logInfo, logWarn } from '../logging'

export type DiscordTypingTarget = {
  channelId?: string
  threadKey?: string
}

export type DiscordTypingIndicator = {
  start(target: DiscordTypingTarget): void
  stop(target: DiscordTypingTarget): void
}

type TypingState = {
  channelId: string
  threadKey?: string
  expiresAt: number
  interval: ReturnType<typeof setInterval>
}

export class DiscordTypingRegistry implements DiscordTypingIndicator {
  readonly client: DiscordClient
  readonly refreshMs: number
  readonly timeoutMs: number
  readonly states = new Map<string, TypingState>()

  constructor(opts: { client: DiscordClient; refreshMs: number; timeoutMs: number }) {
    this.client = opts.client
    this.refreshMs = Math.max(1_000, opts.refreshMs)
    this.timeoutMs = Math.max(this.refreshMs, opts.timeoutMs)
  }

  start(target: DiscordTypingTarget): void {
    const channelId = cleanId(target.channelId)
    if (!channelId) return

    const key = typingKey(target)
    const current = this.states.get(key)
    if (current) {
      current.channelId = channelId
      current.expiresAt = Date.now() + this.timeoutMs
      return
    }

    const state: TypingState = {
      channelId,
      ...(target.threadKey ? { threadKey: target.threadKey } : {}),
      expiresAt: Date.now() + this.timeoutMs,
      interval: setInterval(() => this.tick(key), this.refreshMs)
    }
    state.interval.unref?.()
    this.states.set(key, state)
    this.tick(key)
  }

  stop(target: DiscordTypingTarget): void {
    const key = typingKey(target)
    const exact = this.states.get(key)
    if (exact) {
      this.clear(key, exact)
      return
    }

    const channelId = cleanId(target.channelId)
    if (!channelId) return
    for (const [stateKey, state] of this.states) {
      if (state.channelId === channelId) this.clear(stateKey, state)
    }
  }

  private tick(key: string): void {
    const state = this.states.get(key)
    if (!state) return
    if (Date.now() >= state.expiresAt) {
      this.clear(key, state)
      return
    }
    void this.pulse(key, state)
  }

  private async pulse(key: string, state: TypingState): Promise<void> {
    try {
      await this.client.triggerTyping(state.channelId)
    } catch (error) {
      logWarn('discord_typing_indicator_failed', {
        channel_id: state.channelId,
        thread_key: state.threadKey,
        error
      })
      if (isPermanentTypingFailure(error)) this.clear(key, state)
    }
  }

  private clear(key: string, state: TypingState): void {
    clearInterval(state.interval)
    this.states.delete(key)
    logInfo('discord_typing_indicator_stopped', {
      channel_id: state.channelId,
      thread_key: state.threadKey
    })
  }
}

function typingKey(target: DiscordTypingTarget): string {
  const threadKey = target.threadKey?.trim()
  if (threadKey) return `thread:${threadKey}`
  return `channel:${cleanId(target.channelId) ?? ''}`
}

function cleanId(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text || undefined
}

function isPermanentTypingFailure(error: unknown): boolean {
  return error instanceof DiscordApiError && [403, 404].includes(error.status)
}
