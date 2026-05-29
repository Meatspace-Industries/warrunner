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
    const typingStops: Array<{ threadKey?: string; channelId?: string }> = []

    const result = await pollFinalDeliveriesOnce(config, client, {
      start: () => {},
      stop: target => typingStops.push(target)
    })

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
    expect(typingStops).toEqual([
      {
        threadKey: 'discord:guild-1:forum-1:thread-1',
        channelId: 'thread-1'
      }
    ])
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

  it('marks workflow reminder deliveries with encoded execution ids', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    const delivered: Array<{ path: string; body: any }> = []
    const executionId = 'workflow:wfr_123:discord-reminder'
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: executionId,
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: {
                platform: 'discord',
                guild_id: 'guild-1',
                thread_id: 'thread-1',
                message_id: 'discord:guild-1:thread-1:source-msg-1'
              },
              final_payload: {
                result_text: '<@123456789012345678> Reminder: check deploy',
                allowed_mention_user_ids: ['123456789012345678', 'not-a-user-id', '123456789012345678']
              }
            }
          ]
        })
      }
      if (url.pathname === `/agent/final-deliveries/${encodeURIComponent(executionId)}/delivered`) {
        delivered.push({
          path: url.pathname,
          body: JSON.parse(String(init?.body ?? '{}'))
        })
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
    expect(posts).toEqual([
      {
        channelId: 'thread-1',
        body: {
          content: '<@123456789012345678> Reminder: check deploy',
          allowed_mentions: { parse: [], users: ['123456789012345678'] },
          message_reference: {
            message_id: 'source-msg-1',
            channel_id: 'thread-1',
            guild_id: 'guild-1',
            fail_if_not_exists: false
          }
        }
      }
    ])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.body.consumer_id).toStartWith('discordbot-')
  })

  it('rewrites configured user aliases into safe Discord mentions', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: 'exec-mention',
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: { platform: 'discord', guild_id: 'guild-1', thread_id: 'thread-1' },
              final_payload: {
                result_text: '@Meepo please check this. @unknown should stay literal.'
              }
            }
          ]
        })
      }
      if (url.pathname === '/agent/final-deliveries/exec-mention/delivered') {
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
      DISCORDBOT_API_KEY: 'centaur-key',
      WARRUNNER_MENTION_USER_ALIASES: 'meepo=1500785594068897792'
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
          content: '<@1500785594068897792> please check this. @unknown should stay literal.',
          allowed_mentions: { parse: [], users: ['1500785594068897792'] }
        }
      }
    ])
  })

  it('rewrites configured leading addressee aliases into safe Discord mentions', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: 'exec-leading-alias',
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: { platform: 'discord', guild_id: 'guild-1', thread_id: 'thread-1' },
              final_payload: {
                result_text: 'Meepo: stop tracking these as Codex failures for now.'
              }
            }
          ]
        })
      }
      if (url.pathname === '/agent/final-deliveries/exec-leading-alias/delivered') {
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
      DISCORDBOT_API_KEY: 'centaur-key',
      WARRUNNER_MENTION_USER_ALIASES: 'meepo=1500785594068897792'
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
          content: '<@1500785594068897792>: stop tracking these as Codex failures for now.',
          allowed_mentions: { parse: [], users: ['1500785594068897792'] }
        }
      }
    ])
  })

  it('does not rewrite alias-looking text inside URLs', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: 'exec-url-alias',
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: { platform: 'discord', guild_id: 'guild-1', thread_id: 'thread-1' },
              final_payload: {
                result_text: 'Profile: https://x.com/@Meepo and real mention @Meepo.'
              }
            }
          ]
        })
      }
      if (url.pathname === '/agent/final-deliveries/exec-url-alias/delivered') {
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
      DISCORDBOT_API_KEY: 'centaur-key',
      WARRUNNER_MENTION_USER_ALIASES: 'meepo=1500785594068897792'
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
          content: 'Profile: https://x.com/@Meepo and real mention <@1500785594068897792>.',
          allowed_mentions: { parse: [], users: ['1500785594068897792'] }
        }
      }
    ])
  })

  it('does not enable arbitrary raw user pings without payload or alias allowlisting', async () => {
    const posts: Array<{ channelId: string; body: any }> = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: 'exec-raw-mention',
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: { platform: 'discord', guild_id: 'guild-1', thread_id: 'thread-1' },
              final_payload: {
                result_text: '<@123456789012345678> stays visible but should not notify'
              }
            }
          ]
        })
      }
      if (url.pathname === '/agent/final-deliveries/exec-raw-mention/delivered') {
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
          content: '<@123456789012345678> stays visible but should not notify',
          allowed_mentions: { parse: [] }
        }
      }
    ])
  })

  it('returns failed delivery target metadata for Discord post failures', async () => {
    const failed: Array<{ path: string; body: any }> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/agent/final-deliveries/claim') {
        return Response.json({
          deliveries: [
            {
              execution_id: 'exec-failed',
              thread_key: 'discord:guild-1:forum-1:thread-1',
              delivery: {
                platform: 'discord',
                guild_id: 'guild-1',
                channel_id: 'thread-1',
                thread_id: 'thread-1',
                message_id: 'discord:guild-1:thread-1:source-msg-1'
              },
              final_payload: { result_text: 'cannot post this answer' }
            }
          ]
        })
      }
      if (url.pathname === '/agent/final-deliveries/exec-failed/failed') {
        failed.push({
          path: url.pathname,
          body: JSON.parse(String(init?.body ?? '{}'))
        })
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
      createMessage: async () => {
        throw new Error('discord_forbidden: Missing Permissions')
      }
    } as any
    const typingStops: Array<{ threadKey?: string; channelId?: string }> = []

    const result = await pollFinalDeliveriesOnce(config, client, {
      start: () => {},
      stop: target => typingStops.push(target)
    })

    expect(result.delivered).toHaveLength(0)
    expect(result.failed).toEqual([
      {
        executionId: 'exec-failed',
        error: 'discord_forbidden: Missing Permissions',
        errorClass: 'discord_forbidden',
        channelId: 'thread-1',
        guildId: 'guild-1',
        messageId: 'source-msg-1'
      }
    ])
    expect(failed).toHaveLength(1)
    expect(failed[0]?.body).toMatchObject({
      error: 'discord_forbidden: Missing Permissions',
      error_class: 'discord_forbidden',
      non_retryable: true
    })
    expect(typingStops).toEqual([
      {
        threadKey: 'discord:guild-1:forum-1:thread-1',
        channelId: 'thread-1'
      }
    ])
  })
})
