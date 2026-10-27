// What main answers for the Slack workspaces, Discord servers and Telegram chats of this computer.
// These guard the renderer.

import {
  type AddMessagingOrchestratorResult,
  type DiscordAccess,
  type DiscordChannelConfig,
  type DiscordChannelList,
  type DiscordRoleList,
  isAddMessagingOrchestratorResult,
  isDiscordAccess,
  isDiscordChannelConfig,
  isDiscordChannelList,
  isDiscordRoleList,
  isMessagingOverview,
  isTelegramOverview,
  type MessagingOverview,
  type TelegramOverview,
} from "@openbot/contracts/ipc";

/** The orchestrator that main created, and the sidebar section it went to. */
export function decodeAddOrchestratorReply(value: unknown): AddMessagingOrchestratorResult {
  if (!isAddMessagingOrchestratorResult(value)) throw new Error("Invalid messaging orchestrator response.");
  return value;
}

export function decodeMessagingOverviewReply(value: unknown): MessagingOverview {
  if (!isMessagingOverview(value)) throw new Error("Invalid messaging overview response.");
  return value;
}

export function decodeTelegramOverviewReply(value: unknown): TelegramOverview {
  if (!isTelegramOverview(value)) throw new Error("Invalid Telegram overview response.");
  return value;
}

export function decodeDiscordAccessReply(value: unknown): DiscordAccess {
  if (!isDiscordAccess(value)) throw new Error("Invalid Discord access response.");
  return value;
}

export function decodeDiscordRolesReply(value: unknown): DiscordRoleList {
  if (!isDiscordRoleList(value)) throw new Error("Invalid Discord roles response.");
  return value;
}

export function decodeDiscordChannelConfigReply(value: unknown): DiscordChannelConfig {
  if (!isDiscordChannelConfig(value)) throw new Error("Invalid Discord channel settings response.");
  return value;
}

export function decodeDiscordChannelListReply(value: unknown): DiscordChannelList {
  if (!isDiscordChannelList(value)) throw new Error("Invalid Discord channels response.");
  return value;
}
