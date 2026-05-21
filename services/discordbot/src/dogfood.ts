import { centaurApiKey, homeChannelIds, loadConfig, type AppConfig } from './config'
import { DiscordApiError, DiscordClient } from './discord/client'
import type { DiscordUser } from './discord/types'
import { formatEmulatedChatLoop, runEmulatedChatLoop } from './dogfood/emulated'
import { formatSmokePost, runSmokePost } from './dogfood/smoke'

type Check = {
  name: string
  ok: boolean
  detail: string
  hint?: string
}

type PreflightResult = {
  ok: boolean
  checks: Check[]
}

type RegisteredWorkflowsResponse = {
  workflows?: Array<{ name?: unknown }>
}

const CHANNEL_TYPES: Record<number, string> = {
  0: 'guild_text',
  5: 'guild_announcement',
  10: 'announcement_thread',
  11: 'public_thread',
  12: 'private_thread',
  15: 'guild_forum',
  16: 'guild_media'
}

export async function runPreflight(config: AppConfig = loadConfig()): Promise<PreflightResult> {
  const checks: Check[] = []
  const discord = new DiscordClient(config)

  addRequiredConfigChecks(config, checks)
  const canCallDiscord = Boolean(config.DISCORD_BOT_TOKEN)
  const canCallCentaur = Boolean(config.CENTAUR_API_URL && centaurApiKey(config))

  let botUser: DiscordUser | null = null
  if (canCallDiscord) {
    botUser = await checkDiscordIdentity(discord, checks)
    await checkDiscordGateway(discord, checks)
    await checkDiscordChannels(config, discord, checks)
  }
  addBotMentionCheck(config, botUser, checks)

  if (canCallCentaur) {
    await checkCentaurHealth(config, checks)
    await checkDiscordWorkflowRegistered(config, checks)
  }

  return { ok: checks.every(check => check.ok), checks }
}

export function formatPreflight(result: PreflightResult): string {
  const lines = result.checks.map(check => {
    const prefix = check.ok ? 'PASS' : 'FAIL'
    const hint = check.hint ? `\n      ${check.hint}` : ''
    return `${prefix} ${check.name}: ${check.detail}${hint}`
  })
  lines.push(
    result.ok ? 'PASS warrunner dogfood preflight passed' : 'FAIL warrunner dogfood preflight failed'
  )
  return lines.join('\n')
}

if (import.meta.main) {
  const command = process.argv[2] ?? 'preflight'
  if (command === 'emulated') {
    const result = await runEmulatedChatLoop()
    console.log(formatEmulatedChatLoop(result))
    process.exit(result.ok ? 0 : 1)
  }
  if (command === 'smoke') {
    const argChannelId = process.argv[3]?.trim()
    const channelId = argChannelId || process.env.WARRUNNER_DOGFOOD_SMOKE_CHANNEL_ID?.trim()
    const contentArgs = argChannelId ? process.argv.slice(4) : process.argv.slice(3)
    const result = await runSmokePost(loadConfig(), {
      channelId,
      content: contentArgs.join(' '),
      appliedTagIds: splitList(process.env.WARRUNNER_DOGFOOD_SMOKE_TAG_IDS ?? '')
    })
    console.log(formatSmokePost(result))
    process.exit(result.ok ? 0 : 1)
  }
  if (command !== 'preflight') {
    console.error(`Unsupported dogfood command: ${command}`)
    console.error(
      'Usage: pnpm --filter discordbot dogfood:preflight | pnpm --filter discordbot dogfood:emulated | pnpm --filter discordbot dogfood:smoke -- <channel-id> [message]'
    )
    process.exit(2)
  }
  const result = await runPreflight()
  console.log(formatPreflight(result))
  process.exit(result.ok ? 0 : 1)
}

function addRequiredConfigChecks(config: AppConfig, checks: Check[]): void {
  addCheck(checks, {
    name: 'DISCORD_BOT_TOKEN',
    ok: Boolean(config.DISCORD_BOT_TOKEN?.trim()),
    detail: config.DISCORD_BOT_TOKEN ? 'configured' : 'missing',
    hint: 'Create a Discord bot token and export DISCORD_BOT_TOKEN.'
  })
  addCheck(checks, {
    name: 'DISCORDBOT_API_KEY',
    ok: Boolean(centaurApiKey(config)),
    detail: centaurApiKey(config) ? 'configured' : 'missing',
    hint: 'Set DISCORDBOT_API_KEY to the same service key configured on the Centaur API.'
  })
  addCheck(checks, {
    name: 'DISCORD_GUILD_ID',
    ok: Boolean(config.DISCORD_GUILD_ID?.trim()),
    detail: config.DISCORD_GUILD_ID ? config.DISCORD_GUILD_ID : 'missing',
    hint: 'Set DISCORD_GUILD_ID to the Discord guild/server id used for dogfooding.'
  })
  addCheck(checks, {
    name: 'home route',
    ok: Boolean(homeChannelIds(config).size || config.WARRUNNER_INTAKE_CHANNEL_IDS.length),
    detail: routeSummary(config),
    hint: 'Set WARRUNNER_HOME_FORUM_CHANNEL_ID, WARRUNNER_HOME_CHANNEL_IDS, or WARRUNNER_INTAKE_CHANNEL_IDS.'
  })
}

