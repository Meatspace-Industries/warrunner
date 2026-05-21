import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DiscordChannel } from '../discord/types'
import type { LiveDogfoodResult, LiveDogfoodSessionResult } from './live'

type TranscriptCommand = 'live' | 'session'
type TranscriptResult = LiveDogfoodResult | LiveDogfoodSessionResult

export type WriteDogfoodTranscriptResult =
  | { ok: true; path: string }
  | { ok: false; error: string }
  | { ok: true; skipped: true }

export type PrepareDogfoodTranscriptDirResult =
  | { ok: true; path: string }
  | { ok: false; error: string }
  | { ok: true; skipped: true }

export async function prepareDogfoodTranscriptDir(
  transcriptDir?: string
): Promise<PrepareDogfoodTranscriptDirResult> {
  const dir = transcriptDir?.trim()
  if (!dir) return { ok: true, skipped: true }

  const path = resolve(dir)
  const probe = resolve(path, `.warrunner-transcript-probe-${process.pid}-${randomUUID()}`)
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(probe, 'ok\n', { encoding: 'utf8', mode: 0o600 })
    await rm(probe, { force: true })
    return { ok: true, path }
  } catch (error) {
    await rm(probe, { force: true }).catch(() => {})
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeDogfoodTranscript(opts: {
  command: TranscriptCommand
  result: TranscriptResult
  transcriptDir?: string
  now?: Date
}): Promise<WriteDogfoodTranscriptResult> {
  const transcriptDir = opts.transcriptDir?.trim()
  if (!transcriptDir) return { ok: true, skipped: true }

  const now = opts.now ?? new Date()
  const path = transcriptPath(transcriptDir, opts.command, opts.result.ok, now)
  try {
    await mkdir(transcriptDir, { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(toTranscript(opts.command, opts.result, now), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function transcriptPath(
  transcriptDir: string,
  command: TranscriptCommand,
  ok: boolean,
  now: Date
): string {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return resolve(transcriptDir, `warrunner-dogfood-${command}-${stamp}-${ok ? 'pass' : 'fail'}.json`)
}

function toTranscript(
  command: TranscriptCommand,
  result: TranscriptResult,
  completedAt: Date
): Record<string, unknown> {
  const turns = resultTurns(result)
  return {
    schema_version: 1,
    command,
    ok: result.ok,
    completed_at: completedAt.toISOString(),
    ...(result.target ? { target: targetSummary(result.target) } : {}),
    turns: turns.map((turn, index) => ({
      index: index + 1,
      message_id: turn.observedEvent.message_id,
      discord_message_id: turn.observedEvent.discord.message_id,
      thread_key: turn.observedEvent.thread_key,
      guild_id: turn.observedEvent.guild_id,
      channel_id: turn.observedEvent.channel_id,
      ...(turn.observedEvent.parent_channel_id
        ? { parent_channel_id: turn.observedEvent.parent_channel_id }
        : {}),
      user_id: turn.observedEvent.user_id,
      text: turn.observedEvent.parts.map(part => part.text).join('\n'),
      ...(turn.executionId ? { execution_id: turn.executionId } : {}),
      handoff: {
        ok: turn.handoff.ok,
        status: turn.handoff.status
      },
      reply: {
        source: turn.reply.source,
        channel_id: turn.reply.channelId,
        message_id: turn.reply.message.id,
        content: turn.reply.content,
        full_content: turn.reply.messages.map(message => message.content).join('\n'),
        messages: turn.reply.messages.map(message => ({
          channel_id: message.channelId,
          message_id: message.message.id,
          content: message.content
        }))
      }
    })),
    ...(!result.ok
      ? {
          error: result.error,
          ...(result.hint ? { hint: result.hint } : {}),
          ...(result.observedEvent ? { observed_message_id: result.observedEvent.message_id } : {})
        }
      : {})
  }
}

function resultTurns(
  result: TranscriptResult
): Array<Extract<LiveDogfoodSessionResult, { ok: true }>['turns'][number]> {
  if ('turns' in result) return result.turns
  return result.ok
    ? [
        {
          observedEvent: result.observedEvent,
          handoff: result.handoff,
          ...(result.executionId ? { executionId: result.executionId } : {}),
          reply: result.reply
        }
      ]
    : []
}

function targetSummary(target: NonNullable<TranscriptResult['target']>): Record<string, unknown> {
  return {
    requested_channel_id: target.requestedChannelId,
    conversation_channel_id: target.conversationChannelId,
    ...(target.discordUrl ? { discord_url: target.discordUrl } : {}),
    channel: channelSummary(target.channel),
    ...(target.createdThread ? { created_thread: channelSummary(target.createdThread) } : {}),
    ...(target.setupMessage ? { setup_message_id: target.setupMessage.id } : {})
  }
}

function channelSummary(channel: DiscordChannel): Record<string, unknown> {
  return {
    id: channel.id,
    type: channel.type,
    ...(channel.guild_id ? { guild_id: channel.guild_id } : {}),
    ...(channel.name ? { name: channel.name } : {}),
    ...(channel.parent_id ? { parent_id: channel.parent_id } : {})
  }
}
