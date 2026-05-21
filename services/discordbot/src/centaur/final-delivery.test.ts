import { afterEach, describe, expect, it } from 'bun:test'
import { loadConfig } from '../config'
import { pollFinalDeliveriesOnce, splitFinalDeliveryText } from './final-delivery'

describe('splitFinalDeliveryText', () => {
  it('keeps short messages intact', () => {
    expect(splitFinalDeliveryText('done')).toEqual(['done'])
  })

  it('splits long messages at readable boundaries', () => {
    const text = `${'a '.repeat(1200)}\n\n${'b '.repeat(1200)}`
    const chunks = splitFinalDeliveryText(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 1900)).toBe(true)
    expect(chunks.join(' ')).toContain('a')
    expect(chunks.join(' ')).toContain('b')
  })
})

describe('pollFinalDeliveriesOnce', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('replies to the original Discord message on the first final-delivery chunk only', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    const delivered: string[] = []
    const delivery = {
      execution_id: 'exec-1',
      thread_key: 'discord:guild-1:forum-1:thread-1',
      delivery: {
        platform: 'discord',
        guild_id: 'guild-1',
        channel_id: 'thread-1',
        thread_id: 'thread-1',
        message_id: 'discord:guild-1:thread-1:source-msg-1'
      },
      final_payload: {
        result_text: `${'chunk '.repeat(500)}done`
      }
    }

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({ deliveries: [delivery] })
      }
      if (url.pathname === '/agent/final-deliveries/exec-1/delivered') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { consumer_id?: string }
        delivered.push(body.consumer_id ?? '')
        return Response.json({ ok: true })
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    }) as typeof fetch

    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3002',
      ENVIRONMENT: 'test',
      COMMIT_SHA: 'test',
      CENTAUR_API_URL: 'http://centaur.test',
      DISCORDBOT_API_KEY: 'centaur-key'
    } as NodeJS.ProcessEnv)
    const client = {
      createMessage: async (channelId: string, body: any) => {
        posts.push({ channelId, body })
        return { id: `posted-${posts.length}`, channel_id: channelId, content: body.content }
      }
    } as any

    const result = await pollFinalDeliveriesOnce(config, client)

    expect(result.delivered).toHaveLength(1)
    expect(posts.length).toBeGreaterThan(1)
    expect(posts[0]).toMatchObject({
      channelId: 'thread-1',
      body: {
        allowed_mentions: { parse: [] },
        message_reference: {
          message_id: 'source-msg-1',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          fail_if_not_exists: false
        }
      }
    })
    expect(posts.slice(1).every(post => post.body.message_reference === undefined)).toBe(true)
    expect(delivered[0]).toStartWith('discordbot-')
  })

  it('posts legacy final deliveries without a message reference', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: 'exec-legacy',
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: { platform: 'discord' },
              final_payload: { result_text: 'legacy final answer' }
            }
          ]
        })
      }
      if (url.pathname === '/agent/final-deliveries/exec-legacy/delivered') {
        return Response.json({ ok: true })
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    }) as typeof fetch

    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3002',
      ENVIRONMENT: 'test',
      COMMIT_SHA: 'test',
      CENTAUR_API_URL: 'http://centaur.test',
      DISCORDBOT_API_KEY: 'centaur-key'
    } as NodeJS.ProcessEnv)
    const client = {
      createMessage: async (channelId: string, body: any) => {
        posts.push({ channelId, body })
        return { id: `posted-${posts.length}`, channel_id: channelId, content: body.content }
      }
    } as any

    await pollFinalDeliveriesOnce(config, client)

    expect(posts).toEqual([
      {
        channelId: 'thread-1',
        body: {
          content: 'legacy final answer',
          allowed_mentions: { parse: [] }
        }
      }
    ])
  })
})
