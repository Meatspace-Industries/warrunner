export type DogfoodEnv = NodeJS.ProcessEnv & {
  WARRUNNER_DOGFOOD_ENV_FILE?: string
  WARRUNNER_DOGFOOD_OPEN_DISCORD?: string
  WARRUNNER_DOGFOOD_TRANSCRIPT_DIR?: string
}

export type DogfoodGlobalArgs = {
  envFile?: string
  transcriptDir?: string
  positional: string[]
  error?: string
}

const ENV_FILE_FLAGS = ['--env-file', '--dogfood-env-file', '--warrunner-env-file'] as const
const ENV_FILE_PREFIXES = ENV_FILE_FLAGS.map(flag => `${flag}=`)
const TRANSCRIPT_DIR_FLAGS = ['--transcript-dir', '--dogfood-transcript-dir'] as const
const TRANSCRIPT_DIR_PREFIXES = TRANSCRIPT_DIR_FLAGS.map(flag => `${flag}=`)

export function parseDogfoodGlobalArgs(
  args: string[],
  env: Pick<DogfoodEnv, 'WARRUNNER_DOGFOOD_ENV_FILE'> = process.env as DogfoodEnv
): DogfoodGlobalArgs {
  const positional: string[] = []
  let envFile = env.WARRUNNER_DOGFOOD_ENV_FILE?.trim() || undefined
  let transcriptDir: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--') continue
    if (isEnvFileFlag(arg)) {
      const value = args[index + 1]?.trim()
      if (!value || value.startsWith('--')) return { positional, error: `${arg} requires a path` }
      envFile = value
      index += 1
      continue
    }
    const prefix = ENV_FILE_PREFIXES.find(candidate => arg.startsWith(candidate))
    if (prefix) {
      const value = arg.slice(prefix.length).trim()
      if (!value) return { positional, error: `${prefix.slice(0, -1)} requires a path` }
      envFile = value
      continue
    }
    if (isTranscriptDirFlag(arg)) {
      const value = args[index + 1]?.trim()
      if (!value || value.startsWith('--')) return { positional, error: `${arg} requires a path` }
      transcriptDir = value
      index += 1
      continue
    }
    const transcriptPrefix = TRANSCRIPT_DIR_PREFIXES.find(candidate => arg.startsWith(candidate))
    if (transcriptPrefix) {
      const value = arg.slice(transcriptPrefix.length).trim()
      if (!value) return { positional, error: `${transcriptPrefix.slice(0, -1)} requires a path` }
      transcriptDir = value
      continue
    }
    positional.push(arg)
  }
  return { ...(envFile ? { envFile } : {}), ...(transcriptDir ? { transcriptDir } : {}), positional }
}

function isEnvFileFlag(arg: string): boolean {
  return ENV_FILE_FLAGS.some(flag => arg === flag)
}

function isTranscriptDirFlag(arg: string): boolean {
  return TRANSCRIPT_DIR_FLAGS.some(flag => arg === flag)
}

export async function loadDogfoodEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  envFile?: string
): Promise<DogfoodEnv> {
  if (!envFile) return baseEnv as DogfoodEnv
  try {
    const text = await Bun.file(envFile).text()
    return { ...baseEnv, ...parseDogfoodEnvFile(text) } as DogfoodEnv
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to load dogfood env file ${envFile}: ${message}`)
  }
}

export function parseDogfoodEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const equalsIndex = normalized.indexOf('=')
    if (equalsIndex <= 0) continue
    const key = normalized.slice(0, equalsIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = parseEnvValue(normalized.slice(equalsIndex + 1).trim())
  }
  return env
}

function parseEnvValue(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }
  const commentIndex = value.search(/\s#/)
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim()
}
