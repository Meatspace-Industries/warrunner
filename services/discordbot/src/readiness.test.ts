import { describe, expect, it } from 'bun:test'
import { loadConfig, type AppConfig } from './config'
import {
  buildReadinessReport,
  initialBotIdentityState,
  type BotIdentityState
} from './readiness'

describe('buildReadinessReport', () => {
  it('passes when Discord, Centaur, routes, and bot identity are configured', () => {
    const report = buildReadinessReport(
      fullConfig({
        DISCORD_APPLICATION_ID: 'bot-user',
        WARRUNNER_HOME_FORUM_CHANNEL_ID: 'forum-1'
      }),
      { status: 'configured', id: 'bot-user' }
    )

    expect(report.ready).toBe(true)
    expect(failedChecks(report.checks)).toEqual([])
  })

  it('fails fast when route config is missing', () => {
    const report = buildReadinessReport(
      fullConfig({ DISCORD_APPLICATION_ID: 'bot-user' }),
      { status: 'configured', id: 'bot-user' }
    )

    expect(report.ready).toBe(false)
    expect(failedChecks(report.checks)).toContain('route_config')
  })

  it('fails while bot identity is still loading without a configured mention id', () => {
    const config = fullConfig({ WARRUNNER_HOME_CHANNEL_IDS: 'home-1' })
    const report = buildReadinessReport(config, initialBotIdentityState(config))

    expect(report.ready).toBe(false)
    expect(report.bot_identity.status).toBe('loading')
    expect(failedChecks(report.checks)).toContain('bot_identity')
  })

  it('passes after bot identity is inferred from Discord', () => {
    const config = fullConfig({ WARRUNNER_HOME_CHANNEL_IDS: 'home-1' })
    const identity: BotIdentityState = { status: 'ready', id: 'bot-user', username: 'warrunner' }
    const report = buildReadinessReport(config, identity)

    expect(report.ready).toBe(true)
    expect(report.bot_identity).toEqual(identity)
  })
})

function fullConfig(overrides: Partial<NodeJS.ProcessEnv>): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    ENVIRONMENT: 'test',
    PORT: '3002',
    COMMIT_SHA: 'test',
    DISCORD_BOT_TOKEN: 'discord-token',
    DISCORD_GUILD_ID: 'guild-1',
    DISCORDBOT_API_KEY: 'centaur-key',
    ...overrides
  } as NodeJS.ProcessEnv)
}

function failedChecks(checks: Array<{ name: string; ok: boolean }>): string[] {
  return checks.filter(check => !check.ok).map(check => check.name)
}
