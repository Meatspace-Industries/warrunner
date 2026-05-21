import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type AppConfig } from '../config'
import type { DiscordGatewayPayload } from '../discord/types'
import {
  formatLiveDogfood,
  formatLiveDogfoodSession,
  runLiveDogfood,
  runLiveDogfoodSession
} from './live'
import { prepareDogfoodTranscriptDir, writeDogfoodTranscript } from './transcript'

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
const createdDiscordMessages: any[] = []
const externalDiscordReplies: any[] = []
const historyDiscordMessages: any[] = []

let activeGateway: any = null
let liveTargetReady = false
let liveConversationChannelId = 'live-thread-1'
let liveParentChannelId: string | undefined = 'forum-1'
let liveDispatchThreadCreate = true
let liveDispatchGatewayMessages = true
let liveMirrorGatewayMessagesToHistory = false
let liveMessageCursor = 0
let liveMessages: string[] = []
let deliveryTexts: string[] = []
let injectStaleDeliveryBeforeNext = false
let dropExpectedDeliveryAfterStale = false
let externalDeliveryClaimedByService = false
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
    if (url.pathname === '/channels/live-thread-1' && request.method === 'GET') {
      return Response.json({
        id: 'live-thread-1',
        type: 11,
        name: 'existing-warrunner-thread',
        parent_id: 'forum-1',
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
    if (url.pathname === '/channels/live-thread-1/messages' && request.method === 'GET') {
      if (url.searchParams.has('after')) {
        return Response.json(channelReplies('live-thread-1'))
      }
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
      const captured = await capture(request, url.pathname)
      discordPosts.push(captured)
      const message = {
        id: `reply-msg-${discordPosts.length}`,
        channel_id: 'live-thread-1',
        guild_id: 'guild-1',
        content: captured.body.content,
        author: { id: 'bot-user', bot: true },
        attachments: []
      }
      createdDiscordMessages.push(message)
      scheduleLiveDiscordMessage()
      return Response.json(message)
    }
    if (url.pathname === '/channels/home-1/messages' && request.method === 'GET') {
      if (url.searchParams.has('after')) {
        return Response.json(channelReplies('home-1'))
      }
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
      const message = {
        id: `home-msg-${discordPosts.length}`,
        channel_id: 'home-1',
        guild_id: 'guild-1',
        content: captured.body.content,
        author: { id: 'bot-user', bot: true },
        attachments: []
      }
      createdDiscordMessages.push(message)
      liveTargetReady = true
      liveConversationChannelId = 'home-1'
      liveParentChannelId = undefined
      liveDispatchThreadCreate = false
      scheduleLiveDiscordMessage()
      return Response.json(message)
    }
    if (url.pathname === '/workflows/runs' && request.method === 'POST') {
      const captured = await capture(request, url.pathname)
      workflowRuns.push(captured)
      const runIndex = workflowRuns.length
      const finalText = deliveryTexts[runIndex - 1] ?? `live dogfood final answer ${runIndex}`
      if (externalDeliveryClaimedByService) {
        externalDiscordReplies.push({
          id: `external-reply-${runIndex}`,
          channel_id: captured.body.input.delivery.thread_id ?? captured.body.input.delivery.channel_id,
          guild_id: captured.body.input.delivery.guild_id,
          content: finalText,
          author: { id: 'bot-user', bot: true },
          attachments: []
        })
        return Response.json({ ok: true, run_id: `run-${runIndex}`, execution_id: `exec-${runIndex}` })
      }
      if (injectStaleDeliveryBeforeNext) {
        injectStaleDeliveryBeforeNext = false
        pendingDeliveries.push({
          execution_id: `stale-exec-${runIndex}`,
          thread_key: captured.body.input.thread_key,
          delivery: captured.body.input.delivery,
          final_payload: {
            result_text: 'stale same-channel final answer'
          }
        })
        if (dropExpectedDeliveryAfterStale) {
          return Response.json({ ok: true, run_id: `run-${runIndex}`, execution_id: `exec-${runIndex}` })
        }
      }
      pendingDeliveries.push({
        execution_id: `exec-${runIndex}`,
        thread_key: captured.body.input.thread_key,
        delivery: captured.body.input.delivery,
        final_payload: {
          result_text: finalText
        }
      })
      return Response.json({ ok: true, run_id: `run-${runIndex}`, execution_id: `exec-${runIndex}` })
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
  createdDiscordMessages.length = 0
  externalDiscordReplies.length = 0
  historyDiscordMessages.length = 0
  activeGateway = null
  liveTargetReady = false
  liveConversationChannelId = 'live-thread-1'
  liveParentChannelId = 'forum-1'
  liveDispatchThreadCreate = true
  liveDispatchGatewayMessages = true
  liveMirrorGatewayMessagesToHistory = false
  liveMessageCursor = 0
  liveMessages = ['live dogfood from Discord']
  deliveryTexts = ['live dogfood final answer']
  injectStaleDeliveryBeforeNext = false
  dropExpectedDeliveryAfterStale = false
  externalDeliveryClaimedByService = false
})

afterAll(() => {
  server.stop(true)
})

describe('live dogfood chat loop', () => {
  it('preflights transcript directory writability before live dogfood starts', async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), 'warrunner-dogfood-preflight-'))
    try {
      const prepared = await prepareDogfoodTranscriptDir(transcriptDir)
      expect(prepared.ok).toBe(true)
      if (!prepared.ok || 'skipped' in prepared) throw new Error('transcript dir was not prepared')
      expect(prepared.path).toBe(transcriptDir)

      const failed = await prepareDogfoodTranscriptDir('/dev/null/warrunner')
      expect(failed.ok).toBe(false)
      if (failed.ok) throw new Error('expected /dev/null/warrunner to fail')
      expect(failed.error).toContain('not a directory')
    } finally {
      await rm(transcriptDir, { recursive: true, force: true })
    }
  })

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
          message_id: 'discord:guild-1:live-thread-1:live-msg-1',
          delivery: {
            message_id: 'live-msg-1'
          }
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
        allowed_mentions: { parse: [] },
        message_reference: {
          message_id: 'live-msg-1',
          channel_id: 'live-thread-1',
          guild_id: 'guild-1',
          fail_if_not_exists: false
        }
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
    expect(formatted).toContain(
      'PASS Discord message URL: https://discord.com/channels/guild-1/live-thread-1/live-msg-1'
    )
    expect(formatted).toContain('PASS Discord reply posted: reply-msg-1')
    expect(formatted).toContain(
      'PASS Discord reply URL: https://discord.com/channels/guild-1/live-thread-1/reply-msg-1'
    )
    expect(formatted).toContain('PASS Discord reply source: final_delivery')
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
            thread_id: 'home-1',
            message_id: 'live-msg-1'
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
        allowed_mentions: { parse: [] },
        message_reference: {
          message_id: 'live-msg-1',
          channel_id: 'home-1',
          guild_id: 'guild-1',
          fail_if_not_exists: false
        }
      }
    })
    expect(delivered).toHaveLength(1)
    expect(result.target.createdThread).toBeUndefined()
    expect(result.target.discordUrl).toBe('https://discord.com/channels/guild-1/home-1')
    expect(progress.some(line => line.includes('PASS live target ready'))).toBe(true)
    expect(progress.some(line => line.includes('https://discord.com/channels/guild-1/home-1'))).toBe(true)
    expect(formatted).toContain('PASS live Discord chat loop completed')
    expect(formatted).toContain('PASS Discord URL: https://discord.com/channels/guild-1/home-1')
    expect(formatted).toContain(
      'PASS Discord message URL: https://discord.com/channels/guild-1/home-1/live-msg-1'
    )
    expect(formatted).toContain('PASS Discord reply posted: home-msg-2')
    expect(formatted).toContain(
      'PASS Discord reply URL: https://discord.com/channels/guild-1/home-1/home-msg-2'
    )
  })

  it('recovers a fresh Discord message from channel history when Gateway intake misses it', async () => {
    liveDispatchGatewayMessages = false
    const progress: string[] = []
    const result = await runLiveDogfood(testConfig(), {
      channelId: 'forum-1',
      content: 'open history fallback dogfood',
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onProgress: line => {
        progress.push(line)
        if (line.includes('PASS live target ready')) {
          historyDiscordMessages.push({
            id: 'history-msg-1',
            channel_id: 'live-thread-1',
            guild_id: 'guild-1',
            content: '<@bot-user> recovered from channel history',
            author: { id: 'user-1' },
            mentions: [{ id: 'bot-user' }],
            attachments: []
          })
        }
      }
    })
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(true)
    expect(progress).toContain('PASS live Discord history intake: history-msg-1')
    expect(workflowRuns).toHaveLength(1)
    expect(workflowRuns[0]?.body.input).toMatchObject({
      thread_key: 'discord:guild-1:forum-1:live-thread-1',
      message_id: 'discord:guild-1:live-thread-1:history-msg-1',
      delivery: {
        message_id: 'history-msg-1'
      }
    })
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('recovered from channel history')
    expect(discordPosts).toHaveLength(1)
    expect(discordPosts[0]?.body.message_reference).toMatchObject({
      message_id: 'history-msg-1',
      channel_id: 'live-thread-1',
      guild_id: 'guild-1',
      fail_if_not_exists: false
    })
    expect(formatted).toContain(
      'PASS Discord message URL: https://discord.com/channels/guild-1/live-thread-1/history-msg-1'
    )
    expect(formatted).toContain('PASS Discord reply posted: reply-msg-1')
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
    expect(discordPosts.map(post => post.body.message_reference?.message_id)).toEqual([
      'live-msg-1',
      'live-msg-2'
    ])
    expect(delivered).toHaveLength(2)
    expect(formatted).toContain('PASS live Discord dogfood session completed')
    expect(formatted).toContain('PASS Discord URL: https://discord.com/channels/guild-1/live-thread-1')
    expect(formatted).toContain('PASS turns completed: 2')
    expect(formatted).toContain('PASS stop reason: turn_limit')
    expect(formatted).toContain('PASS turn 2: second session turn -> reply-msg-2 [exec-2] via final_delivery')
    expect(formatted).toContain(
      'https://discord.com/channels/guild-1/live-thread-1/live-msg-2 -> https://discord.com/channels/guild-1/live-thread-1/reply-msg-2'
    )
  })

  it('does not hand off a Gateway message again when it remains visible in channel history', async () => {
    liveMirrorGatewayMessagesToHistory = true
    liveMessages = ['gateway mirrored turn', 'next mirrored turn']
    const result = await runLiveDogfoodSession(testConfig(), {
      channelId: 'forum-1',
      content: 'open mirrored-history dogfood',
      turnLimit: 2,
      timeoutMs: 5_000,
      pollIntervalMs: 10
    })

    expect(result.ok).toBe(true)
    expect(workflowRuns).toHaveLength(2)
    expect(workflowRuns.map(run => run.body.input.message_id)).toEqual([
      'discord:guild-1:live-thread-1:live-msg-1',
      'discord:guild-1:live-thread-1:live-msg-2'
    ])
  })

  it('keeps an open-ended live session running until the timeout expires', async () => {
    liveMessages = ['open-ended session turn']
    const progress: string[] = []
    const result = await runLiveDogfoodSession(testConfig(), {
      channelId: 'live-thread-1',
      setupMode: 'attach',
      untilTimeout: true,
      timeoutMs: 80,
      pollIntervalMs: 10,
      onProgress: line => {
        progress.push(line)
        if (line.includes('PASS live target ready')) {
          liveTargetReady = true
          liveConversationChannelId = 'live-thread-1'
          liveParentChannelId = 'forum-1'
          scheduleLiveDiscordMessage()
        }
      }
    })
    const formatted = formatLiveDogfoodSession(result)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected open-ended session to pass')
    expect(result.turns).toHaveLength(1)
    expect(result.stopReason).toBe('idle_timeout')
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('open-ended session turn')
    expect(progress).toContain('PASS live Discord session idle timeout after 1 turns')
    expect(formatted).toContain('PASS turns completed: 1')
    expect(formatted).toContain('PASS stop reason: idle_timeout')
  })

  it('attaches to an existing forum thread without posting a setup prompt', async () => {
    liveMessages = ['attached session turn']
    deliveryTexts = ['attached final answer']
    const progress: string[] = []
    const result = await runLiveDogfood(testConfig(), {
      channelId: 'live-thread-1',
      setupMode: 'attach',
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onProgress: line => {
        progress.push(line)
        if (line.includes('PASS live target ready')) {
          liveTargetReady = true
          liveConversationChannelId = 'live-thread-1'
          liveParentChannelId = 'forum-1'
          scheduleLiveDiscordMessage()
        }
      }
    })
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(true)
    expect(forumThreads).toHaveLength(0)
    expect(workflowRuns).toHaveLength(1)
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('attached session turn')
    expect(discordPosts.map(post => post.body.content)).toEqual(['attached final answer'])
    expect(progress.some(line => line.includes('reply in that thread'))).toBe(true)
    expect(formatted).toContain('PASS target: #existing-warrunner-thread (live-thread-1)')
    expect(formatted).toContain('PASS Discord reply posted: reply-msg-1')
  })

  it('rejects attach mode for forum parents that need a conversation thread', async () => {
    const result = await runLiveDogfood(testConfig(), {
      channelId: 'forum-1',
      setupMode: 'attach',
      timeoutMs: 50,
      pollIntervalMs: 10
    })
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(false)
    expect(forumThreads).toHaveLength(0)
    expect(workflowRuns).toHaveLength(0)
    expect(discordPosts).toHaveLength(0)
    expect(formatted).toContain('live_attach_requires_conversation_channel:forum-1')
    expect(formatted).toContain('Pass an existing forum thread id')
  })

  it('correlates live replies to the accepted workflow execution id', async () => {
    liveMessages = ['execution-correlated session turn']
    deliveryTexts = ['execution-correlated final answer']
    injectStaleDeliveryBeforeNext = true
    const result = await runLiveDogfood(testConfig(), {
      channelId: 'forum-1',
      content: 'open execution-correlated dogfood',
      timeoutMs: 5_000,
      pollIntervalMs: 10
    })
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected live dogfood to pass')
    expect(result.executionId).toBe('exec-1')
    expect(result.reply.message.id).toBe('reply-msg-2')
    expect(result.reply.content).toBe('execution-correlated final answer')
    expect(discordPosts.map(post => post.body.content)).toEqual([
      'stale same-channel final answer',
      'execution-correlated final answer'
    ])
    expect(delivered.map(item => item.path)).toEqual([
      '/agent/final-deliveries/stale-exec-1/delivered',
      '/agent/final-deliveries/exec-1/delivered'
    ])
    expect(formatted).toContain('PASS workflow execution: exec-1')
    expect(formatted).toContain('PASS Discord reply posted: reply-msg-2')
  })

  it('counts a bot reply posted by another running Discordbot instance', async () => {
    liveMessages = ['externally delivered session turn']
    deliveryTexts = ['externally posted final answer']
    externalDeliveryClaimedByService = true
    const result = await runLiveDogfood(testConfig(), {
      channelId: 'live-thread-1',
      setupMode: 'attach',
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onProgress: line => {
        if (line.includes('PASS live target ready')) {
          liveTargetReady = true
          liveConversationChannelId = 'live-thread-1'
          liveParentChannelId = 'forum-1'
          scheduleLiveDiscordMessage()
        }
      }
    })
    const formatted = formatLiveDogfood(result)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected live dogfood to pass')
    expect(workflowRuns).toHaveLength(1)
    expect(workflowRuns[0]?.body.input.parts[0].text).toBe('externally delivered session turn')
    expect(discordPosts).toHaveLength(0)
    expect(delivered).toHaveLength(0)
    expect(result.reply.message.id).toBe('external-reply-1')
    expect(result.reply.content).toBe('externally posted final answer')
    expect(result.reply.source).toBe('channel_history')
    expect(formatted).toContain('PASS Discord reply posted: external-reply-1')
    expect(formatted).toContain('PASS Discord reply source: channel_history')
  })

  it('does not count a locally posted stale execution as an external bot reply', async () => {
    liveMessages = ['stale-only session turn']
    injectStaleDeliveryBeforeNext = true
    dropExpectedDeliveryAfterStale = true
    const transcriptDir = await mkdtemp(join(tmpdir(), 'warrunner-dogfood-failed-'))
    try {
      const result = await runLiveDogfood(testConfig(), {
        channelId: 'forum-1',
        content: 'open stale-only dogfood',
        timeoutMs: 150,
        pollIntervalMs: 10
      })
      const formatted = formatLiveDogfood(result)

      expect(result.ok).toBe(false)
      expect(result.observedEvent?.message_id).toBe('discord:guild-1:live-thread-1:live-msg-1')
      expect(result.handoff?.status).toBe(200)
      expect(result.executionId).toBe('exec-1')
      expect(workflowRuns).toHaveLength(1)
      expect(discordPosts.map(post => post.body.content)).toEqual(['stale same-channel final answer'])
      expect(delivered.map(item => item.path)).toEqual([
        '/agent/final-deliveries/stale-exec-1/delivered'
      ])
      expect(formatted).toContain('timed out waiting for a Discord final-delivery reply')
      expect(formatted).toContain('PASS Discord URL: https://discord.com/channels/guild-1/live-thread-1')
      expect(formatted).toContain('PASS live Discord message accepted: discord:guild-1:live-thread-1:live-msg-1')
      expect(formatted).toContain(
        'PASS Discord message URL: https://discord.com/channels/guild-1/live-thread-1/live-msg-1'
      )
      expect(formatted).toContain('PASS workflow handoff: 200')
      expect(formatted).toContain('PASS workflow execution: exec-1')
      expect(formatted).not.toContain('PASS Discord reply posted')

      const written = await writeDogfoodTranscript({
        command: 'live',
        result,
        transcriptDir,
        now: new Date('2026-05-21T22:00:00.000Z')
      })
      expect(written.ok).toBe(true)
      if (!written.ok || 'skipped' in written) throw new Error('failed transcript was not written')
      const transcript = JSON.parse(await readFile(written.path, 'utf8')) as any
      expect(transcript).toMatchObject({
        ok: false,
        observed_message_id: 'discord:guild-1:live-thread-1:live-msg-1',
        failed_turn: {
          message_id: 'discord:guild-1:live-thread-1:live-msg-1',
          message_url: 'https://discord.com/channels/guild-1/live-thread-1/live-msg-1',
          execution_id: 'exec-1',
          text: 'stale-only session turn',
          handoff: { ok: true, status: 200 }
        }
      })
    } finally {
      await rm(transcriptDir, { recursive: true, force: true })
    }
  })

  it('writes a live session transcript without auth secrets', async () => {
    liveMessages = ['first transcript turn', 'second transcript turn']
    const transcriptDir = await mkdtemp(join(tmpdir(), 'warrunner-dogfood-'))
    try {
      const result = await runLiveDogfoodSession(testConfig(), {
        channelId: 'forum-1',
        content: 'open transcript dogfood',
        turnLimit: 2,
        timeoutMs: 5_000,
        pollIntervalMs: 10
      })
      const written = await writeDogfoodTranscript({
        command: 'session',
        result,
        transcriptDir,
        now: new Date('2026-05-21T20:00:00.000Z')
      })

      expect(written.ok).toBe(true)
      if (!written.ok || 'skipped' in written) throw new Error('transcript was not written')
      expect(written.path).toEndWith('warrunner-dogfood-session-2026-05-21T20-00-00-000Z-pass.json')
      const transcriptText = await readFile(written.path, 'utf8')
      const transcript = JSON.parse(transcriptText)
      expect(transcript).toMatchObject({
        schema_version: 1,
        command: 'session',
        ok: true,
        stop_reason: 'turn_limit',
        target: {
          requested_channel_id: 'forum-1',
          conversation_channel_id: 'live-thread-1',
          discord_url: 'https://discord.com/channels/guild-1/live-thread-1'
        },
        turns: [
          {
            index: 1,
            message_id: 'discord:guild-1:live-thread-1:live-msg-1',
            message_url: 'https://discord.com/channels/guild-1/live-thread-1/live-msg-1',
            execution_id: 'exec-1',
            text: 'first transcript turn',
            handoff: { ok: true, status: 200 },
            reply: {
              source: 'final_delivery',
              channel_id: 'live-thread-1',
              message_id: 'reply-msg-1',
              url: 'https://discord.com/channels/guild-1/live-thread-1/reply-msg-1'
            }
          },
          {
            index: 2,
            message_id: 'discord:guild-1:live-thread-1:live-msg-2',
            message_url: 'https://discord.com/channels/guild-1/live-thread-1/live-msg-2',
            execution_id: 'exec-2',
            text: 'second transcript turn',
            handoff: { ok: true, status: 200 },
            reply: {
              source: 'final_delivery',
              channel_id: 'live-thread-1',
              message_id: 'reply-msg-2',
              url: 'https://discord.com/channels/guild-1/live-thread-1/reply-msg-2'
            }
          }
        ]
      })
      expect(transcriptText).not.toContain('discord-token')
      expect(transcriptText).not.toContain('centaur-key')
    } finally {
      await rm(transcriptDir, { recursive: true, force: true })
    }
  })

  it('counts chunked Discord final-delivery replies as one live session turn', async () => {
    liveMessages = ['chunked session turn', 'after chunked reply']
    deliveryTexts = ['chunk '.repeat(500), 'second reply after chunked delivery']
    const transcriptDir = await mkdtemp(join(tmpdir(), 'warrunner-dogfood-chunked-'))
    try {
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
      expect(discordPosts.map(post => post.body.message_reference?.message_id)).toEqual([
        'live-msg-1',
        undefined,
        'live-msg-2'
      ])
      expect(delivered).toHaveLength(2)
      expect(formatted).toContain('PASS turn 1: chunked session turn -> reply-msg-1')
      expect(formatted).toContain(
        'PASS turn 1: chunked session turn -> reply-msg-1 (2 Discord messages) [exec-1] via final_delivery'
      )
      expect(formatted).toContain('PASS turn 2: after chunked reply -> reply-msg-3 [exec-2] via final_delivery')

      const written = await writeDogfoodTranscript({
        command: 'session',
        result,
        transcriptDir,
        now: new Date('2026-05-21T21:00:00.000Z')
      })
      expect(written.ok).toBe(true)
      if (!written.ok || 'skipped' in written) throw new Error('chunked transcript was not written')
      const transcript = JSON.parse(await readFile(written.path, 'utf8')) as any
      expect(transcript.turns[0].reply.messages).toEqual([
        {
          channel_id: 'live-thread-1',
          message_id: 'reply-msg-1',
          url: 'https://discord.com/channels/guild-1/live-thread-1/reply-msg-1',
          content: discordPosts[0]?.body.content
        },
        {
          channel_id: 'live-thread-1',
          message_id: 'reply-msg-2',
          url: 'https://discord.com/channels/guild-1/live-thread-1/reply-msg-2',
          content: discordPosts[1]?.body.content
        }
      ])
      expect(transcript.turns[0].reply.full_content).toContain(discordPosts[0]?.body.content)
      expect(transcript.turns[0].reply.full_content).toContain(discordPosts[1]?.body.content)
      expect(transcript.turns[1].reply.messages).toHaveLength(1)
    } finally {
      await rm(transcriptDir, { recursive: true, force: true })
    }
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

  it('fails closed when no Warrunner route is configured', async () => {
    const result = await runLiveDogfood(
      testConfig({
        WARRUNNER_HOME_FORUM_CHANNEL_ID: '',
        WARRUNNER_HOME_CHANNEL_ID: '',
        WARRUNNER_HOME_CHANNEL_IDS: '',
        WARRUNNER_INTAKE_CHANNEL_IDS: ''
      }),
      {
        channelId: 'forum-1',
        content: 'should not be posted without a route',
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
    expect(formatted).toContain('No Warrunner Discord route is configured')
  })
})

function channelReplies(channelId: string): any[] {
  return [...historyDiscordMessages, ...createdDiscordMessages, ...externalDiscordReplies]
    .filter(message => message.channel_id === channelId)
    .slice()
    .reverse()
}

type LiveDiscordSendResult = 'sent' | 'not_ready' | 'disabled' | 'empty'

function sendLiveDiscordMessage(): LiveDiscordSendResult {
  if (!activeGateway || !liveTargetReady) return 'not_ready'
  if (!liveDispatchGatewayMessages) return 'disabled'
  const content = liveMessages[liveMessageCursor]
  if (!content) return 'empty'
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
  const message = {
    id: `live-msg-${messageIndex}`,
    channel_id: liveConversationChannelId,
    guild_id: 'guild-1',
    content: `<@bot-user> ${content}`,
    author: { id: 'user-1' },
    mentions: [{ id: 'bot-user' }],
    attachments: []
  }
  if (liveMirrorGatewayMessagesToHistory) historyDiscordMessages.push(message)
  activeGateway.send(
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: messageIndex * 2,
      d: message
    })
  )
  return 'sent'
}

function scheduleLiveDiscordMessage(attempts = 500): void {
  const timer = setTimeout(() => {
    liveMessageTimers = liveMessageTimers.filter(item => item !== timer)
    const result = sendLiveDiscordMessage()
    if (result === 'not_ready' && attempts > 0) scheduleLiveDiscordMessage(attempts - 1)
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
