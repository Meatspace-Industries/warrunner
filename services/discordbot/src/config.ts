import { z } from 'zod'

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

const ListFromEnv = z
  .string()
  .default('')
  .transform(value => splitList(value))

const BoolFromEnv = z
  .union([z.boolean(), z.string()])
  .default('true')
  .transform(value => {
    if (typeof value === 'boolean') return value
    const normalized = value.trim().toLowerCase()
    return !['0', 'false', 'no', 'off'].includes(normalized)
  })

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  DISCORD_API_URL: z.string().url().default('https://discord.com/api/v10'),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_BOT_USER_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_GATEWAY_ENABLED: BoolFromEnv,
  CENTAUR_API_URL: z.string().url().default('http://localhost:8000'),
  CENTAUR_API_KEY: z.string().optional(),
  DISCORDBOT_API_KEY: z.string().optional(),
  WARRUNNER_HOME_FORUM_CHANNEL_ID: z.string().default(''),
  WARRUNNER_HOME_CHANNEL_ID: z.string().default(''),
  WARRUNNER_HOME_CHANNEL_IDS: ListFromEnv,
  WARRUNNER_INTAKE_CHANNEL_IDS: ListFromEnv,
  WARRUNNER_ALLOWED_ROLE_IDS: ListFromEnv,
  WARRUNNER_HISTORY_LIMIT: z.coerce.number().int().min(0).max(100).default(40),
  WARRUNNER_REQUIRE_HOME_THREAD: BoolFromEnv,
  WARRUNNER_HOME_CHANNEL_MENTION_REQUIRED: BoolFromEnv,
  DISCORD_GATEWAY_RECONNECT_MS: z.coerce.number().int().min(1000).default(5000)
})

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env)
}

export function centaurApiKey(config: AppConfig): string | undefined {
  return config.DISCORDBOT_API_KEY || config.CENTAUR_API_KEY || undefined
}

export function discordBotToken(config: AppConfig): string | undefined {
  const token = config.DISCORD_BOT_TOKEN?.trim()
  return token || undefined
}

export function homeChannelIds(config: AppConfig): Set<string> {
  return new Set(
    [
      config.WARRUNNER_HOME_FORUM_CHANNEL_ID,
      config.WARRUNNER_HOME_CHANNEL_ID,
      ...config.WARRUNNER_HOME_CHANNEL_IDS
    ]
      .map(value => value.trim())
      .filter(Boolean)
  )
}
