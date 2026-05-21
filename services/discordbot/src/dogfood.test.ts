import { afterAll, describe, expect, it } from 'bun:test'
import { loadConfig, type AppConfig } from './config'
import { formatPreflight, runPreflight } from './dogfood'
import { formatEmulatedChatLoop, runEmulatedChatLoop } from './dogfood/emulated'

const centaurAuthHeaders: string[] = []

const server = Bun.serve({
  port: 0,
  fetch(request) {
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
