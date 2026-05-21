import { discordBotToken, type AppConfig } from '../config'
import type { DiscordChannel, DiscordCreateMessageBody, DiscordMessage, DiscordUser } from './types'

export class DiscordApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'DiscordApiError'
    this.status = status
    this.body = body
  }
}

export class DiscordClient {
  readonly config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
  }

  async gatewayBotUrl(): Promise<string> {
    const body = await this.request<{ url?: string }>('/gateway/bot')
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) throw new Error('Discord gateway response did not include url')
    return url
  }

  async fetchCurrentUser(): Promise<DiscordUser> {
    return await this.request<DiscordUser>('/users/@me')
  }

  async fetchChannel(channelId: string): Promise<DiscordChannel> {
    return await this.request<DiscordChannel>(`/channels/${encodeURIComponent(channelId)}`)
  }

  async fetchMessages(opts: {
    channelId: string
    after?: string
    before?: string
    limit?: number
  }): Promise<DiscordMessage[]> {
    const params = new URLSearchParams()
    params.set('limit', String(Math.max(1, Math.min(opts.limit ?? 40, 100))))
    if (opts.after) params.set('after', opts.after)
    if (opts.before) params.set('before', opts.before)
    const messages = await this.request<DiscordMessage[]>(
      `/channels/${encodeURIComponent(opts.channelId)}/messages?${params}`
    )
    return Array.isArray(messages) ? messages.reverse() : []
  }

  async createMessage(channelId: string, body: DiscordCreateMessageBody): Promise<DiscordMessage> {
    return await this.request<DiscordMessage>(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  }

  async createForumThread(
    channelId: string,
    body: {
      name: string
      message: { content: string; allowed_mentions?: { parse: string[] } }
      applied_tags?: string[]
    }
  ): Promise<DiscordChannel & { message?: DiscordMessage }> {
    return await this.request<DiscordChannel & { message?: DiscordMessage }>(
      `/channels/${encodeURIComponent(channelId)}/threads`,
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    )
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = discordBotToken(this.config)
    if (!token) throw new Error('DISCORD_BOT_TOKEN is not configured')
    const response = await fetch(new URL(path, this.config.DISCORD_API_URL), {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    })
    const text = await response.text()
    const body = readJson(text)
    if (!response.ok) {
      const message = discordErrorMessage(body) ?? response.statusText
      throw new DiscordApiError(message, response.status, body)
    }
    return body as T
  }
}

export class DiscordChannelResolver {
  readonly client: DiscordClient
  readonly parents = new Map<string, string | undefined>()

  constructor(client: DiscordClient) {
    this.client = client
  }

  remember(channel: DiscordChannel): void {
    this.parents.set(channel.id, channel.parent_id ?? undefined)
  }

  async parentChannelId(channelId: string): Promise<string | undefined> {
    if (this.parents.has(channelId)) return this.parents.get(channelId)
    const channel = await this.client.fetchChannel(channelId)
    this.remember(channel)
    return channel.parent_id ?? undefined
  }
}

function readJson(text: string): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function discordErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message
    if (message) return String(message)
  }
  if (typeof body === 'string' && body.trim()) return body
  return undefined
}
