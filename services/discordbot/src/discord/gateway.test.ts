import { afterAll, describe, expect, it } from 'bun:test'
import { loadConfig } from '../config'
import { DiscordChannelResolver, DiscordClient } from './client'
import { startDiscordGateway } from './gateway'
import type { DiscordGatewayPayload, DiscordMessage } from './types'

const identifyPayloads: DiscordGatewayPayload[] = []

const server = Bun.serve({
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/gateway/bot' && request.method === 'GET') {
      return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` })
    }
    if (url.pathname === '/gateway' && server.upgrade(request)) {
      return
    }
    return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }))
    },
    message(ws, raw) {
      const payload = JSON.parse(String(raw)) as DiscordGatewayPayload
      if (payload.op !== 2) return
      identifyPayloads.push(payload)
      ws.send(
        JSON.stringify({
          op: 0,
          t: 'THREAD_CREATE',
          s: 1,
          d: {
            id: 'thread-1',
            type: 11,
            guild_id: 'guild-1',
            parent_id: 'forum-1'
          }
        })
      )
      ws.send(
        JSON.stringify({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 2,
          d: {
            id: 'msg-1',
            channel_id: 'thread-1',
            guild_id: 'guild-1',
            content: 'gateway dogfood path',
            author: { id: 'user-1' },
            attachments: []
          }
        })
      )
    }
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

describe('Discord Gateway', () => {
  it('identifies and dispatches MESSAGE_CREATE events', async () => {
    identifyPayloads.length = 0
    const messages: DiscordMessage[] = []
    const config = loadConfig({
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
      PORT: '3002',
      COMMIT_SHA: 'test',
      DISCORD_API_URL: fakeBaseUrl,
      DISCORD_BOT_TOKEN: 'discord-token',
      DISCORD_GATEWAY_ENABLED: 'true'
    } as NodeJS.ProcessEnv)
    const client = new DiscordClient(config)
    const resolver = new DiscordChannelResolver(client)
    const handle = startDiscordGateway({
      config,
      client,
      channelResolver: resolver,
      onMessage: async message => {
        messages.push(message)
      }
    })

    try {
      await waitFor(() => messages.length === 1 && identifyPayloads.length === 1)
      expect(messages[0]?.content).toBe('gateway dogfood path')
      expect(resolver.parents.get('thread-1')).toBe('forum-1')
      expect(identifyPayloads[0]?.d).toMatchObject({
        token: 'discord-token',
        properties: {
          browser: 'warrunner'
        }
      })
    } finally {
      handle?.stop()
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for gateway condition')
}
