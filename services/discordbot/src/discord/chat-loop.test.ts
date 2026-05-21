import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { pollFinalDeliveriesOnce } from '../centaur/final-delivery'
import { CentaurHandoff } from '../centaur/handoff'
import { loadConfig, type AppConfig } from '../config'
import { DiscordChannelResolver, DiscordClient } from './client'
import { startDiscordGateway } from './gateway'
import { createDiscordMessageProcessor } from './process'
import type { DiscordGatewayPayload } from './types'

type CapturedRequest = {
  path: string
  authorization: string
  body: any
}

const workflowRuns: CapturedRequest[] = []
const discordPosts: CapturedRequest[] = []
const delivered: CapturedRequest[] = []
let finalDeliveryReady = false
let finalDeliveryClaimed = false

const server = Bun.serve({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/gateway/bot' && request.method === 'GET') {
      return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` })
    }
    if (url.pathname === '/gateway' && server.upgrade(request)) {
      return
    }
    if (url.pathname === '/channels/thread-1/messages' && request.method === 'GET') {
      return Response.json([
        {
          id: 'hist-2',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'older Warrunner reply',
          author: { id: 'bot-user', bot: true },
          attachments: []
        },
        {
          id: 'hist-1',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'older Discord context',
          author: { id: 'user-2' },
          attachments: []
        }
      ])
    }
    if (url.pathname === '/channels/thread-1/messages' && request.method === 'POST') {
      discordPosts.push(await capture(request, url.pathname))
      return Response.json({ id: 'posted-1', channel_id: 'thread-1' })
    }
    if (url.pathname === '/workflows/runs' && request.method === 'POST') {
      workflowRuns.push(await capture(request, url.pathname))
      finalDeliveryReady = true
      return Response.json({ ok: true, run_id: 'run-1' })
    }
    if (url.pathname === '/agent/final-deliveries/claim' && request.method === 'POST') {
      await request.json()
      if (!finalDeliveryReady || finalDeliveryClaimed) {
        return Response.json({ deliveries: [] })
      }
      finalDeliveryClaimed = true
      return Response.json({
        deliveries: [
          {
            execution_id: 'exec-1',
            thread_key: 'discord:guild-1:forum-1:thread-1',
            delivery: {
              platform: 'discord',
              guild_id: 'guild-1',
              channel_id: 'thread-1',
              thread_id: 'thread-1',
              message_id: 'msg-1'
            },
            final_payload: {
              result_text: 'gateway-to-discord final answer'
            }
          }
        ]
      })
    }
    if (
      url.pathname === '/agent/final-deliveries/exec-1/delivered' &&
      request.method === 'POST'
    ) {
      delivered.push(await capture(request, url.pathname))
      return Response.json({ ok: true, execution_id: 'exec-1' })
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
            content: '<@bot-user> dogfood the full chat loop',
            author: { id: 'user-1' },
            mentions: [{ id: 'bot-user' }],
            attachments: []
          }
        })
      )
    }
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

beforeEach(() => {
  workflowRuns.length = 0
  discordPosts.length = 0
  delivered.length = 0
  finalDeliveryReady = false
  finalDeliveryClaimed = false
})

afterAll(() => {
  server.stop(true)
})

describe('Discord Gateway chat loop', () => {
  it('turns a Gateway MESSAGE_CREATE into a Warrunner reply in Discord', async () => {
    const config = testConfig()
    const discord = new DiscordClient(config)
    const channels = new DiscordChannelResolver(discord)
    const handoff = new CentaurHandoff(config)
    const handle = startDiscordGateway({
      config,
      client: discord,
      channelResolver: channels,
      onMessage: createDiscordMessageProcessor({ config, discord, channels, handoff })
    })

    try {
      await waitFor(() => workflowRuns.length === 1)
      expect(workflowRuns[0]).toMatchObject({
        path: '/workflows/runs',
        authorization: 'Bearer centaur-key',
        body: {
          workflow_name: 'discord_thread_turn',
          trigger_key: 'discord:guild-1:thread-1:msg-1',
          eager_start: true,
          input: {
            thread_key: 'discord:guild-1:forum-1:thread-1',
            message_id: 'discord:guild-1:thread-1:msg-1',
            user_id: 'user-1',
            delivery: {
              platform: 'discord',
              guild_id: 'guild-1',
              channel_id: 'thread-1',
              thread_id: 'thread-1',
              message_id: 'msg-1'
            }
          }
        }
      })
      expect(workflowRuns[0]?.body.input.parts[0].text).toBe('dogfood the full chat loop')
      expect(workflowRuns[0]?.body.input.history_messages).toHaveLength(2)

      await pollFinalDeliveriesOnce(config, discord)

      expect(discordPosts).toHaveLength(1)
      expect(discordPosts[0]).toMatchObject({
        path: '/channels/thread-1/messages',
        authorization: 'Bot discord-token',
        body: {
          content: 'gateway-to-discord final answer',
          allowed_mentions: { parse: [] },
          message_reference: {
            message_id: 'msg-1',
            channel_id: 'thread-1',
            guild_id: 'guild-1',
            fail_if_not_exists: false
          }
        }
      })
      expect(delivered).toHaveLength(1)
    } finally {
      handle?.stop()
    }
  })
})

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    ENVIRONMENT: 'test',
    PORT: '3002',
    COMMIT_SHA: 'test',
    DISCORD_API_URL: fakeBaseUrl,
    DISCORD_BOT_TOKEN: 'discord-token',
    DISCORD_APPLICATION_ID: 'bot-user',
    DISCORD_BOT_USER_ID: 'bot-user',
    DISCORD_GATEWAY_ENABLED: 'true',
    DISCORD_GUILD_ID: 'guild-1',
    CENTAUR_API_URL: fakeBaseUrl,
    DISCORDBOT_API_KEY: 'centaur-key',
    WARRUNNER_HOME_FORUM_CHANNEL_ID: 'forum-1',
    WARRUNNER_HISTORY_LIMIT: '10'
  } as NodeJS.ProcessEnv)
}

async function capture(request: Request, path: string): Promise<CapturedRequest> {
  return {
    path,
    authorization: request.headers.get('authorization') ?? '',
    body: await request.json()
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for chat loop condition')
}