async function checkDiscordIdentity(
  client: DiscordClient,
  checks: Check[]
): Promise<DiscordUser | null> {
  try {
    const user = await client.fetchCurrentUser()
    addCheck(checks, {
      name: 'Discord bot identity',
      ok: Boolean(user.id),
      detail: user.username ? `${user.username} (${user.id})` : user.id
    })
    return user
  } catch (error) {
    addDiscordError(checks, 'Discord bot identity', error)
    return null
  }
}

async function checkDiscordGateway(client: DiscordClient, checks: Check[]): Promise<void> {
  try {
    const gatewayUrl = await client.gatewayBotUrl()
    addCheck(checks, {
      name: 'Discord Gateway',
      ok: true,
      detail: gatewayUrl
    })
  } catch (error) {
    addDiscordError(checks, 'Discord Gateway', error)
  }
}

async function checkDiscordChannels(
  config: AppConfig,
  client: DiscordClient,
  checks: Check[]
): Promise<void> {
  const seen = new Set<string>()
  const targets = [
    ...channelTargets('home forum', [config.WARRUNNER_HOME_FORUM_CHANNEL_ID], new Set([15, 16])),
    ...channelTargets(
      'home channel',
      [...homeChannelIds(config)].filter(id => id !== config.WARRUNNER_HOME_FORUM_CHANNEL_ID),
      new Set([0, 5])
    ),
    ...channelTargets('intake channel', config.WARRUNNER_INTAKE_CHANNEL_IDS, new Set([0, 5]))
  ]

  for (const target of targets) {
    if (seen.has(target.id)) continue
    seen.add(target.id)
    try {
      const channel = await client.fetchChannel(target.id)
      const typeName = CHANNEL_TYPES[channel.type] ?? `type_${channel.type}`
      addCheck(checks, {
        name: `${target.label} ${target.id}`,
        ok: target.expectedTypes.has(channel.type),
        detail: `${channel.name ?? '(unnamed)'} ${typeName}`,
        hint: `Expected one of: ${[...target.expectedTypes].map(type => CHANNEL_TYPES[type] ?? type).join(', ')}.`
      })
    } catch (error) {
      addDiscordError(checks, `${target.label} ${target.id}`, error)
    }
  }
}

async function checkCentaurHealth(config: AppConfig, checks: Check[]): Promise<void> {
  try {
    const response = await fetch(new URL('/health', config.CENTAUR_API_URL))
    addCheck(checks, {
      name: 'Centaur health',
      ok: response.ok,
      detail: `${response.status} ${response.statusText}`
    })
  } catch (error) {
    addCheck(checks, {
      name: 'Centaur health',
      ok: false,
      detail: errorMessage(error),
      hint: 'Start the Centaur API and set CENTAUR_API_URL.'
    })
  }
}

async function checkDiscordWorkflowRegistered(config: AppConfig, checks: Check[]): Promise<void> {
  try {
    const response = await centaurFetch(config, '/workflows/registered')
    const body = (await response.json().catch(() => ({}))) as RegisteredWorkflowsResponse
    const workflows = Array.isArray(body.workflows) ? body.workflows : []
    const found = workflows.some(workflow => workflow.name === 'discord_thread_turn')
    addCheck(checks, {
      name: 'discord_thread_turn workflow',
      ok: response.ok && found,
      detail: found ? 'registered' : `not found (${response.status})`,
      hint: 'Mount the Warrunner overlay and include it in WORKFLOW_DIRS.'
    })
  } catch (error) {
    addCheck(checks, {
      name: 'discord_thread_turn workflow',
      ok: false,
      detail: errorMessage(error),
      hint: 'Verify CENTAUR_API_URL and DISCORDBOT_API_KEY.'
    })
  }
}

function addBotMentionCheck(config: AppConfig, botUser: DiscordUser | null, checks: Check[]): void {
  const configured = config.DISCORD_BOT_USER_ID?.trim() || config.DISCORD_APPLICATION_ID?.trim()
  const inferred = botUser?.id
  addCheck(checks, {
    name: 'bot mention id',
    ok: Boolean(configured || inferred),
    detail: configured ? `configured (${configured})` : inferred ? `inferable (${inferred})` : 'missing',
    hint:
      'Set DISCORD_BOT_USER_ID so home-channel mentions are recognized immediately at startup.'
  })
}

function channelTargets(label: string, ids: string[], expectedTypes: Set<number>) {
  return ids
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => ({ label, id, expectedTypes }))
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

async function centaurFetch(config: AppConfig, path: string): Promise<Response> {
  const apiKey = centaurApiKey(config)
  const response = await fetch(new URL(path, config.CENTAUR_API_URL), {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    }
  })
  return response
}

function addDiscordError(checks: Check[], name: string, error: unknown): void {
  const detail =
    error instanceof DiscordApiError ? `${error.status} ${error.message}` : errorMessage(error)
  addCheck(checks, {
    name,
    ok: false,
    detail,
    hint: 'Check the Discord token, bot permissions, and configured channel ids.'
  })
}

function addCheck(checks: Check[], check: Check): void {
  checks.push({ ...check, hint: check.ok ? undefined : check.hint })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)
}
