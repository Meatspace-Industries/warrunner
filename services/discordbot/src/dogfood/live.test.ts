import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { loadConfig, type AppConfig } from '../config'
import type { DiscordGatewayPayload } from '../discord/types'
import {
  formatLiveDogfood,
  formatLiveDogfoodSession,
  runLiveDogfood,
  runLiveDogfoodSession
} from './live'

setDefaultTimeout(10_000)

type CapturedRequest = {
  path: string
  authorization: string
  body: any
}

const forumThreads: CapturedRequest[] = []
const workflowRuns: CapturedRequest[] = []
const discordPosts: CapturedRequest[] = []
const delivered: CapturedRequest[] = []
const pendingDeliveries: any[] = []

let activeGateway: any = null
let liveTargetReady = false
let liveConversationChannelId = 'live-thread-1'
let liveParentChannelId: string | undefined = 'forum-1'
let liveDispatchThreadCreate = true
let liveMessageCursor = 0
let liveMessages: string[] = []
let deliveryTexts: string[] = []
let liveMessageTimers: Array<ReturnType<typeof setTimeout>> = []

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
      liveTargetReady = true
      liveConversationChannelId = 'live-thread-1'
      liveParentChannelId = 'forum-1'
      liveDispatchThreadCreate = true
      scheduleLiveDiscordMessage()
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
    if (url.pathname === '/channels/home-1' && request.method === 'GET') {
      return Response.json({
        id: 'home-1',
        type: 0,
        name: 'warrunner-home',
        guild_id: 'guild-1'
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
      scheduleLiveDiscordMessage()
      return Response.json({ id: `reply-msg-${discordPosts.length}`, channel_id: 'live-thread-1' })
    }
    if (url.pathname === '/channels/home-1/messages' && request.method === 'GET') {
      return Response.json([
        {
          id: 'home-hist-1',
          channel_id: 'home-1',
          guild_id: 'guild-1',
          content: 'home channel context',
          author: { id: 'bot-user', bot: true },
          attachments: []
        }
      ])
    }
    if (url.pathname === '/channels/home-1/messages' && request.method === 'POST') {
      const captured = await capture(request, url.pathname)
      discordPosts.push(captured)
      liveTargetReady = true
      liveConversationChannelId = 'home-1'
      liveParentChannelId = undefined
      liveDispatchThreadCreate = false
      scheduleLiveDiscordMessage()
      return Response.json({ id: `home-msg-${discordPosts.length}`, channel_id: 'home-1' })
    }
    if (url.pathname === '/workflows/runs' && request.method === 'POST') {
      const captured = await capture(request, url.pathname)
      workflowRuns.push(captured)
      const runIndex = workflowRuns.length
      pendingDeliveries.push({
        execution_id: `exec-${runIndex}`,
        thread_key: captured.body.input.thread_key,
        delivery: captured.body.input.delivery,
        final_payload: {
          result_text: deliveryTexts[runIndex - 1] ?? `live dogfood final answer ${runIndex}`
        }
      })
      return Response.json({ ok: true, run_id: 'run-1' })
    }
    if (url.pathname === '/agent/final-deliveries/claim' && request.method === 'POST') {
      await request.json()
      return Response.json({ deliveries: pendingDeliveries.splice(0, 5) })
    }
    if (
      url.pathname.startsWith('/agent/final-deliveries/') &&
      url.pathname.endsWith('/delivered') &&
      request.method === 'POST'
    ) {
      delivered.push(await capture(request, url.pathname))
      return Response.json({ ok: true })
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
  for (const timer of liveMessageTimers) clearTimeout(timer)
  liveMessageTimers = []
  forumThreads.length = 0
  workflowRuns.length = 0
  discordPosts.length = 0
  delivered.length = 0
  pendingDeliveries.length = 0
  activeGateway = null
  liveTargetReady = false
  liveConversationChannelId = 'live-thread-1'
  liveParentChannelId = 'forum-1'
  liveDispatchThreadCreate = true
  liveMessageCursor = 0
  liveMessages = ['live dogfood from Discord']
  deliveryTexts = ['live dogfood final answer']
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
      timeoutMs: 5_000,
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
    expect(
      progress.some(line => line.includes('https://discord.com/channels/guild-1/live-thread-1'))
    ).toBe(true)
    expect(progress.some(line => line.includes('PASS live Discord message accepted'))).toBe(true)
    expect(formatted).toContain('PASS live Discord chat loop completed')
    expect(formatted).toContain('PASS Discord URL: https://discord.com/channels/guild-1/live-thread-1')
    expect(formatted).toContain('PASS Discord reply posted: reply-msg-1')
  })

  it('runs live dogfood in a configured home channel with a bot mention', async () => {
    const progress: string[] = []
    const result = await runLiveDogfood(
      testConfig({
        WARRUNNER_HOME_FORUM_CHANNEL_ID: '',
        WARRUNNER_HOME_CHANNEL_IDS: 'home-1',
        WARRUNNER_HOME_CHANNEL_MENTION_REQUIRED: 'true'
      }),
      {
        channelId: 'home-1',
        content: 'open home dogfood',
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        onProgress: line => progress.push(line)
      }
    )
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(forumThreads).toHaveLength(0)
    expect(workflowRuns[0]).toMatchObject({
      path: '/workflows/runs',
      authorization: 'Bearer centaur-key',
      body: {
        workflow_name: 'discord_thread_turn',
        input: {
          thread_key: 'discord:guild-1:home-1:home-1',
          message_id: 'discord:guild-1:home-1:live-msg-1',
          delivery: {
            platform: 'discord',
            guild_id: 'guild-1',
            channel_id: 'home-1',
            thread_id: 'home-1'
          }
        }
      }
    })
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('live dogfood from Discord')
    expect(workflowRuns[0]?.body.input.metadata.discord.is_mention).toBe(true)
    expect(discordPosts).toHaveLength(2)
    expect(discordPosts[0]).toMatchObject({
      path: '/channels/home-1/messages',
      authorization: 'Bot discord-token',
      body: {
        content: 'open home dogfood',
        allowed_mentions: { parse: [] }
      }
    })
    expect(discordPosts[1]).toMatchObject({
      path: '/channels/home-1/messages',
      authorization: 'Bot discord-token',
      body: {
        content: 'live dogfood final answer',
        allowed_mentions: { parse: [] }
      }
    })
    expect(delivered).toHaveLength(1)
    expect(result.target.createdThread).toBeUndefined()
    expect(result.target.discordUrl).toBe('https://discord.com/channels/guild-1/home-1')
    expect(progress.some(line => line.includes('PASS live target ready'))).toBe(true)
    expect(progress.some(line => line.includes('https://discord.com/channels/guild-1/home-1'))).toBe(true)
    expect(formatted).toContain('PASS live Discord chat loop completed')
    expect(formatted).toContain('PASS Discord URL: https://discord.com/channels/guild-1/home-1')
    expect(formatted).toContain('PASS Discord reply posted: home-msg-2')
  })

  it('keeps a live session open for multiple Discord turns', async () => {
    liveMessages = ['first session turn', 'second session turn']
    const result = await runLiveDogfoodSession(testConfig(), {
      channelId: 'forum-1',
      content: 'open multi-turn dogfood',
      turnLimit: 2,
      timeoutMs: 5_000,
      pollIntervalMs: 10
    })
    const formatted = formatLiveDogfoodSession(result)

    expect(result.ok).toBe(true)
    expect(workflowRuns).toHaveLength(2)
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('first session turn')
    expect(workflowRuns[1]?.body.input.parts[0].text).toBe('second session turn')
    expect(discordPosts.map(post => post.body.content)).toEqual([
      'live dogfood final answer',
      'live dogfood final answer 2'
    ])
    expect(delivered).toHaveLength(2)
    expect(formatted).toContain('PASS live Discord dogfood session completed')
    expect(formatted).toContain('PASS Discord URL: https://discord.com/channels/guild-1/live-thread-1')
    expect(formatted).toContain('PASS turns completed: 2')
    expect(formatted).toContain('PASS turn 2: second session turn -> reply-msg-2')
  })

  it('counts chunked Discord final-delivery replies as one live session turn', async () => {
    liveMessages = ['chunked session turn', 'after chunked reply']
    deliveryTexts = ['chunk '.repeat(500), 'second reply after chunked delivery']
    const result = await runLiveDogfoodSession(testConfig(), {
      channelId: 'forum-1',
      content: 'open chunked dogfood',
      turnLimit: 2,
      timeoutMs: 5_000,
      pollIntervalMs: 10
    })
    const formatted = formatLiveDogfoodSession(result)

    expect(result.ok).toBe(true)
    expect(workflowRuns).toHaveLength(2)
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('chunked session turn')
    expect(workflowRuns[1]?.body.input.parts[0].text).toBe('after chunked reply')
    expect(discordPosts).toHaveLength(3)
    expect(discordPosts[0]?.body.content).toStartWith('chunk')
    expect(discordPosts[1]?.body.content).toStartWith('chunk')
    expect(discordPosts[2]?.body.content).toBe('second reply after chunked delivery')
    expect(delivered).toHaveLength(2)
    expect(formatted).toContain('PASS turn 1: chunked session turn -> reply-msg-1')
    expect(formatted).toContain('PASS turn 2: after chunked reply -> reply-msg-3')
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
  if (!activeGateway || !liveTargetReady) return
  const content = liveMessages[liveMessageCursor]
  if (!content) return
  const messageIndex = liveMessageCursor + 1
  liveMessageCursor += 1
  if (liveDispatchThreadCreate) {
    activeGateway.send(
      JSON.stringify({
        op: 0,
        t: 'THREAD_CREATE',
        s: messageIndex * 2 - 1,
        d: {
          id: liveConversationChannelId,
          type: 11,
          guild_id: 'guild-1',
          parent_id: liveParentChannelId
        }
      })
    )
  }
  activeGateway.send(
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: messageIndex * 2,
      d: {
        id: `live-msg-${messageIndex}`,
        channel_id: liveConversationChannelId,
        guild_id: 'guild-1',
        content: `<@bot-user> ${content}`,
        author: { id: 'user-1' },
        mentions: [{ id: 'bot-user' }],
        attachments: []
      }
    })
  )
}

function scheduleLiveDiscordMessage(): void {
  const timer = setTimeout(() => {
    liveMessageTimers = liveMessageTimers.filter(item => item !== timer)
    sendLiveDiscordMessage()
  }, 10)
  liveMessageTimers.push(timer)
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
