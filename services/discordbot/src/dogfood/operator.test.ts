import { describe, expect, it } from 'bun:test'
import {
  discordOpenCommand,
  discordUrlFromProgress,
  liveProgressReporter,
  openDiscordUrl,
  parseDogfoodCliArgs
} from './operator'

describe('dogfood operator CLI args', () => {
  it('strips Discord-open flags from positional channel and message args', () => {
    expect(parseDogfoodCliArgs(['--open', 'forum-1', 'hello', 'there'])).toEqual({
      openDiscord: true,
      attachOnly: false,
      positional: ['forum-1', 'hello', 'there']
    })
  })

  it('allows an explicit no-open flag to override env defaults', () => {
    expect(
      parseDogfoodCliArgs(['--no-open-discord', 'forum-1'], {
        WARRUNNER_DOGFOOD_OPEN_DISCORD: 'true'
      })
    ).toEqual({
      openDiscord: false,
      attachOnly: false,
      positional: ['forum-1']
    })
  })

  it('strips attach flags from positional channel and message args', () => {
    expect(parseDogfoodCliArgs(['--attach', '--open', 'thread-1', 'hello'])).toEqual({
      openDiscord: true,
      attachOnly: true,
      positional: ['thread-1', 'hello']
    })
    expect(parseDogfoodCliArgs(['--attach', '--prompt', 'thread-1'])).toEqual({
      openDiscord: false,
      attachOnly: false,
      positional: ['thread-1']
    })
  })

  it('strips session tuning flags from positional channel and message args', () => {
    expect(
      parseDogfoodCliArgs([
        '--open',
        '--turns',
        '12',
        '--timeout-ms=600000',
        '--poll-interval-ms',
        '250',
        'forum-1',
        'keep',
        'chatting'
      ])
    ).toEqual({
      openDiscord: true,
      attachOnly: false,
      turnLimit: 12,
      timeoutMs: 600_000,
      pollIntervalMs: 250,
      positional: ['forum-1', 'keep', 'chatting']
    })
  })

  it('rejects invalid session tuning values before they become message text', () => {
    expect(parseDogfoodCliArgs(['--turns=0', 'forum-1'])).toEqual({
      openDiscord: false,
      attachOnly: false,
      positional: [],
      error: '--turns must be a positive integer'
    })
    expect(parseDogfoodCliArgs(['--timeout-ms', '--open', 'forum-1'])).toEqual({
      openDiscord: false,
      attachOnly: false,
      positional: [],
      error: '--timeout-ms requires a positive integer'
    })
  })
})

describe('dogfood Discord URL opener', () => {
  it('extracts Discord URLs from live progress output', () => {
    expect(
      discordUrlFromProgress(
        [
          'PASS live target ready: #warrunner (thread-1); reply in that thread within 180s.',
          'PASS Discord URL: https://discord.com/channels/guild-1/thread-1'
        ].join('\n')
      )
    ).toBe('https://discord.com/channels/guild-1/thread-1')
  })

  it('selects platform-specific open commands', () => {
    const url = 'https://discord.com/channels/guild-1/channel-1'
    expect(discordOpenCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] })
    expect(discordOpenCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] })
    expect(discordOpenCommand(url, 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', url]
    })
  })

  it('spawns the selected opener without waiting for it', () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = []
    let unrefCalled = false
    const result = openDiscordUrl('https://discord.com/channels/guild-1/channel-1', {
      platform: 'darwin',
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        return { unref: () => (unrefCalled = true) }
      }
    })

    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      {
        command: 'open',
        args: ['https://discord.com/channels/guild-1/channel-1'],
        options: { detached: true, stdio: 'ignore' }
      }
    ])
    expect(unrefCalled).toBe(true)
  })

  it('opens a live progress Discord URL only once', () => {
    const logs: string[] = []
    const opened: string[] = []
    const reporter = liveProgressReporter({
      openDiscord: true,
      log: line => logs.push(line),
      openUrl: url => {
        opened.push(url)
        return { ok: true, url, command: 'open', args: [url] }
      }
    })
    const progress = 'PASS Discord URL: https://discord.com/channels/guild-1/channel-1'

    reporter(progress)
    reporter(progress)

    expect(opened).toEqual(['https://discord.com/channels/guild-1/channel-1'])
    expect(logs).toContain('PASS opened Discord URL: https://discord.com/channels/guild-1/channel-1')
  })
})
