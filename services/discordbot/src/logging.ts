const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const BEARER_TOKEN_RE = /\bbearer\s+[A-Z0-9._~+/=-]+/gi
const DISCORD_TOKEN_RE = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g
const FIELD_SPLIT_RE = /(?<!^)(?=[A-Z])|[^A-Za-z0-9]+/g

const SECRET_FIELD_TOKENS = new Set(['password', 'secret', 'token'])
const SECRET_FIELD_NAMES = new Set(['apikey', 'authorization', 'bottoken', 'clientsecret'])

function normalizeFieldName(fieldName: string | undefined): string {
  return (fieldName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function fieldTokens(fieldName: string | undefined): Set<string> {
  return new Set(
    (fieldName ?? '')
      .split(FIELD_SPLIT_RE)
      .filter(Boolean)
      .map(part => part.toLowerCase())
  )
}

export function sanitizeLogString(value: string): string {
  return value
    .replace(BEARER_TOKEN_RE, 'Bearer [REDACTED:secret]')
    .replace(DISCORD_TOKEN_RE, '[REDACTED:discord-token]')
    .replace(EMAIL_RE, '[REDACTED:email]')
}

export function sanitizeLogValue(
  value: unknown,
  fieldName?: string,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') {
    const normalizedField = normalizeFieldName(fieldName)
    const tokens = fieldTokens(fieldName)
    if (
      SECRET_FIELD_NAMES.has(normalizedField) ||
      [...tokens].some(token => SECRET_FIELD_TOKENS.has(token))
    ) {
      return '[REDACTED:secret]'
    }
    return sanitizeLogString(value)
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogString(value.message),
      cause: 'cause' in value ? sanitizeLogValue(value.cause, 'cause', seen) : undefined
    }
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(item => sanitizeLogValue(item, fieldName, seen))

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeLogValue(item, key, seen)])
  )
}

export function logInfo(event: string, ...values: unknown[]): void {
  console.log(event, ...values.map(value => sanitizeLogValue(value)))
}

export function logWarn(event: string, ...values: unknown[]): void {
  console.warn(event, ...values.map(value => sanitizeLogValue(value)))
}

export function logError(event: string, ...values: unknown[]): void {
  console.error(event, ...values.map(value => sanitizeLogValue(value)))
}
