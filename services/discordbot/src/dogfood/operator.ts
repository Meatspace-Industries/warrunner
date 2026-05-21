import { spawn as nodeSpawn } from 'node:child_process'

type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' }
) => { unref?: () => void }

export type DogfoodCliArgs = {
  openDiscord: boolean
  turnLimit?: number
  timeoutMs?: number
  pollIntervalMs?: number
  positional: string[]
  error?: string
}

export type OpenDiscordUrlResult =
  | {
      ok: true
      command: string
      args: string[]
      url: string
    }
  | {
      ok: false
      error: string
      url: string
    }

export function parseDogfoodCliArgs(
  args: string[],
  env: { WARRUNNER_DOGFOOD_OPEN_DISCORD?: string } = process.env as unknown as {
    WARRUNNER_DOGFOOD_OPEN_DISCORD?: string
  }
): DogfoodCliArgs {
  let openDiscord = truthy(env.WARRUNNER_DOGFOOD_OPEN_DISCORD)
  let turnLimit: number | undefined
  let timeoutMs: number | undefined
  let pollIntervalMs: number | undefined
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--open' || arg === '--open-discord') {
      openDiscord = true
      continue
    }
    if (arg === '--no-open' || arg === '--no-open-discord') {
      openDiscord = false
      continue
    }
    if (arg === '--turns' || arg === '--session-turns') {
      const value = args[index + 1]?.trim()
      const parsed = parsePositiveIntegerFlag(arg, value)
      if ('error' in parsed) return { openDiscord, positional, error: parsed.error }
      turnLimit = parsed.value
      index += 1
      continue
    }
    if (arg.startsWith('--turns=') || arg.startsWith('--session-turns=')) {
      const [flag, value = ''] = splitFlagValue(arg)
      const parsed = parsePositiveIntegerFlag(flag, value)
      if ('error' in parsed) return { openDiscord, positional, error: parsed.error }
      turnLimit = parsed.value
      continue
    }
    if (arg === '--timeout-ms') {
      const value = args[index + 1]?.trim()
      const parsed = parsePositiveIntegerFlag(arg, value)
      if ('error' in parsed) return { openDiscord, positional, error: parsed.error }
      timeoutMs = parsed.value
      index += 1
      continue
    }
    if (arg.startsWith('--timeout-ms=')) {
      const parsed = parsePositiveIntegerFlag('--timeout-ms', arg.slice('--timeout-ms='.length))
      if ('error' in parsed) return { openDiscord, positional, error: parsed.error }
      timeoutMs = parsed.value
      continue
    }
    if (arg === '--poll-interval-ms') {
      const value = args[index + 1]?.trim()
      const parsed = parsePositiveIntegerFlag(arg, value)
      if ('error' in parsed) return { openDiscord, positional, error: parsed.error }
      pollIntervalMs = parsed.value
      index += 1
      continue
    }
    if (arg.startsWith('--poll-interval-ms=')) {
      const parsed = parsePositiveIntegerFlag(
        '--poll-interval-ms',
        arg.slice('--poll-interval-ms='.length)
      )
      if ('error' in parsed) return { openDiscord, positional, error: parsed.error }
      pollIntervalMs = parsed.value
      continue
    }
    positional.push(arg)
  }
  return {
    openDiscord,
    ...(turnLimit ? { turnLimit } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    positional
  }
}

export function liveProgressReporter(opts: {
  openDiscord: boolean
  log?: (line: string) => void
  openUrl?: (url: string) => OpenDiscordUrlResult
}): (line: string) => void {
  const log = opts.log ?? console.log
  const openUrl = opts.openUrl ?? openDiscordUrl
  const opened = new Set<string>()
  return line => {
    log(line)
    const url = discordUrlFromProgress(line)
    if (!url || !opts.openDiscord || opened.has(url)) return
    opened.add(url)
    const result = openUrl(url)
    log(result.ok ? `PASS opened Discord URL: ${url}` : `WARN Discord URL open failed: ${result.error}`)
  }
}

export function discordUrlFromProgress(line: string): string | undefined {
  const match = line.match(/^PASS Discord URL:\s*(https:\/\/discord\.com\/channels\/\S+)\s*$/m)
  return match?.[1]
}

export function openDiscordUrl(
  url: string,
  opts: { platform?: NodeJS.Platform; spawn?: SpawnLike } = {}
): OpenDiscordUrlResult {
  const command = discordOpenCommand(url, opts.platform ?? process.platform)
  if (!command) {
    return {
      ok: false,
      url,
      error: `unsupported platform for automatic Discord URL opening: ${opts.platform ?? process.platform}`
    }
  }
  try {
    const child = (opts.spawn ?? nodeSpawn)(command.command, command.args, {
      detached: true,
      stdio: 'ignore'
    })
    child.unref?.()
    return { ok: true, url, command: command.command, args: command.args }
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function discordOpenCommand(
  url: string,
  platform: NodeJS.Platform
): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'linux') return { command: 'xdg-open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return null
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function splitFlagValue(arg: string): [string, string] {
  const equalsIndex = arg.indexOf('=')
  return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)]
}

function parsePositiveIntegerFlag(
  flag: string,
  value: string | undefined
): { value: number } | { error: string } {
  if (!value || value.startsWith('--')) return { error: `${flag} requires a positive integer` }
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    return { error: `${flag} must be a positive integer` }
  }
  return { value: number }
}
