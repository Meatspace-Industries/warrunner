import { describe, expect, it } from 'bun:test'
import { loadConfig } from '../config'
import { normalizeDiscordMessage, normalizeDiscordText } from './normalize'
import type { DiscordMessage } from './types'

const baseEnv = {
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_APPLICATION_ID: '999',
  DISCORD_BOT_USER_ID: '999',
  DISCORD_GUILD_ID: 'guild-1',
  WARRUNNER_HOME_FORUM_CHANNEL_ID: 'forum-1',
  WARRUNNER_HOME_CHANNEL_IDS: 'home-1',
  WARRUNNER_REQUIRE_HOME_THREAD: 'true'
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...baseEnv, ...overrides } as unknown as NodeJS.ProcessEnv
}

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'msg-1',
    channel_id: 'thread-1',
    guild_id: 'guild-1',
    content: '<@999> please check this',
    author: { id: 'user-1' },
    member: { roles: ['role-1'] },
    attachments: [],
    ...overrides
  }
}

describe('normalizeDiscordText', () => {
  it('strips the bot mention and normalizes Discord mentions', () => {
    const config = loadConfig(env())
    expect(normalizeDiscordText('<@999> hi <#123> <@456>', config)).toBe('hi #123 @456')
  })
})

describe('normalizeDiscordMessage', () => {
  it('accepts messages in the configured home forum thread', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message(),
      config,
      parentChannelId: 'forum-1',
      historyMessages: [
        message({
          id: 'prev-1',
          content: 'prior context',
          author: { id: 'user-2' }
        })
      ]
    })

    expect(normalized?.thread_key).toBe('discord:guild-1:forum-1:thread-1')
    expect(normalized?.message_id).toBe('discord:guild-1:thread-1:msg-1')
    expect(normalized?.parts[0]?.text).toBe('please check this')
    expect(normalized?.history_messages?.[0]?.message_id).toBe('discord:guild-1:thread-1:prev-1')
  })

  it('accepts bot-mentioned messages in a configured home channel', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message({
        id: 'home-msg-1',
        channel_id: 'home-1',
        content: '<@999> start a home-channel task'
      }),
      config
    })

    expect(normalized?.thread_key).toBe('discord:guild-1:home-1:home-1')
    expect(normalized?.parts[0]?.text).toBe('start a home-channel task')
    expect(normalized?.discord.is_mention).toBe(true)
  })

  it('rejects unmentioned home-channel messages by default', () => {
    const config = loadConfig(env())
    expect(
      normalizeDiscordMessage({
        message: message({
          id: 'home-msg-2',
          channel_id: 'home-1',
          content: 'background channel chatter'
        }),
        config
      })
    ).toBeNull()
  })

  it('can allow all messages in a configured home channel', () => {
    const config = loadConfig(env({ WARRUNNER_HOME_CHANNEL_MENTION_REQUIRED: 'false' }))
    const normalized = normalizeDiscordMessage({
      message: message({
        id: 'home-msg-3',
        channel_id: 'home-1',
        content: 'no mention needed here'
      }),
      config
    })

    expect(normalized?.thread_key).toBe('discord:guild-1:home-1:home-1')
    expect(normalized?.discord.is_mention).toBe(false)
  })

  it('keeps legacy non-thread home-channel mode available', () => {
    const config = loadConfig(env({ WARRUNNER_REQUIRE_HOME_THREAD: 'false' }))
    const normalized = normalizeDiscordMessage({
      message: message({
        id: 'home-msg-4',
        channel_id: 'home-1',
        content: 'home channel is fully delegated'
      }),
      config
    })

    expect(normalized?.thread_key).toBe('discord:guild-1:home-1:home-1')
  })

  it('rejects messages outside the home thread model by default', () => {
    const config = loadConfig(env())
    expect(
      normalizeDiscordMessage({
        message: message(),
        config,
        parentChannelId: 'other-channel'
      })
    ).toBeNull()
  })

  it('enforces allowed role ids when configured', () => {
    const config = loadConfig(env({ WARRUNNER_ALLOWED_ROLE_IDS: 'ops' }))
    expect(
      normalizeDiscordMessage({
        message: message({ member: { roles: ['role-1'] } }),
        config,
        parentChannelId: 'forum-1'
      })
    ).toBeNull()
    expect(
      normalizeDiscordMessage({
        message: message({ member: { roles: ['ops'] } }),
        config,
        parentChannelId: 'forum-1'
      })?.user_id
    ).toBe('user-1')
  })
})
