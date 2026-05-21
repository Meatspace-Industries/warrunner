import { centaurApiKey, homeChannelIds, type AppConfig } from './config'

export type BotIdentityState = {
  status: 'configured' | 'loading' | 'ready' | 'failed' | 'missing_token'
  id?: string
  username?: string
  error?: string
}

export type ReadinessCheck = {
  name: string
  ok: boolean
  detail: string
}

export type ReadinessReport = {
  ready: boolean
  checks: ReadinessCheck[]
  bot_identity: BotIdentityState
}

export function initialBotIdentityState(config: AppConfig): BotIdentityState {
  const configuredId = config.DISCORD_BOT_USER_ID?.trim() || config.DISCORD_APPLICATION_ID?.trim()
  if (configuredId) return { status: 'configured', id: configuredId }
  if (!config.DISCORD_BOT_TOKEN?.trim()) return { status: 'missing_token' }
  return { status: 'loading' }
}

export function buildReadinessReport(
  config: AppConfig,
  botIdentity: BotIdentityState
): ReadinessReport {
  const checks: ReadinessCheck[] = [
    {
      name: 'discord_token',
      ok: Boolean(config.DISCORD_BOT_TOKEN?.trim()),
      detail: config.DISCORD_BOT_TOKEN ? 'configured' : 'missing'
    },
    {
      name: 'centaur_api_key',
      ok: Boolean(centaurApiKey(config)),
      detail: centaurApiKey(config) ? 'configured' : 'missing'
    },
    {
      name: 'route_config',
      ok: Boolean(homeChannelIds(config).size || config.WARRUNNER_INTAKE_CHANNEL_IDS.length),
      detail: routeSummary(config)
    },
    {
      name: 'bot_identity',
      ok: botIdentity.status === 'configured' || botIdentity.status === 'ready',
      detail: botIdentityDetail(botIdentity)
    }
  ]

  return {
    ready: checks.every(check => check.ok),
    checks,
    bot_identity: { ...botIdentity }
  }
}

function routeSummary(config: AppConfig): string {
  const homeIds = [config.WARRUNNER_HOME_CHANNEL_ID, ...config.WARRUNNER_HOME_CHANNEL_IDS]
    .map(id => id.trim())
    .filter(Boolean)
  return [
    config.WARRUNNER_HOME_FORUM_CHANNEL_ID ? `forum=${config.WARRUNNER_HOME_FORUM_CHANNEL_ID}` : '',
    homeIds.length ? `home=${homeIds.join(',')}` : '',
    config.WARRUNNER_INTAKE_CHANNEL_IDS.length ? `intake=${config.WARRUNNER_INTAKE_CHANNEL_IDS.join(',')}` : ''
  ]
    .filter(Boolean)
    .join(' ') || 'missing'
}

function botIdentityDetail(identity: BotIdentityState): string {
  if (identity.id && identity.username) return `${identity.username} (${identity.id})`
  if (identity.id) return identity.id
  if (identity.error) return `${identity.status}: ${identity.error}`
  return identity.status
}
