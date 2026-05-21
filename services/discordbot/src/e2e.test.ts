import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
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
let finalDeliveryReady = false
let finalDeliveryClaimed = false

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/channels/thread-1' && request.method === 'GET') {
      return Response.json({
        id: 'thread-1',
        type: 11,
        parent_id: 'forum-1',
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
    return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 })
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

beforeAll(() => {
  const env = process.env as Record<string, string>
  env.NODE_ENV = 'test'
  env.DISCORD_GATEWAY_ENABLED = 'false'
  env.DISCORD_BOT_TOKEN = 'discord-token'
  env.DISCORD_APPLICATION_ID = 'bot-user'
  env.DISCORD_GUILD_ID = 'guild-1'
  env.DISCORD_API_URL = fakeBaseUrl
  env.CENTAUR_API_URL = fakeBaseUrl
  env.DISCORDBOT_API_KEY = 'test-api-key'
  env.WARRUNNER_HOME_FORUM_CHANNEL_ID = 'forum-1'
  env.WARRUNNER_HISTORY_LIMIT = '10'
})

afterAll(() => {
  server.stop(true)
})

describe('discordbot local e2e', () => {
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
