export type DiscordUser = {
  id: string
  username?: string
  global_name?: string | null
  bot?: boolean
}

export type DiscordMember = {
  roles?: string[]
  nick?: string | null
  user?: DiscordUser
}

export type DiscordAttachment = {
  id: string
  filename: string
  content_type?: string
  size?: number
  url?: string
  proxy_url?: string
}

export type DiscordMessage = {
  id: string
  channel_id: string
  guild_id?: string
  content?: string
  author?: DiscordUser
  member?: DiscordMember
  attachments?: DiscordAttachment[]
  mentions?: DiscordUser[]
  message_reference?: DiscordMessageReference
  referenced_message?: DiscordMessage | null
  webhook_id?: string
  type?: number
}

export type DiscordMessageReference = {
  message_id: string
  channel_id?: string
  guild_id?: string
  fail_if_not_exists?: boolean
}

export type DiscordAllowedMentions = {
  parse: string[]
  users?: string[]
}

export type DiscordCreateMessageBody = {
  content: string
  allowed_mentions?: DiscordAllowedMentions
  message_reference?: DiscordMessageReference
}

export type DiscordChannel = {
  id: string
  type: number
  guild_id?: string
  name?: string
  parent_id?: string | null
  thread_metadata?: Record<string, unknown>
}

export type DiscordGatewayPayload = {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

export type NormalizedPart = {
  type: 'text'
  text: string
}

export type DiscordHistoryMessage = {
  message_id: string
  role?: 'user' | 'assistant'
  parts: NormalizedPart[]
  user_id?: string
  metadata?: Record<string, unknown>
}

export type NormalizedDiscordEvent = {
  thread_key: string
  message_id: string
  guild_id: string
  channel_id: string
  parent_channel_id?: string
  user_id: string
  parts: NormalizedPart[]
  history_messages?: DiscordHistoryMessage[]
  discord: {
    message_id: string
    channel_id: string
    parent_channel_id?: string
    guild_id: string
    is_mention?: boolean
  }
}
