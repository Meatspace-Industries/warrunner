import { afterAll, describe, expect, it } from 'bun:test'
import { loadConfig, type AppConfig } from './config'
import { dogfoodCommandExitCode, formatPreflight, runPreflight } from './dogfood'
import { formatEmulatedChatLoop, runEmulatedChatLoop } from './dogfood/emulated'
import { formatSmokePost, runSmokePost } from './dogfood/smoke'

const centaurAuthHeaders: string[] = []
const smokePosts: Array<{ authorization: string; body: any }> = []
const forumThreads: Array<{ authorization: string; body: any }> = []

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/users/@me' && request.method === 'GET') {
      return Response.json({ id: 'bot-user', username: 'warrunner', bot: true })
    }
    if (url.pathname === '/gateway/bot' && request.method === 'GET') {
      return Response.json({ url: 'wss://gateway.discord.test' })
    }
    if (url.pathname === '/channels/forum-1' && request.method === 'GET') {
      return Response.json({
        id: 'forum-1',
        type: 15,
        name: 'warrunner-forum',
        guild_id: 'guild-1'
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
    if (url.pathname === '/channels/smoke-1' && request.method === 'GET') {
      return Response.json({
        id: 'smoke-1',
        type: 0,
        name: 'dogfood-smoke',
        guild_id: 'guild-1'
      })
    }
    if (url.pathname === '/channels/smoke-1/messages' && request.method === 'POST') {
      smokePosts.push({
        authorization: request.headers.get('authorization') ?? '',
        body: await request.json()
      })
      return Response.json({ id: 'smoke-msg-1', channel_id: 'smoke-1' })
    }
    if (url.pathname === '/channels/forum-1/threads' && request.method === 'POST') {
      forumThreads.push({
        authorization: request.headers.get('authorization') ?? '',
        body: await request.json()
      })
      return Response.json({
        id: 'forum-thread-1',
        type: 11,
        name: 'Warrunner dogfood smoke',
        parent_id: 'forum-1',
        guild_id: 'guild-1',
        message: {
          id: 'forum-msg-1',
          channel_id: 'forum-thread-1',
          guild_id: 'guild-1',
          content: 'smoke the forum path',
          author: { id: 'bot-user', bot: true },
          attachments: []
        }
      })
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok' })
    }
    if (url.pathname === '/workflows/registered' && request.method === 'GET') {
      centaurAuthHeaders.push(request.headers.get('authorization') ?? '')
      return Response.json({
        workflows: [
          {
            name: 'discord_thread_turn',
            source_path: '/overlay/discord_thread_turn.py',
            version: 'test',
            scheduled: false
          }
        ]
      })
    }
    return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 })
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

describe('dogfood preflight', () => {
  it('checks Discord, Centaur, configured channels, and the Warrunner workflow', async () => {
    centaurAuthHeaders.length = 0
    const result = await runPreflight(testConfig())

    expect(result.ok).toBe(true)
    expect(formatPreflight(result)).toContain('PASS warrunner dogfood preflight passed')
    expect(result.checks.map(check => check.name)).toContain('discord_thread_turn workflow')
    expect(centaurAuthHeaders).toEqual(['Bearer centaur-key'])
  })

  it('fails locally without required dogfood configuration', async () => {
    const result = await runPreflight(loadConfig(requiredEnv()))
    const failed = result.checks.filter(check => !check.ok).map(check => check.name)

    expect(result.ok).toBe(false)
    expect(failed).toContain('DISCORD_BOT_TOKEN')
    expect(failed).toContain('DISCORDBOT_API_KEY')
    expect(failed).toContain('DISCORD_GUILD_ID')
    expect(failed).toContain('home route')
    expect(formatPreflight(result)).toContain('FAIL warrunner dogfood preflight failed')
  })
})

describe('dogfood command exit code', () => {
  it('requires requested transcript persistence for successful live dogfood commands', () => {
    expect(dogfoodCommandExitCode(true, true)).toBe(0)
    expect(dogfoodCommandExitCode(true, false)).toBe(1)
    expect(dogfoodCommandExitCode(false, true)).toBe(1)
    expect(dogfoodCommandExitCode(false, false)).toBe(1)
  })
})

describe('dogfood smoke post', () => {
  it('posts an explicit smoke message without allowed mentions', async () => {
    smokePosts.length = 0
    const result = await runSmokePost(testConfig(), {
      channelId: 'smoke-1',
      content: 'smoke the Discord write path'
    })
    const formatted = formatSmokePost(result)

    expect(result.ok).toBe(true)
    expect(smokePosts).toHaveLength(1)
    expect(smokePosts[0]).toEqual({
      authorization: 'Bot discord-token',
      body: {
        content: 'smoke the Discord write path',
        allowed_mentions: { parse: [] }
      }
    })
    expect(formatted).toContain('PASS Discord smoke post: #dogfood-smoke (smoke-1)')
  })

  it('creates a smoke thread in forum channels', async () => {
    smokePosts.length = 0
    forumThreads.length = 0
    const result = await runSmokePost(testConfig(), {
      channelId: 'forum-1',
      content: 'smoke the forum path',
      appliedTagIds: ['tag-1']
    })
    const formatted = formatSmokePost(result)

    expect(result.ok).toBe(true)
    expect(smokePosts).toHaveLength(0)
    expect(forumThreads).toEqual([
      {
        authorization: 'Bot discord-token',
        body: {
          name: 'Warrunner dogfood smoke',
          message: {
            content: 'smoke the forum path',
            allowed_mentions: { parse: [] }
          },
          applied_tags: ['tag-1']
        }
      }
    ])
    expect(formatted).toContain(
      'PASS Discord smoke forum thread: #warrunner-forum -> Warrunner dogfood smoke (forum-thread-1)'
    )
    expect(formatted).toContain('PASS message id: forum-msg-1')
  })
})

describe('dogfood emulated chat loop', () => {
  it('runs the full local Gateway-to-Discord-reply loop', async () => {
    const result = await runEmulatedChatLoop()
    const formatted = formatEmulatedChatLoop(result)

    expect(result.ok).toBe(true)
    expect(result.workflowRun?.body.workflow_name).toBe('discord_thread_turn')
    expect(result.discordPost?.body.content).toBe('gateway-to-discord final answer')
    expect(formatted).toContain('PASS emulated Discord Gateway MESSAGE_CREATE received')
    expect(formatted).toContain('PASS Discord reply posted')
  })
})

function testConfig(): AppConfig {
  return loadConfig({
    ...requiredEnv(),
    DISCORD_API_URL: fakeBaseUrl,
    DISCORD_BOT_TOKEN: 'discord-token',
    DISCORD_GUILD_ID: 'guild-1',
    CENTAUR_API_URL: fakeBaseUrl,
    DISCORDBOT_API_KEY: 'centaur-key',
    WARRUNNER_HOME_FORUM_CHANNEL_ID: 'forum-1',
    WARRUNNER_HOME_CHANNEL_IDS: 'home-1'
  })
}

function requiredEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ENVIRONMENT: 'test',
    PORT: '3002',
    COMMIT_SHA: 'test'
  }
}
