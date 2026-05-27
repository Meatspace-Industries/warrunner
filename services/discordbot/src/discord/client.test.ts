import { afterAll, describe, expect, it } from 'bun:test'
import { loadConfig } from '../config'
import { DiscordClient } from './client'

const seenPaths: string[] = []

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    seenPaths.push(url.pathname)
    if (url.pathname === '/api/v10/gateway/bot') {
      return Response.json({ url: 'wss://gateway.discord.test' })
    }
    if (url.pathname === '/api/v10/channels/thread-1/typing' && request.method === 'POST') {
      return new Response(null, { status: 204 })
    }
    return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 })
  }
})

afterAll(() => {
  server.stop(true)
})

describe('DiscordClient', () => {
  it('preserves a pathful Discord API base URL', async () => {
    seenPaths.length = 0
    const config = loadConfig({
      NODE_ENV: 'test',
      DISCORD_API_URL: `http://127.0.0.1:${server.port}/api/v10`,
      DISCORD_BOT_TOKEN: 'discord-token'
    } as unknown as NodeJS.ProcessEnv)

    await expect(new DiscordClient(config).gatewayBotUrl()).resolves.toBe(
      'wss://gateway.discord.test'
    )
    expect(seenPaths).toEqual(['/api/v10/gateway/bot'])
  })

  it('sends Discord typing indicators to the channel typing endpoint', async () => {
    seenPaths.length = 0
    const config = loadConfig({
      NODE_ENV: 'test',
      DISCORD_API_URL: `http://127.0.0.1:${server.port}/api/v10`,
      DISCORD_BOT_TOKEN: 'discord-token'
    } as unknown as NodeJS.ProcessEnv)

    await expect(new DiscordClient(config).triggerTyping('thread-1')).resolves.toBeUndefined()
    expect(seenPaths).toEqual(['/api/v10/channels/thread-1/typing'])
  })
})
