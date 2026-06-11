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

  it('strips configured bot role mentions', () => {
    const config = loadConfig(env({ WARRUNNER_MENTION_ROLE_IDS: '111' }))
    expect(normalizeDiscordText('<@&111> hi <@&222>', config)).toBe('hi @role:222')
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

  it('keeps REST-fetched history when Discord omits guild_id', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message(),
      config,
      parentChannelId: 'forum-1',
      historyMessages: [
        message({
          id: 'prev-1',
          guild_id: undefined,
          content: 'REST history row without guild id',
          author: { id: 'user-2' }
        })
      ]
    })

    expect(normalized?.history_messages).toHaveLength(1)
    expect(normalized?.history_messages?.[0]).toMatchObject({
      message_id: 'discord:guild-1:thread-1:prev-1',
      parts: [{ type: 'text', text: 'REST history row without guild id' }]
    })
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

  it('accepts configured role-mentioned messages in a configured home channel', () => {
    const config = loadConfig(env({ WARRUNNER_MENTION_ROLE_IDS: '111' }))
    const normalized = normalizeDiscordMessage({
      message: message({
        id: 'home-role-msg-1',
        channel_id: 'home-1',
        content: '<@&111> start a home-channel task',
        mentions: [],
        mention_roles: ['111']
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
        message: message({ content: 'background channel chatter' }),
        config,
        parentChannelId: 'other-channel'
      })
    ).toBeNull()
  })

  it('accepts bot-mentioned messages outside configured routes', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message({
        id: 'outside-msg-1',
        channel_id: 'random-thread',
        content: '<@999> can you work here too?',
        mentions: [{ id: '999' }]
      }),
      config,
      parentChannelId: 'random-forum'
    })

    expect(normalized?.thread_key).toBe('discord:guild-1:random-forum:random-thread')
    expect(normalized?.message_id).toBe('discord:guild-1:random-thread:outside-msg-1')
    expect(normalized?.parts[0]?.text).toBe('can you work here too?')
    expect(normalized?.discord.is_mention).toBe(true)
  })

  it('accepts bot-mentioned messages outside configured routes when not in a thread', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message({
        id: 'outside-channel-msg-1',
        channel_id: 'random-channel',
        content: '<@999> not from a thread',
        mentions: [{ id: '999' }]
      }),
      config
    })

    expect(normalized?.thread_key).toBe('discord:guild-1:random-channel:random-channel')
    expect(normalized?.message_id).toBe('discord:guild-1:random-channel:outside-channel-msg-1')
    expect(normalized?.parts[0]?.text).toBe('not from a thread')
    expect(normalized?.discord.is_mention).toBe(true)
  })

  it('rejects raw mention-looking text outside configured routes without a parsed Discord mention', () => {
    const config = loadConfig(env())
    expect(
      normalizeDiscordMessage({
        message: message({
          id: 'outside-msg-2',
          channel_id: 'random-thread',
          content: '<@999> literal text, not a parsed Discord mention',
          mentions: []
        }),
        config,
        parentChannelId: 'random-forum'
      })
    ).toBeNull()
  })

  it('rejects raw role-mention-looking text outside configured routes without a parsed Discord role mention', () => {
    const config = loadConfig(env({ WARRUNNER_MENTION_ROLE_IDS: '111' }))
    expect(
      normalizeDiscordMessage({
        message: message({
          id: 'outside-role-msg-1',
          channel_id: 'random-thread',
          content: '<@&111> literal text, not a parsed Discord role mention',
          mentions: [],
          mention_roles: []
        }),
        config,
        parentChannelId: 'random-forum'
      })
    ).toBeNull()
  })

  it('accepts bot-mentioned thread messages when no route config exists', () => {
    const config = loadConfig(
      env({
        WARRUNNER_HOME_FORUM_CHANNEL_ID: '',
        WARRUNNER_HOME_CHANNEL_IDS: '',
        WARRUNNER_INTAKE_CHANNEL_IDS: ''
      })
    )

    expect(
      normalizeDiscordMessage({
        message: message({ mentions: [{ id: '999' }] }),
        config,
        parentChannelId: 'forum-1'
      })?.thread_key
    ).toBe('discord:guild-1:forum-1:thread-1')
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

describe('requester context', () => {
  it('attaches requester identity and resolved role names', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message({
        author: { id: 'user-1', username: 'alice', global_name: 'Alice A' },
        member: { roles: ['role-1', 'role-2'], nick: 'Ally' }
      }),
      config,
      parentChannelId: 'forum-1',
      roleNamesById: new Map([
        ['role-1', 'eng'],
        ['role-2', 'leadership']
      ])
    })
    expect(normalized?.requester).toEqual({
      user_id: 'user-1',
      username: 'alice',
      display_name: 'Ally',
      role_ids: ['role-1', 'role-2'],
      role_names: ['eng', 'leadership']
    })
  })

  it('omits role names when no role map is provided', () => {
    const config = loadConfig(env())
    const normalized = normalizeDiscordMessage({
      message: message({
        author: { id: 'user-1', username: 'alice' }
      }),
      config,
      parentChannelId: 'forum-1'
    })
    expect(normalized?.requester).toEqual({
      user_id: 'user-1',
      username: 'alice',
      display_name: 'alice',
      role_ids: ['role-1']
    })
  })
})
