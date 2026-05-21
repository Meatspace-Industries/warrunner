import { describe, expect, it } from 'bun:test'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('accepts existing Meatspace Discord environment aliases', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      MEEPO_DISCORD_GUILD_ID: 'guild-1',
      MEEPO_FORUM_CHANNEL_ID: 'forum-1',
      DISCORD_FREE_RESPONSE_CHANNELS: 'home-1 home-2',
      MEEPO_ALLOWED_ROLE_IDS: 'role-a,role-b',
      DISCORD_ALLOWED_ROLES: 'role-b role-c'
    } as unknown as NodeJS.ProcessEnv)

    expect(config.DISCORD_GUILD_ID).toBe('guild-1')
    expect(config.WARRUNNER_HOME_FORUM_CHANNEL_ID).toBe('forum-1')
    expect(config.WARRUNNER_HOME_CHANNEL_IDS).toEqual(['home-1', 'home-2'])
    expect(config.WARRUNNER_ALLOWED_ROLE_IDS).toEqual(['role-a', 'role-b', 'role-c'])
  })

  it('keeps explicit Warrunner environment values ahead of Meatspace aliases', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DISCORD_GUILD_ID: 'guild-primary',
      MEEPO_DISCORD_GUILD_ID: 'guild-alias',
      WARRUNNER_HOME_FORUM_CHANNEL_ID: 'forum-primary',
      MEEPO_FORUM_CHANNEL_ID: 'forum-alias',
      WARRUNNER_HOME_CHANNEL_IDS: 'home-primary',
      DISCORD_FREE_RESPONSE_CHANNELS: 'home-alias',
      WARRUNNER_ALLOWED_ROLE_IDS: 'role-primary',
      MEEPO_ALLOWED_ROLE_IDS: 'role-alias'
    } as unknown as NodeJS.ProcessEnv)

    expect(config.DISCORD_GUILD_ID).toBe('guild-primary')
    expect(config.WARRUNNER_HOME_FORUM_CHANNEL_ID).toBe('forum-primary')
    expect(config.WARRUNNER_HOME_CHANNEL_IDS).toEqual(['home-primary'])
    expect(config.WARRUNNER_ALLOWED_ROLE_IDS).toEqual(['role-primary'])
  })
})
