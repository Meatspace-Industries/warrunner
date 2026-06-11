import type { CentaurHandoffResult } from '../centaur/handoff'
import type { AppConfig } from '../config'
import { logError, logWarn } from '../logging'
import type { DiscordChannelResolver, DiscordClient } from './client'
import { normalizeDiscordMessage } from './normalize'
import type { DiscordTypingIndicator } from './typing'
import type { DiscordMessage, NormalizedDiscordEvent } from './types'

export type DiscordHandoff = {
  emit(event: NormalizedDiscordEvent): Promise<CentaurHandoffResult>
}

const GUILD_ROLES_CACHE_TTL_MS = 10 * 60 * 1000

export function createDiscordMessageProcessor(opts: {
  config: AppConfig
  discord: DiscordClient
  channels: DiscordChannelResolver
  handoff: DiscordHandoff
  typing?: DiscordTypingIndicator
}): (message: DiscordMessage) => Promise<void> {
  const guildRolesCache = new Map<
    string,
    { fetchedAt: number; roleNamesById: Map<string, string> }
  >()

  async function roleNamesFor(guildId: string | undefined): Promise<Map<string, string>> {
    if (!guildId) return new Map()
    const cached = guildRolesCache.get(guildId)
    if (cached && Date.now() - cached.fetchedAt < GUILD_ROLES_CACHE_TTL_MS) {
      return cached.roleNamesById
    }
    try {
      const roles = await opts.discord.fetchGuildRoles(guildId)
      const roleNamesById = new Map(roles.map(role => [role.id, role.name]))
      guildRolesCache.set(guildId, { fetchedAt: Date.now(), roleNamesById })
      return roleNamesById
    } catch (error) {
      logWarn('discord_guild_roles_fetch_failed', { guild_id: guildId, error })
      return cached?.roleNamesById ?? new Map()
    }
  }

  return async function processDiscordMessage(message: DiscordMessage): Promise<void> {
    const parentChannelId = await parentChannelIdFor(opts.channels, message)
    const shallow = normalizeDiscordMessage({
      message,
      config: opts.config,
      parentChannelId
    })
    if (!shallow) return

    opts.typing?.start({
      threadKey: shallow.thread_key,
      channelId: shallow.channel_id
    })

    const historyMessages =
      opts.config.WARRUNNER_HISTORY_LIMIT > 0
        ? await opts.discord
            .fetchMessages({
              channelId: message.channel_id,
              before: message.id,
              limit: opts.config.WARRUNNER_HISTORY_LIMIT
            })
            .catch(error => {
              logWarn('discord_history_fetch_failed', error)
              return []
            })
        : []
    const roleNamesById = await roleNamesFor(message.guild_id)
    const normalized = normalizeDiscordMessage({
      message,
      config: opts.config,
      parentChannelId,
      historyMessages,
      roleNamesById
    })
    if (!normalized) {
      opts.typing?.stop({
        threadKey: shallow.thread_key,
        channelId: shallow.channel_id
      })
      return
    }

    try {
      const result = await opts.handoff.emit(normalized)
      if (!result.ok) {
        opts.typing?.stop({
          threadKey: normalized.thread_key,
          channelId: normalized.channel_id
        })
        logError('centaur_handoff_failed', {
          status: result.status,
          body: result.body,
          thread_key: normalized.thread_key
        })
      }
    } catch (error) {
      opts.typing?.stop({
        threadKey: normalized.thread_key,
        channelId: normalized.channel_id
      })
      throw error
    }
  }
}

async function parentChannelIdFor(
  channels: DiscordChannelResolver,
  message: DiscordMessage
): Promise<string | undefined> {
  try {
    return await channels.parentChannelId(message.channel_id)
  } catch (error) {
    logWarn('discord_channel_parent_lookup_failed', {
      channel_id: message.channel_id,
      error
    })
    return undefined
  }
}
