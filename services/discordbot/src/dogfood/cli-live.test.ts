import { afterAll, afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DiscordGatewayPayload } from '../discord/types'

setDefaultTimeout(15_000)

type CapturedRequest = {
  path: string
  authorization: string
  body: any
}

const workflowRuns: CapturedRequest[] = []
const discordPosts: CapturedRequest[] = []
const delivered: CapturedRequest[] = []
const forumThreadCreates: CapturedRequest[] = []
const pendingDeliveries: any[] = []
const createdDiscordMessages: any[] = []
const liveMessageTimers: Array<ReturnType<typeof setTimeout>> = []

let activeGateway: any = null
let liveTargetReady = false
let liveMessageCursor = 0
let liveMessages: string[] = []

const server = Bun.serve({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true })
    }
    if (url.pathname === '/workflows/registered' && request.method === 'GET') {
      return Response.json({ workflows: [{ name: 'discord_thread_turn' }] })
    }
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
      forumThreadCreates.push(captured)
      liveTargetReady = true
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
      liveTargetReady = true
      scheduleLiveDiscordMessage()
      return Response.json({
        id: 'live-thread-1',
        type: 11,
        name: 'Warrunner dogfood smoke',
        parent_id: 'forum-1',
        guild_id: 'guild-1'
      })
    }
    if (url.pathname === '/channels/live-thread-1/messages' && request.method === 'GET') {
      if (url.searchParams.has('after')) {
        return Response.json(channelMessages('live-thread-1'))
      }
      return Response.json([
        {
          id: 'hist-1',
          channel_id: 'live-thread-1',
          guild_id: 'guild-1',
          content: 'previous operator context',
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
    if (url.pathname === '/workflows/runs' && request.method === 'POST') {
      const captured = await capture(request, url.pathname)
      workflowRuns.push(captured)
      const runIndex = workflowRuns.length
      pendingDeliveries.push({
        execution_id: `exec-${runIndex}`,
        thread_key: captured.body.input.thread_key,
        delivery: captured.body.input.delivery,
        final_payload: {
          result_text: `CLI final answer ${runIndex}`
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
      if (payload.op === 2 && liveTargetReady) scheduleLiveDiscordMessage()
    }
  }
})

const fakeBaseUrl = `http://127.0.0.1:${server.port}`

beforeEach(() => {
  clearLiveTimers()
  workflowRuns.length = 0
  discordPosts.length = 0
  delivered.length = 0
  forumThreadCreates.length = 0
  pendingDeliveries.length = 0
  createdDiscordMessages.length = 0
  activeGateway = null
  liveTargetReady = false
  liveMessageCursor = 0
  liveMessages = ['first CLI session turn', 'second CLI session turn']
})

afterEach(() => {
  clearLiveTimers()
})

afterAll(() => {
  server.stop(true)
})

describe('dogfood CLI live session', () => {
  it('runs the real session CLI through preflight, Gateway intake, final delivery, and transcript writing', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'warrunner-cli-live-'))
    const envFile = join(tmp, '.env')
    const transcriptDir = join(tmp, 'transcripts')
    try {
      await writeFile(
        envFile,
        [
          `DISCORD_API_URL=${fakeBaseUrl}`,
          `CENTAUR_API_URL=${fakeBaseUrl}`,
          'DISCORD_BOT_TOKEN=discord-token',
          'DISCORDBOT_API_KEY=centaur-key',
          'DISCORD_GATEWAY_ENABLED=true',
          'DISCORD_GUILD_ID=guild-1',
          'DISCORD_BOT_USER_ID=bot-user',
          'WARRUNNER_HOME_FORUM_CHANNEL_ID=forum-1',
          'WARRUNNER_HOME_CHANNEL_ID=',
          'WARRUNNER_HOME_CHANNEL_IDS=',
          'WARRUNNER_INTAKE_CHANNEL_IDS=',
          'DISCORD_FREE_RESPONSE_CHANNELS=',
          'WARRUNNER_ALLOWED_ROLE_IDS=',
          'MEEPO_ALLOWED_ROLE_IDS=',
          'DISCORD_ALLOWED_ROLES=',
          'WARRUNNER_DOGFOOD_OPEN_DISCORD=false',
          'WARRUNNER_DISCORDBOT_URL=',
          'WARRUNNER_HISTORY_LIMIT=10'
        ].join('\n')
      )

      const result = await runDogfoodCli([
        'session',
        `--dogfood-env-file=${envFile}`,
        `--transcript-dir=${transcriptDir}`,
        '--turns=2',
        '--timeout-ms=5000',
        '--poll-interval-ms=10',
        'forum-1',
        'CLI session setup prompt'
      ])

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
      expect(result.stdout).toContain('PASS warrunner dogfood preflight passed')
      expect(result.stdout).toContain('PASS live Discord dogfood session completed')
      expect(result.stdout).toContain('PASS turns completed: 2')
      expect(result.stdout).toContain('PASS turn 2: second CLI session turn -> reply-msg-2')
      expect(result.stdout).toContain('PASS dogfood transcript:')
      expect(result.stderr).not.toContain('discord_gateway_connect_failed')
      expect(result.stderr).not.toContain('final_delivery_poll_failed')

      expect(workflowRuns).toHaveLength(2)
      expect(workflowRuns.map(run => run.body.input.parts[0].text)).toEqual([
        'first CLI session turn',
        'second CLI session turn'
      ])
      expect(discordPosts.map(post => post.body.content)).toEqual([
        'CLI final answer 1',
        'CLI final answer 2'
      ])
      expect(discordPosts.map(post => post.body.message_reference?.message_id)).toEqual([
        'live-msg-1',
        'live-msg-2'
      ])
      expect(delivered.map(item => item.path)).toEqual([
        '/agent/final-deliveries/exec-1/delivered',
        '/agent/final-deliveries/exec-2/delivered'
      ])

      const transcripts = await readdir(transcriptDir)
      expect(transcripts).toHaveLength(1)
      expect(transcripts[0]).toContain('session')
      expect(transcripts[0]).toContain('pass')
      const transcriptText = await readFile(join(transcriptDir, transcripts[0] ?? ''), 'utf8')
      const transcript = JSON.parse(transcriptText) as any
      expect(transcript).toMatchObject({
        command: 'session',
        ok: true,
        stop_reason: 'turn_limit',
        target: {
          requested_channel_id: 'forum-1',
          conversation_channel_id: 'live-thread-1',
          discord_url: 'https://discord.com/channels/guild-1/live-thread-1'
        }
      })
      expect(transcript.turns).toHaveLength(2)
      expect(transcript.turns.map((turn: any) => turn.text)).toEqual([
        'first CLI session turn',
        'second CLI session turn'
      ])
      expect(transcript.turns.map((turn: any) => turn.reply.source)).toEqual([
        'final_delivery',
        'final_delivery'
      ])
      expect(transcript.turns[1]).toMatchObject({
        execution_id: 'exec-2',
        message_url: 'https://discord.com/channels/guild-1/live-thread-1/live-msg-2',
        reply: {
          message_id: 'reply-msg-2',
          url: 'https://discord.com/channels/guild-1/live-thread-1/reply-msg-2',
          content: 'CLI final answer 2'
        }
      })
      expect(transcriptText).not.toContain('discord-token')
      expect(transcriptText).not.toContain('centaur-key')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('runs the real chat CLI as an open Discord-window session until idle timeout', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'warrunner-cli-chat-'))
    const envFile = join(tmp, '.env')
    const transcriptDir = join(tmp, 'transcripts')
    try {
      await writeFile(
        envFile,
        [
          `DISCORD_API_URL=${fakeBaseUrl}`,
          `CENTAUR_API_URL=${fakeBaseUrl}`,
          'DISCORD_BOT_TOKEN=discord-token',
          'DISCORDBOT_API_KEY=centaur-key',
          'DISCORD_GATEWAY_ENABLED=true',
          'DISCORD_GUILD_ID=guild-1',
          'DISCORD_BOT_USER_ID=bot-user',
          'WARRUNNER_HOME_FORUM_CHANNEL_ID=forum-1',
          'WARRUNNER_HOME_CHANNEL_ID=',
          'WARRUNNER_HOME_CHANNEL_IDS=',
          'WARRUNNER_INTAKE_CHANNEL_IDS=',
          'DISCORD_FREE_RESPONSE_CHANNELS=',
          'WARRUNNER_ALLOWED_ROLE_IDS=',
          'MEEPO_ALLOWED_ROLE_IDS=',
          'DISCORD_ALLOWED_ROLES=',
          'WARRUNNER_DOGFOOD_CHAT_TIMEOUT_MS=2000',
          'WARRUNNER_DISCORDBOT_URL=',
          'WARRUNNER_HISTORY_LIMIT=10'
        ].join('\n')
      )

      const result = await runDogfoodCli([
        'chat',
        `--dogfood-env-file=${envFile}`,
        `--transcript-dir=${transcriptDir}`,
        '--no-open',
        '--poll-interval-ms=10',
        'forum-1',
        'CLI chat setup prompt'
      ])

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
      expect(result.stdout).toContain('PASS warrunner dogfood preflight passed')
      expect(result.stdout).toContain('PASS live Discord dogfood chat completed')
      expect(result.stdout).not.toContain('PASS live Discord dogfood session completed')
      expect(result.stdout).toContain('PASS turns completed: 2')
      expect(result.stdout).toContain('PASS stop reason: idle_timeout')
      expect(result.stdout).toContain('PASS turn 2: second CLI session turn -> reply-msg-2')
      expect(result.stdout).toContain('PASS dogfood transcript:')
      expect(result.stdout).not.toContain('PASS opened Discord URL')
      expect(result.stderr).not.toContain('discord_gateway_connect_failed')
      expect(result.stderr).not.toContain('final_delivery_poll_failed')

      expect(workflowRuns).toHaveLength(2)
      expect(discordPosts.map(post => post.body.content)).toEqual([
        'CLI final answer 1',
        'CLI final answer 2'
      ])

      const transcripts = await readdir(transcriptDir)
      expect(transcripts).toHaveLength(1)
      expect(transcripts[0]).toContain('chat')
      expect(transcripts[0]).toContain('pass')
      const transcriptText = await readFile(join(transcriptDir, transcripts[0] ?? ''), 'utf8')
      const transcript = JSON.parse(transcriptText) as any
      expect(transcript).toMatchObject({
        command: 'chat',
        ok: true,
        stop_reason: 'idle_timeout',
        target: {
          requested_channel_id: 'forum-1',
          conversation_channel_id: 'live-thread-1',
          discord_url: 'https://discord.com/channels/guild-1/live-thread-1'
        }
      })
      expect(transcript.turns).toHaveLength(2)
      expect(transcriptText).not.toContain('discord-token')
      expect(transcriptText).not.toContain('centaur-key')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('runs the real chat CLI attached to an existing forum thread without creating a setup prompt', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'warrunner-cli-attach-chat-'))
    const envFile = join(tmp, '.env')
    const transcriptDir = join(tmp, 'transcripts')
    liveMessages = ['attached CLI chat turn', 'attached CLI chat followup']
    try {
      await writeFile(
        envFile,
        [
          `DISCORD_API_URL=${fakeBaseUrl}`,
          `CENTAUR_API_URL=${fakeBaseUrl}`,
          'DISCORD_BOT_TOKEN=discord-token',
          'DISCORDBOT_API_KEY=centaur-key',
          'DISCORD_GATEWAY_ENABLED=true',
          'DISCORD_GUILD_ID=guild-1',
          'DISCORD_BOT_USER_ID=bot-user',
          'WARRUNNER_HOME_FORUM_CHANNEL_ID=forum-1',
          'WARRUNNER_HOME_CHANNEL_ID=',
          'WARRUNNER_HOME_CHANNEL_IDS=',
          'WARRUNNER_INTAKE_CHANNEL_IDS=',
          'DISCORD_FREE_RESPONSE_CHANNELS=',
          'WARRUNNER_ALLOWED_ROLE_IDS=',
          'MEEPO_ALLOWED_ROLE_IDS=',
          'DISCORD_ALLOWED_ROLES=',
          'WARRUNNER_DISCORDBOT_URL=',
          'WARRUNNER_HISTORY_LIMIT=10'
        ].join('\n')
      )

      const result = await runDogfoodCli([
        'chat',
        `--dogfood-env-file=${envFile}`,
        `--transcript-dir=${transcriptDir}`,
        '--attach',
        '--turns=2',
        '--operator-user-id=user-1',
        '--no-open',
        '--poll-interval-ms=10',
        '--timeout-ms=5000',
        'live-thread-1'
      ])

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
      expect(result.stdout).toContain('PASS warrunner dogfood preflight passed')
      expect(result.stdout).toContain('PASS live Discord dogfood chat completed')
      expect(result.stdout).toContain('PASS operator user filter: user-1')
      expect(result.stdout).toContain('PASS turns completed: 2')
      expect(result.stdout).toContain('PASS stop reason: turn_limit')
      expect(result.stdout).toContain('PASS turn 1: attached CLI chat turn -> reply-msg-1')
      expect(result.stdout).toContain('PASS turn 2: attached CLI chat followup -> reply-msg-2')
      expect(forumThreadCreates).toHaveLength(0)
      expect(workflowRuns.map(run => run.body.input.parts[0].text)).toEqual([
        'attached CLI chat turn',
        'attached CLI chat followup'
      ])
      expect(discordPosts.map(post => post.body.message_reference?.message_id)).toEqual([
        'live-msg-1',
        'live-msg-2'
      ])

      const transcripts = await readdir(transcriptDir)
      expect(transcripts).toHaveLength(1)
      expect(transcripts[0]).toContain('chat')
      expect(transcripts[0]).toContain('pass')
      const transcriptText = await readFile(join(transcriptDir, transcripts[0] ?? ''), 'utf8')
      const transcript = JSON.parse(transcriptText) as any
      expect(transcript).toMatchObject({
        command: 'chat',
        ok: true,
        stop_reason: 'turn_limit',
        target: {
          requested_channel_id: 'live-thread-1',
          conversation_channel_id: 'live-thread-1',
          operator_user_id: 'user-1',
          discord_url: 'https://discord.com/channels/guild-1/live-thread-1'
        }
      })
      expect(transcript.turns.map((turn: any) => turn.text)).toEqual([
        'attached CLI chat turn',
        'attached CLI chat followup'
      ])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

async function runDogfoodCli(args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn(
    [process.execPath, fileURLToPath(new URL('../dogfood.ts', import.meta.url)), ...args],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        NO_COLOR: '1'
      },
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { exitCode, stdout, stderr }
}

function channelMessages(channelId: string): any[] {
  return createdDiscordMessages
    .filter(message => message.channel_id === channelId)
    .slice()
    .reverse()
}

type LiveDiscordSendResult = 'sent' | 'not_ready' | 'empty'

function sendLiveDiscordMessage(): LiveDiscordSendResult {
  if (!activeGateway || !liveTargetReady) return 'not_ready'
  const content = liveMessages[liveMessageCursor]
  if (!content) return 'empty'
  const messageIndex = liveMessageCursor + 1
  liveMessageCursor += 1
  activeGateway.send(
    JSON.stringify({
      op: 0,
      t: 'THREAD_CREATE',
      s: messageIndex * 2 - 1,
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
      s: messageIndex * 2,
      d: {
        id: `live-msg-${messageIndex}`,
        channel_id: 'live-thread-1',
        guild_id: 'guild-1',
        content: `<@bot-user> ${content}`,
        author: { id: 'user-1' },
        mentions: [{ id: 'bot-user' }],
        attachments: []
      }
    })
  )
  return 'sent'
}

function scheduleLiveDiscordMessage(attempts = 500): void {
  const timer = setTimeout(() => {
    const index = liveMessageTimers.indexOf(timer)
    if (index >= 0) liveMessageTimers.splice(index, 1)
    const result = sendLiveDiscordMessage()
    if (result === 'not_ready' && attempts > 0) scheduleLiveDiscordMessage(attempts - 1)
  }, 10)
  liveMessageTimers.push(timer)
}

function clearLiveTimers(): void {
  for (const timer of liveMessageTimers.splice(0)) clearTimeout(timer)
}

async function capture(request: Request, path: string): Promise<CapturedRequest> {
  return {
    path,
    authorization: request.headers.get('authorization') ?? '',
    body: await request.json()
  }
}
