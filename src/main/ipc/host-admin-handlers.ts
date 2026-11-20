import {
  HOST_MEMBER_UPDATE_CAPABILITY,
  memberUpdateRoute,
} from "@openbot/contracts/team-protocol/host-member-update-v1";
import { HOST_RELEASE_CAPABILITY, HOST_RELEASE_ROUTES } from "@openbot/contracts/team-protocol/host-release-v1";
import { Effect, Result } from "effect";
import type { RemoteWorkflowError } from "../remote-service-effects";
// The server name, logo, timezone, agent memory limit, prompt cache time and app update of one
// server's host. On a joined server the request goes to the host. Identity, timezone, memory limit,
// prompt cache time, settings, cancellation, and forced restarts require an owner or admin.
// Ordinary members can check and request an idle update through host-member-update-v1.

import {
  type AgentAccessChange,
  type AgentAccessSnapshot,
  type ClaudeContextSetting,
  decodeAgentAccessSnapshot,
  decodeClaudeContextSetting,
  decodeHostAgentMemoryLimit,
  decodeHostTimezoneSettings,
  decodeHostTurnLimits,
  decodeHostUpdateStatus,
  decodePromptCacheTtlSetting,
  decodeWorkspaceSettings,
  type HostTurnLimitsInput,
  type HostUpdateSettingsChange,
  type HostUpdateStatus,
  hostAgentMemoryLimit,
  isPromptCacheTtl,
  isProviderEnvironmentProvider,
  LOCAL_SERVER_ID,
  PROVIDER_ENVIRONMENT_LIMITS,
  type PromptCacheTtl,
  type ProviderEnvironmentProvider,
  type ProviderEnvironmentUpdate,
  type ProviderEnvironmentVariableInput,
  parseAgentAccessChange,
  parseHostTurnLimitsInput,
  type ServerSummary,
  UPDATE_RESTART_MODES,
  type UpdateHostIdentityInput,
  type UpdateRestartMode,
  type WorkspaceSettings,
  withKeptAgentChannelDefaults,
} from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import { AGENT_ACCESS_CAPABILITY, AGENT_ACCESS_ROUTES } from "@openbot/contracts/team-protocol/agent-access-v1";
import {
  AGENT_MEMORY_LIMIT_CAPABILITY,
  AGENT_MEMORY_LIMIT_ROUTES,
} from "@openbot/contracts/team-protocol/agent-memory-limit-v1";
import { CLAUDE_CONTEXT_CAPABILITY, CLAUDE_CONTEXT_ROUTES } from "@openbot/contracts/team-protocol/claude-context-v1";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { HOST_ADMIN_CAPABILITY, HOST_ADMIN_ROUTES } from "@openbot/contracts/team-protocol/host-admin-v1";
import { HOST_TIMEZONE_CAPABILITY, HOST_TIMEZONE_ROUTES } from "@openbot/contracts/team-protocol/host-timezone-v1";
import {
  HOST_TURN_LIMITS_CAPABILITY,
  HOST_TURN_LIMITS_ROUTES,
} from "@openbot/contracts/team-protocol/host-turn-limits-v1";
import { HOST_UPDATE_CAPABILITY, HOST_UPDATE_ROUTES } from "@openbot/contracts/team-protocol/host-update-v1";
import {
  PROMPT_CACHE_TTL_CAPABILITY,
  PROMPT_CACHE_TTL_ROUTES,
} from "@openbot/contracts/team-protocol/prompt-cache-ttl-v1";
import {
  decodeProviderEnvironmentResponse,
  PROVIDER_ENVIRONMENT_CAPABILITY,
  PROVIDER_ENVIRONMENT_ROUTES,
} from "@openbot/contracts/team-protocol/provider-environment-v1";
import { WORKSPACE_CAPABILITY, WORKSPACE_ROUTES } from "@openbot/contracts/team-protocol/workspace-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { type AgentAccessStore, agentAccessSnapshot } from "../agent-access-store";
import type { AgentMemoryLimitSetting } from "../agent-memory-limit-preference-store";
import type { ClaudeContextPreferenceStore } from "../claude-context-preference-store";
import type { HostService } from "../host-service";
import type { HostTurnLimitsPreferenceStore } from "../host-turn-limits-preference-store";
import type { PromptCacheTtlPreferenceStore } from "../prompt-cache-ttl-preference-store";
import type { ProviderEnvironmentControl } from "../provider-environment-store";
import { acceptEmpty, decodeHostReleaseStatusFromHost, type ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import { parseServerTimezone, type ServerTimezonePreferenceStore } from "../server-timezone-preference-store";
import type { WorkspaceSettingsStore } from "../workspace-settings-store";
import { parseAgentMemoryLimitPreference, parseHostUpdateSettings } from "./app-inputs";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";
import { parseHostIdentity } from "./server-inputs";
import { withLocalHostSummary } from "./team-handlers";
import { isObject } from "./validation";

interface HostAdminRemoteServers {
  list(): ServerSummary[];
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
  refreshIdentity(serverId: string): Effect.Effect<ServerSummary, RemoteWorkflowError>;
}

interface HostAdminIpcDependencies {
  host: Pick<HostService, "updateIdentity">;
  remoteServers: HostAdminRemoteServers;
  serverTimezone: Pick<ServerTimezonePreferenceStore, "get" | "set">;
  hostTurnLimits: Pick<HostTurnLimitsPreferenceStore, "get" | "set">;
  agentMemoryLimit: AgentMemoryLimitSetting;
  promptCacheTtl: Pick<PromptCacheTtlPreferenceStore, "get" | "set">;
  claudeContext: Pick<ClaudeContextPreferenceStore, "get" | "set">;
  workspaceSettings: WorkspaceSettingsStore;
  providerEnvironment: Pick<ProviderEnvironmentControl, "get" | "set">;
  agentAccess: Pick<AgentAccessStore, "levels" | "set">;
  /** The server ID of this computer's host, when it has one. Roles are stored by it. */
  localServerId: () => string | undefined;
  localAgentIds: () => string[];
}

// The user of this computer owns its server, so the roles give them every agent.
const LOCAL_OWNER = { id: "local-owner", role: "owner" } as const;

/** The body of a `host-update-v1` route: `start` carries the mode, `settings` the switches. */
type HostUpdateBody = Record<string, never> | { restart: UpdateRestartMode } | HostUpdateSettingsChange;

export function hostAdminIpcHandlers({
  host,
  remoteServers,
  serverTimezone,
  hostTurnLimits,
  agentMemoryLimit,
  promptCacheTtl,
  claudeContext,
  workspaceSettings,
  providerEnvironment,
  agentAccess,
  localServerId,
  localAgentIds,
}: HostAdminIpcDependencies): Pick<IpcGroupHandlers, "hostAdmin"> {
  function remoteUpdate(serverId: string, route: string, body: HostUpdateBody): Promise<HostUpdateStatus> {
    const role = remoteServers.list().find((server) => server.id === serverId)?.role;
    const memberRoute = role === "member" && memberUpdateRoute(route);
    if (memberRoute && remoteServers.supportsCapability(serverId, HOST_MEMBER_UPDATE_CAPABILITY)) {
      return runCauseEffect(
        remoteServers.request(serverId, memberRoute, decodeHostUpdateStatus, { method: "POST", body: {} }),
      );
    }
    if (!remoteServers.supportsCapability(serverId, HOST_UPDATE_CAPABILITY))
      throw new Error(sourceText("error.team.hostUpdateUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeHostUpdateStatus, { method: "POST", body }));
  }
  function remoteTimezone(serverId: string, route: string, body: { timezone?: string | null }) {
    if (!remoteServers.supportsCapability(serverId, HOST_TIMEZONE_CAPABILITY))
      throw new Error(sourceText("error.team.hostTimezoneUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeHostTimezoneSettings, { method: "POST", body }));
  }
  function remoteTurnLimits(serverId: string, route: string, body: Record<string, never> | HostTurnLimitsInput) {
    if (!remoteServers.supportsCapability(serverId, HOST_TURN_LIMITS_CAPABILITY))
      throw new Error(sourceText("error.team.hostTurnLimitsUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeHostTurnLimits, { method: "POST", body }));
  }
  function remoteMemoryLimit(serverId: string, route: string, body: { limit?: number }) {
    if (!remoteServers.supportsCapability(serverId, AGENT_MEMORY_LIMIT_CAPABILITY))
      throw new Error(sourceText("error.team.agentMemoryLimitUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeHostAgentMemoryLimit, { method: "POST", body }));
  }
  function remotePromptCacheTtl(serverId: string, route: string, body: { ttl?: PromptCacheTtl }) {
    if (!remoteServers.supportsCapability(serverId, PROMPT_CACHE_TTL_CAPABILITY))
      throw new Error(sourceText("error.team.promptCacheTtlUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, route, decodePromptCacheTtlSetting, { method: "POST", body }),
    );
  }
  function remoteClaudeContext(serverId: string, route: string, body: ClaudeContextSetting | Record<string, never>) {
    if (!remoteServers.supportsCapability(serverId, CLAUDE_CONTEXT_CAPABILITY))
      throw new Error(sourceText("error.team.claudeContextUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeClaudeContextSetting, { method: "POST", body }));
  }
  function remoteWorkspaceSettings(serverId: string, route: string, body: WorkspaceSettings | Record<string, never>) {
    if (!remoteServers.supportsCapability(serverId, WORKSPACE_CAPABILITY))
      throw new Error(sourceText("error.team.workspaceUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeWorkspaceSettings, { method: "POST", body }));
  }
  function remoteProviderEnvironment(
    serverId: string,
    route: string,
    body: ProviderEnvironmentUpdate | { provider: ProviderEnvironmentProvider },
  ) {
    if (!remoteServers.supportsCapability(serverId, PROVIDER_ENVIRONMENT_CAPABILITY))
      throw new Error(sourceText("error.team.providerEnvironmentUnsupported"));
    return runCauseEffect(
      remoteServers.request(serverId, route, decodeProviderEnvironmentResponse, { method: "POST", body }),
    );
  }
  function localAccessServerId(): string {
    const serverId = localServerId();
    if (!serverId) throw new Error(sourceText("error.team.agentAccessUnsupported"));
    return serverId;
  }
  function remoteAccess(
    serverId: string,
    route: string,
    body: AgentAccessChange | Record<string, never>,
  ): Promise<AgentAccessSnapshot> {
    if (!remoteServers.supportsCapability(serverId, AGENT_ACCESS_CAPABILITY))
      throw new Error(sourceText("error.team.agentAccessUnsupported"));
    return runCauseEffect(remoteServers.request(serverId, route, decodeAgentAccessSnapshot, { method: "POST", body }));
  }
  // This computer updates from Settings. The renderer shows the tab for a joined server only.
  const localUpdate = (): never => {
    throw new Error(sourceText("error.team.hostUpdateUnsupported"));
  };
  return {
    hostAdmin: {
      updateIdentity: scopedHandler(parseHostIdentity, {
        local: async (input) => {
          const status = await runCauseEffect(host.updateIdentity(input));
          const summary = withLocalHostSummary(remoteServers.list(), status).find(
            (server) => server.id === LOCAL_SERVER_ID,
          );
          if (!summary) throw new Error(sourceText("error.host.noServer"));
          return summary;
        },
        remote: async (input, serverId) => {
          if (!remoteServers.supportsCapability(serverId, HOST_ADMIN_CAPABILITY))
            throw new Error(sourceText("error.host.identityLocalOnly"));
          await runCauseEffect(
            remoteServers.request(serverId, HOST_ADMIN_ROUTES.identity, acceptEmpty, {
              method: "POST",
              body: wireIdentity(input),
            }),
          );
          // The host has published the change before it answered, so this reads the new name and logo.
          return runCauseEffect(remoteServers.refreshIdentity(serverId));
        },
      }),
      getReleaseStatus: scopedQueryHandler({
        local: localUpdate,
        remote: (serverId) =>
          remoteServers.supportsCapability(serverId, HOST_RELEASE_CAPABILITY)
            ? runCauseEffect(
                remoteServers.request(serverId, HOST_RELEASE_ROUTES.status, decodeHostReleaseStatusFromHost, {
                  method: "POST",
                  body: {},
                }),
              )
            : Promise.resolve(null),
      }),
      checkRelease: scopedQueryHandler({
        local: localUpdate,
        remote: (serverId) => {
          if (!remoteServers.supportsCapability(serverId, HOST_RELEASE_CAPABILITY)) return localUpdate();
          return runCauseEffect(
            remoteServers.request(serverId, HOST_RELEASE_ROUTES.check, decodeHostReleaseStatusFromHost, {
              method: "POST",
              body: {},
            }),
          );
        },
      }),
      getUpdateStatus: scopedQueryHandler({
        local: localUpdate,
        remote: (serverId) => remoteUpdate(serverId, HOST_UPDATE_ROUTES.status, {}),
      }),
      checkForUpdate: scopedQueryHandler({
        local: localUpdate,
        remote: (serverId) => remoteUpdate(serverId, HOST_UPDATE_ROUTES.check, {}),
      }),
      startUpdate: scopedHandler(parseRestartMode, {
        local: localUpdate,
        remote: (restart, serverId) => remoteUpdate(serverId, HOST_UPDATE_ROUTES.start, { restart }),
      }),
      cancelUpdate: scopedQueryHandler({
        local: localUpdate,
        remote: (serverId) => remoteUpdate(serverId, HOST_UPDATE_ROUTES.cancel, {}),
      }),
      setUpdateSettings: scopedHandler(parseHostUpdateSettings, {
        local: localUpdate,
        remote: (settings, serverId) => remoteUpdate(serverId, HOST_UPDATE_ROUTES.settings, settings),
      }),
      getTimezone: scopedQueryHandler({
        local: () => serverTimezone.get(),
        remote: (serverId) => remoteTimezone(serverId, HOST_TIMEZONE_ROUTES.settings, {}),
      }),
      setTimezone: scopedHandler(parseServerTimezone, {
        local: (timezone) => runCauseEffect(serverTimezone.set(timezone)),
        remote: (timezone, serverId) => remoteTimezone(serverId, HOST_TIMEZONE_ROUTES.update, { timezone }),
      }),
      getTurnLimits: scopedQueryHandler({
        local: () => hostTurnLimits.get(),
        remote: (serverId) => remoteTurnLimits(serverId, HOST_TURN_LIMITS_ROUTES.settings, {}),
      }),
      setTurnLimits: scopedHandler(parseHostTurnLimitsInput, {
        local: (input) => runCauseEffect(hostTurnLimits.set(input)),
        remote: (input, serverId) => remoteTurnLimits(serverId, HOST_TURN_LIMITS_ROUTES.update, input),
      }),
      getAgentMemoryLimit: scopedQueryHandler({
        local: () => hostAgentMemoryLimit(agentMemoryLimit.get()),
        remote: (serverId) => remoteMemoryLimit(serverId, AGENT_MEMORY_LIMIT_ROUTES.settings, {}),
      }),
      // The host checks the value against its own choices, so a remote limit is any positive count.
      setAgentMemoryLimit: scopedHandler(parseMemoryLimitCount, {
        local: async (limit) =>
          hostAgentMemoryLimit(await runCauseEffect(agentMemoryLimit.set(parseAgentMemoryLimitPreference({ limit })))),
        remote: (limit, serverId) => remoteMemoryLimit(serverId, AGENT_MEMORY_LIMIT_ROUTES.update, { limit }),
      }),
      getPromptCacheTtl: scopedQueryHandler({
        local: () => promptCacheTtl.get(),
        remote: (serverId) => remotePromptCacheTtl(serverId, PROMPT_CACHE_TTL_ROUTES.settings, {}),
      }),
      setPromptCacheTtl: scopedHandler(parsePromptCacheTtl, {
        local: (ttl) => runCauseEffect(promptCacheTtl.set(ttl)),
        remote: (ttl, serverId) => remotePromptCacheTtl(serverId, PROMPT_CACHE_TTL_ROUTES.update, { ttl }),
      }),
      getClaudeContext: scopedQueryHandler({
        local: () => claudeContext.get(),
        remote: (serverId) => remoteClaudeContext(serverId, CLAUDE_CONTEXT_ROUTES.settings, {}),
      }),
      setClaudeContext: scopedHandler(decodeClaudeContextSetting, {
        local: (setting) => runCauseEffect(claudeContext.set(setting)),
        remote: (setting, serverId) => remoteClaudeContext(serverId, CLAUDE_CONTEXT_ROUTES.update, setting),
      }),
      getWorkspaceSettings: scopedQueryHandler({
        local: () => workspaceSettings.get(),
        remote: (serverId) => remoteWorkspaceSettings(serverId, WORKSPACE_ROUTES.settings, {}),
      }),
      setWorkspaceSettings: scopedHandler(decodeWorkspaceSettings, {
        local: (settings) =>
          runCauseEffect(workspaceSettings.set(withKeptAgentChannelDefaults(workspaceSettings.get(), settings))),
        remote: (settings, serverId) => remoteWorkspaceSettings(serverId, WORKSPACE_ROUTES.settingsUpdate, settings),
      }),
      getProviderEnvironment: scopedHandler(parseProviderEnvironmentProvider, {
        local: (provider) => providerEnvironment.get(provider),
        remote: (provider, serverId) =>
          remoteProviderEnvironment(serverId, PROVIDER_ENVIRONMENT_ROUTES.settings, { provider }),
      }),
      setProviderEnvironment: scopedHandler(parseProviderEnvironmentUpdate, {
        local: (update) => runCauseEffect(providerEnvironment.set(update)),
        remote: (update, serverId) => remoteProviderEnvironment(serverId, PROVIDER_ENVIRONMENT_ROUTES.update, update),
      }),
      getAgentAccess: scopedQueryHandler({
        local: () => {
          const serverId = localAccessServerId();
          return agentAccessSnapshot(agentAccess.levels(serverId), LOCAL_OWNER, localAgentIds());
        },
        remote: (serverId) => remoteAccess(serverId, AGENT_ACCESS_ROUTES.read, {}),
      }),
      setAgentAccess: scopedHandler(parseAgentAccessChange, {
        local: async (change) => {
          const serverId = localAccessServerId();
          // The local owner sees every agent of this host.
          const shown = new Set(localAgentIds());
          const saved = await Effect.runPromise(Effect.result(agentAccess.set(serverId, change, shown, shown)));
          if (Result.isFailure(saved)) {
            if (saved.failure._tag === "AgentAccessStale") throw new Error(sourceText("error.team.agentAccessStale"));
            throw saved.failure.cause;
          }
          return agentAccessSnapshot(agentAccess.levels(serverId), LOCAL_OWNER, [...shown]);
        },
        remote: (change, serverId) => remoteAccess(serverId, AGENT_ACCESS_ROUTES.set, change),
      }),
    },
  };
}

function wireIdentity(input: UpdateHostIdentityInput) {
  return {
    ...(input.serverName === undefined ? {} : { serverName: input.serverName }),
    ...(input.logo === undefined
      ? {}
      : {
          logo: input.logo
            ? { mimeType: input.logo.mimeType, data: Buffer.from(input.logo.bytes).toString("base64") }
            : null,
        }),
  };
}

function parseProviderEnvironmentProvider(value: unknown): ProviderEnvironmentProvider {
  if (!isProviderEnvironmentProvider(value)) throw new Error("A provider with variables is required.");
  return value;
}

/** The renderer's change. A value can be a secret: no error here quotes one. */
function parseProviderEnvironmentUpdate(value: unknown): ProviderEnvironmentUpdate {
  if (
    !isObject(value) ||
    !Array.isArray(value.variables) ||
    value.variables.length > PROVIDER_ENVIRONMENT_LIMITS.variables
  )
    throw new Error("Invalid provider variables.");
  const provider = parseProviderEnvironmentProvider(value.provider);
  const variables: ProviderEnvironmentVariableInput[] = value.variables.map((item: unknown) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      item.name.length > PROVIDER_ENVIRONMENT_LIMITS.name ||
      typeof item.sensitive !== "boolean" ||
      (item.value !== null && (typeof item.value !== "string" || item.value.length > PROVIDER_ENVIRONMENT_LIMITS.value))
    )
      throw new Error("Invalid provider variables.");
    return { name: item.name, value: item.value, sensitive: item.sensitive };
  });
  return { provider, variables };
}
function parsePromptCacheTtl(value: unknown): PromptCacheTtl {
  if (!isPromptCacheTtl(value)) throw new Error("Prompt cache time is required.");
  return value;
}

function parseMemoryLimitCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Agent memory limit is required.");
  return value;
}

function parseRestartMode(value: unknown): UpdateRestartMode {
  if (!isOneOf(UPDATE_RESTART_MODES, value)) throw new Error("A restart mode is required.");
  return value;
}
