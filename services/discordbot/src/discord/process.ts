import type { CentaurHandoffResult } from '../centaur/handoff'
import type { AppConfig } from '../config'
import { logError, logWarn } from '../logging'
import type { DiscordChannelResolver, DiscordClient } from './client'
import { normalizeDiscordMessage } from './normalize'
import type { DiscordMessage, NormalizedDiscordEvent } from './types'

export type DiscordHandoff = {
  emit(event: NormalizedDiscordEvent): Promise<CentaurHandoffResult>
}

export function createDiscordMessageProcessor(opts: {
  config: AppConfig
  discord: DiscordClient
  channels: DiscordChannelResolver
  handoff: DiscordHandoff
}): (message: DiscordMessage) => Promise<void> {
  return async function processDiscordMessage(message: DiscordMessage): Promise<void> {
    const parentChannelId = await parentChannelIdFor(opts.channels, message)
    const shallow = normalizeDiscordMessage({
      message,
      config: opts.config,
      parentChannelId
    })
    if (!shallow) return

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
    const normalized = normalizeDiscordMessage({
      message,
      config: opts.config,
      parentChannelId,
      historyMessages
    })
    if (!normalized) return

    const result = await opts.handoff.emit(normalized)
    if (!result.ok) {
      logError('centaur_handoff_failed', {
        status: result.status,
        body: result.body,
        thread_key: normalized.thread_key
      })
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
