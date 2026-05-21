import { describe, expect, it } from 'bun:test'
import { parseDogfoodEnvFile, parseDogfoodGlobalArgs } from './env-file'

describe('dogfood env-file args', () => {
  it('strips env-file flags before command-specific argument parsing', () => {
    expect(
      parseDogfoodGlobalArgs(
        ['--', '--dogfood-env-file=/var/lib/meepo/hermes/.env', '--open', 'forum-1'],
        {}
      )
    ).toEqual({
      envFile: '/var/lib/meepo/hermes/.env',
      positional: ['--open', 'forum-1']
    })
  })

  it('supports a separated env-file path and env default fallback', () => {
    expect(
      parseDogfoodGlobalArgs(['--env-file', 'local.env', 'forum-1'], {
        WARRUNNER_DOGFOOD_ENV_FILE: '/var/lib/meepo/hermes/.env'
      })
    ).toEqual({
      envFile: 'local.env',
      positional: ['forum-1']
    })
  })

  it('reports a missing env-file path', () => {
    expect(parseDogfoodGlobalArgs(['--env-file'])).toEqual({
      positional: [],
      error: '--env-file requires a path'
    })
    expect(parseDogfoodGlobalArgs(['--dogfood-env-file='])).toEqual({
      positional: [],
      error: '--dogfood-env-file requires a path'
    })
  })
})

describe('parseDogfoodEnvFile', () => {
  it('parses simple, exported, quoted, and commented env values', () => {
    expect(
      parseDogfoodEnvFile(`
        # host secrets stay out of the repo
        DISCORD_GUILD_ID=guild-1
        export MEEPO_FORUM_CHANNEL_ID=forum-1
        DISCORD_FREE_RESPONSE_CHANNELS="home-1 home-2"
        DISCORDBOT_API_KEY='secret key'
        WARRUNNER_DOGFOOD_OPEN_DISCORD=true # local operator preference
      `)
    ).toEqual({
      DISCORD_GUILD_ID: 'guild-1',
      MEEPO_FORUM_CHANNEL_ID: 'forum-1',
      DISCORD_FREE_RESPONSE_CHANNELS: 'home-1 home-2',
      DISCORDBOT_API_KEY: 'secret key',
      WARRUNNER_DOGFOOD_OPEN_DISCORD: 'true'
    })
  })
})
