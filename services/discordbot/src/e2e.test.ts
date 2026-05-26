import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { loadConfig } from './config'
import { pollFinalDeliveriesOnce } from './centaur/final-delivery'
import { DiscordClient } from './discord/client'

type CapturedRequest = {
  path: string
  body: any
}

const workflowRuns: CapturedRequest[] = []
const discordPosts: CapturedRequest[] = []
const delivered: CapturedRequest[] = []
const typingPosts: CapturedRequest[] = []
let finalDeliveryReady = false
let finalDeliveryClaimed = false

const server = Bun.serve({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/users/@me' && request.method === 'GET') {
      return Response.json({
        id: 'bot-user',
        username: 'warrunner',
        bot: true
      })
    }
    if (url.pathname === '/gateway/bot' && request.method === 'GET') {
      return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` })
    }
    if (url.pathname === '/gateway' && server.upgrade(request)) {
      return
    }
    if (url.pathname === '/channels/thread-1' && request.method === 'GET') {
      return Response.json({
        id: 'thread-1',
        type: 11,
        parent_id: 'forum-1',
        guild_id: 'guild-1'
      })
    }
    if (url.pathname === '/channels/home-1' && request.method === 'GET') {
      return Response.json({
        id: 'home-1',
        type: 0,
        parent_id: null,
        guild_id: 'guild-1'
      })
    }
    if (url.pathname === '/channels/random-thread' && request.method === 'GET') {
      return Response.json({
        id: 'random-thread',
        type: 11,
        parent_id: 'random-forum',
        guild_id: 'guild-1'
      })
    }
    if (url.pathname === '/channels/thread-1/messages' && request.method === 'GET') {
      return Response.json([
        {
          id: 'hist-2',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'older assistant answer',
          author: { id: 'bot-user', bot: true },
          attachments: []
        },
        {
          id: 'hist-1',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'older user context',
          author: { id: 'user-2' },
          attachments: []
        }
      ])
    }
    if (url.pathname === '/channels/home-1/messages' && request.method === 'GET') {
      return Response.json([
        {
          id: 'home-hist-1',
          channel_id: 'home-1',
          guild_id: 'guild-1',
          content: 'home channel context',
          author: { id: 'user-2' },
          attachments: []
        }
      ])
    }
    if (url.pathname === '/channels/random-thread/messages' && request.method === 'GET') {
      return Response.json([
        {
          id: 'random-hist-1',
          channel_id: 'random-thread',
          guild_id: 'guild-1',
          content: 'random thread context',
          author: { id: 'user-2' },
          attachments: []
        }
      ])
    }
    if (url.pathname === '/workflows/runs' && request.method === 'POST') {
      workflowRuns.push({ path: url.pathname, body: await request.json() })
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
              thread_id: 'thread-1'
            },
            final_payload: {
              result_text: 'final answer from warrunner'
            }
          }
        ]
      })
    }
    if (
      url.pathname === '/agent/final-deliveries/exec-1/delivered' &&
      request.method === 'POST'
    ) {
      delivered.push({ path: url.pathname, body: await request.json() })
      return Response.json({ ok: true, execution_id: 'exec-1' })
    }
    if (url.pathname === '/channels/thread-1/messages' && request.method === 'POST') {
      discordPosts.push({ path: url.pathname, body: await request.json() })
      return Response.json({ id: 'posted-1', channel_id: 'thread-1' })
    }
    if (url.pathname === '/channels/thread-1/typing' && request.method === 'POST') {
      typingPosts.push({ path: url.pathname, body: {} })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/channels/home-1/messages' && request.method === 'POST') {
      discordPosts.push({ path: url.pathname, body: await request.json() })
      return Response.json({ id: 'posted-home-1', channel_id: 'home-1' })
    }
    if (url.pathname === '/channels/home-1/typing' && request.method === 'POST') {
      typingPosts.push({ path: url.pathname, body: {} })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/channels/random-thread/typing' && request.method === 'POST') {
      typingPosts.push({ path: url.pathname, body: {} })
      return new Response(null, { status: 204 })
    }
    return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }))
    },
    message() {}
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

beforeAll(() => {
  const env = process.env as Record<string, string>
  env.NODE_ENV = 'test'
  env.DISCORD_GATEWAY_ENABLED = 'true'
  env.DISCORD_BOT_TOKEN = 'discord-token'
  delete env.DISCORD_APPLICATION_ID
  delete env.DISCORD_BOT_USER_ID
  env.DISCORD_GUILD_ID = 'guild-1'
  env.DISCORD_API_URL = fakeBaseUrl
  env.CENTAUR_API_URL = fakeBaseUrl
  env.DISCORDBOT_API_KEY = 'test-api-key'
  env.WARRUNNER_HOME_FORUM_CHANNEL_ID = 'forum-1'
  env.WARRUNNER_HOME_CHANNEL_IDS = 'home-1'
  env.WARRUNNER_HISTORY_LIMIT = '10'
})

beforeEach(() => {
  workflowRuns.length = 0
  discordPosts.length = 0
  delivered.length = 0
  typingPosts.length = 0
  finalDeliveryReady = false
  finalDeliveryClaimed = false
})

afterAll(() => {
  server.stop(true)
})

describe('discordbot local e2e', () => {
  it('reports ready after bot identity hydration', async () => {
    const { app } = await import('./index')
    let body: any
    await waitFor(async () => {
      const response = await app.request('/health/ready')
      body = await response.json()
      return response.status === 200 && body.ready === true
    })

    expect(body.bot_identity).toMatchObject({
      status: 'ready',
      id: 'bot-user',
      username: 'warrunner'
    })
    expect(body.checks.filter((check: any) => !check.ok)).toEqual([])
  })

  it('accepts a Discord thread message and starts the Centaur workflow', async () => {
    const { app } = await import('./index')
    const response = await app.request('/api/discord/events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: 'msg-1',
        channel_id: 'thread-1',
        guild_id: 'guild-1',
        content: '<@bot-user> ship the dogfood path',
        author: { id: 'user-1' },
        member: { roles: ['eng'] },
        attachments: []
      })
    })

    expect(response.status).toBe(200)
    await waitFor(() => workflowRuns.length === 1)
    expect(workflowRuns[0]?.body).toMatchObject({
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
          thread_id: 'thread-1'
        }
      }
    })
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('ship the dogfood path')
    expect(workflowRuns[0]?.body.input.history_messages).toHaveLength(2)
    await waitFor(() => typingPosts.some(post => post.path === '/channels/thread-1/typing'))
  })

  it('accepts a bot-mentioned home-channel message and starts a stable home workflow', async () => {
    const { app } = await import('./index')
    const response = await app.request('/api/discord/events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: 'home-msg-1',
        channel_id: 'home-1',
        guild_id: 'guild-1',
        content: '<@bot-user> run this from home',
        author: { id: 'user-1' },
        member: { roles: ['eng'] },
        mentions: [{ id: 'bot-user' }],
        attachments: []
      })
    })

    expect(response.status).toBe(200)
    await waitFor(() => workflowRuns.length === 1)
    expect(workflowRuns[0]?.body).toMatchObject({
      workflow_name: 'discord_thread_turn',
      input: {
        thread_key: 'discord:guild-1:home-1:home-1',
        message_id: 'discord:guild-1:home-1:home-msg-1',
        delivery: {
          platform: 'discord',
          guild_id: 'guild-1',
          channel_id: 'home-1',
          thread_id: 'home-1'
        }
      }
    })
    expect(workflowRuns[0]?.body.input.metadata.is_mention).toBe(true)
    expect(workflowRuns[0]?.body.input.history_messages).toHaveLength(1)
    await waitFor(() => typingPosts.some(post => post.path === '/channels/home-1/typing'))
  })

  it('accepts a bot mention in any Discord thread and keeps a separate workflow thread key', async () => {
    const { app } = await import('./index')
    const response = await app.request('/api/discord/events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: 'random-msg-1',
        channel_id: 'random-thread',
        guild_id: 'guild-1',
        content: '<@bot-user> work in this thread too',
        author: { id: 'user-1' },
        member: { roles: ['eng'] },
        mentions: [{ id: 'bot-user' }],
        attachments: []
      })
    })

    expect(response.status).toBe(200)
    await waitFor(() => workflowRuns.length === 1)
    expect(workflowRuns[0]?.body).toMatchObject({
      workflow_name: 'discord_thread_turn',
      trigger_key: 'discord:guild-1:random-thread:random-msg-1',
      input: {
        thread_key: 'discord:guild-1:random-forum:random-thread',
        message_id: 'discord:guild-1:random-thread:random-msg-1',
        delivery: {
          platform: 'discord',
          guild_id: 'guild-1',
          channel_id: 'random-thread',
          thread_id: 'random-thread',
          parent_channel_id: 'random-forum'
        }
      }
    })
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('work in this thread too')
    expect(workflowRuns[0]?.body.input.metadata.is_mention).toBe(true)
    expect(workflowRuns[0]?.body.input.history_messages).toHaveLength(1)
    await waitFor(() => typingPosts.some(post => post.path === '/channels/random-thread/typing'))
  })

  it('claims a final delivery and posts back into the Discord thread', async () => {
    finalDeliveryReady = true
    const config = loadConfig(process.env)
    await pollFinalDeliveriesOnce(config, new DiscordClient(config))

    expect(discordPosts).toHaveLength(1)
    expect(discordPosts[0]?.body).toEqual({
      content: 'final answer from warrunner',
      allowed_mentions: { parse: [] }
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.body.consumer_id).toStartWith('discordbot-')
  })
})

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
