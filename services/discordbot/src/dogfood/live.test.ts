import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { loadConfig, type AppConfig } from '../config'
import type { DiscordGatewayPayload } from '../discord/types'
import { formatLiveDogfood, runLiveDogfood } from './live'

type CapturedRequest = {
  path: string
  authorization: string
  body: any
}

const forumThreads: CapturedRequest[] = []
const workflowRuns: CapturedRequest[] = []
const discordPosts: CapturedRequest[] = []
const delivered: CapturedRequest[] = []

let activeGateway: any = null
let liveThreadCreated = false
let liveMessageSent = false
let finalDeliveryReady = false
let finalDeliveryClaimed = false

const server = Bun.serve({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/users/@me' && request.method === 'GET') {
      return Response.json({ id: 'bot-user', username: 'warrunner', bot: true })
    }
    if (url.pathname === '/gateway/bot' && request.method === 'GET') {
      return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` })
    }
    if (url.pathname === '/gateway' && server.upgrade(request)) {
      return
    }
    if (url.pathname === '/channels/forum-1' && request.method === 'GET') {
      return Response.json({
        id: 'forum-1',
        type: 15,
        name: 'warrunner-forum',
        guild_id: 'guild-1'
      })
    }
    if (url.pathname === '/channels/forum-1/threads' && request.method === 'POST') {
      const captured = await capture(request, url.pathname)
      forumThreads.push(captured)
      liveThreadCreated = true
      setTimeout(sendLiveDiscordMessage, 10)
      return Response.json({
        id: 'live-thread-1',
        type: 11,
        name: 'Warrunner dogfood smoke',
        parent_id: 'forum-1',
        guild_id: 'guild-1',
        message: {
          id: 'setup-msg-1',
          channel_id: 'live-thread-1',
          guild_id: 'guild-1',
          content: captured.body.message.content,
          author: { id: 'bot-user', bot: true },
          attachments: []
        }
      })
    }
    if (url.pathname === '/channels/live-thread-1/messages' && request.method === 'GET') {
      return Response.json([
        {
          id: 'hist-1',
          channel_id: 'live-thread-1',
          guild_id: 'guild-1',
          content: 'previous context',
          author: { id: 'user-2' },
          attachments: []
        }
      ])
    }
    if (url.pathname === '/channels/live-thread-1/messages' && request.method === 'POST') {
      discordPosts.push(await capture(request, url.pathname))
      return Response.json({ id: 'reply-msg-1', channel_id: 'live-thread-1' })
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
            thread_key: 'discord:guild-1:forum-1:live-thread-1',
            delivery: {
              platform: 'discord',
              guild_id: 'guild-1',
              channel_id: 'live-thread-1',
              thread_id: 'live-thread-1'
            },
            final_payload: {
              result_text: 'live dogfood final answer'
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
      activeGateway = ws
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }))
    },
    close() {
      activeGateway = null
    },
    message(ws, raw) {
      activeGateway = ws
      const payload = JSON.parse(String(raw)) as DiscordGatewayPayload
      if (payload.op === 2) sendLiveDiscordMessage()
    }
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

beforeEach(() => {
  forumThreads.length = 0
  workflowRuns.length = 0
  discordPosts.length = 0
  delivered.length = 0
  activeGateway = null
  liveThreadCreated = false
  liveMessageSent = false
  finalDeliveryReady = false
  finalDeliveryClaimed = false
})

afterAll(() => {
  server.stop(true)
})

describe('live dogfood chat loop', () => {
  it('creates a Discord forum thread and waits for a real Gateway message through final delivery', async () => {
    const progress: string[] = []
    const result = await runLiveDogfood(testConfig(), {
      channelId: 'forum-1',
      content: 'open live dogfood',
      appliedTagIds: ['tag-1'],
      timeoutMs: 2_000,
      pollIntervalMs: 10,
      onProgress: line => progress.push(line)
    })
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(true)
    expect(forumThreads).toEqual([
      {
        path: '/channels/forum-1/threads',
        authorization: 'Bot discord-token',
        body: {
          name: 'Warrunner dogfood smoke',
          message: {
            content: 'open live dogfood',
            allowed_mentions: { parse: [] }
          },
          applied_tags: ['tag-1']
        }
      }
    ])
    expect(workflowRuns[0]).toMatchObject({
      path: '/workflows/runs',
      authorization: 'Bearer centaur-key',
      body: {
        workflow_name: 'discord_thread_turn',
        input: {
          thread_key: 'discord:guild-1:forum-1:live-thread-1',
          message_id: 'discord:guild-1:live-thread-1:live-msg-1'
        }
      }
    })
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('live dogfood from Discord')
    expect(discordPosts).toHaveLength(1)
    expect(discordPosts[0]).toMatchObject({
      path: '/channels/live-thread-1/messages',
      authorization: 'Bot discord-token',
      body: {
        content: 'live dogfood final answer',
        allowed_mentions: { parse: [] }
      }
    })
    expect(delivered).toHaveLength(1)
    expect(progress.some(line => line.includes('PASS live target ready'))).toBe(true)
    expect(progress.some(line => line.includes('PASS live Discord message accepted'))).toBe(true)
    expect(formatted).toContain('PASS live Discord chat loop completed')
    expect(formatted).toContain('PASS Discord reply posted: reply-msg-1')
  })

  it('fails before writing when the target forum is not configured as a Warrunner route', async () => {
    const result = await runLiveDogfood(
      testConfig({
        WARRUNNER_HOME_FORUM_CHANNEL_ID: 'other-forum'
      }),
      {
        channelId: 'forum-1',
        content: 'should not be posted',
        timeoutMs: 50,
        pollIntervalMs: 10
      }
    )
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(false)
    expect(forumThreads).toHaveLength(0)
    expect(workflowRuns).toHaveLength(0)
    expect(discordPosts).toHaveLength(0)
    expect(formatted).toContain('FAIL live Discord chat loop: live_target_not_routable:forum-1')
    expect(formatted).toContain('Set WARRUNNER_HOME_FORUM_CHANNEL_ID=forum-1')
  })
})

function sendLiveDiscordMessage(): void {
  if (!activeGateway || !liveThreadCreated || liveMessageSent) return
  liveMessageSent = true
  activeGateway.send(
    JSON.stringify({
      op: 0,
      t: 'THREAD_CREATE',
      s: 1,
      d: {
        id: 'live-thread-1',
        type: 11,
        guild_id: 'guild-1',
        parent_id: 'forum-1'
      }
    })
  )
  activeGateway.send(
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'live-msg-1',
        channel_id: 'live-thread-1',
        guild_id: 'guild-1',
        content: '<@bot-user> live dogfood from Discord',
        author: { id: 'user-1' },
        mentions: [{ id: 'bot-user' }],
        attachments: []
      }
    })
  )
}

function testConfig(env: Record<string, string | undefined> = {}): AppConfig {
  const base: Record<string, string | undefined> = {
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
  }
  return loadConfig({ ...base, ...env } as NodeJS.ProcessEnv)
}

async function capture(request: Request, path: string): Promise<CapturedRequest> {
  return {
    path,
    authorization: request.headers.get('authorization') ?? '',
    body: await request.json()
  }
}
