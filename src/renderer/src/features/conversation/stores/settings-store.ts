import { isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import type { AgentModelId, AgentProviderId, AgentReasoningEffort, UpdateAgentInput } from "@openbot/contracts/ipc";
import type {
  AgentRuntimeSettings,
  AgentRuntimeSettingsPatch,
} from "@openbot/ui/features/conversation/AgentSettingsPanel";
import { currentText } from "@openbot/ui/text";
import { agentConversationKey } from "../conversation-keys";
import type { ConversationProps, ConversationTarget } from "../conversation-types";

export function runtimeSettingsEqual(left: AgentRuntimeSettings, right: AgentRuntimeSettings): boolean {
  return (
    left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
  );
}

/** A save of an agent's settings. A failed one keeps the host's error, for its reason. */
export type AgentPatchResult = { saved: true } | { saved: false; error?: unknown };

function isCompleteRuntimeSettingsPatch(updates: AgentRuntimeSettingsPatch): updates is AgentRuntimeSettings {
  return "provider" in updates && "model" in updates;
}

export interface SettingsStoreDeps {
  props: ConversationProps;
  runtimeSettingsAttempts: Map<
    string,
    {
      generation: number;
      pending: boolean;
      settings: {
        provider: AgentProviderId;
        model: AgentModelId;
        reasoningEffort: AgentReasoningEffort;
      };
    }
  >;
  runtimeSettingsSaveTails: Map<string, Promise<boolean>>;
  settingsProvider: () => AgentProviderId;
  setSettingsProvider: (provider: AgentProviderId) => void;
  settingsModel: () => AgentModelId;
  setSettingsModel: (model: AgentModelId) => void;
  settingsReasoning: () => AgentReasoningEffort;
  setSettingsReasoning: (effort: AgentReasoningEffort) => void;
  setComposerError: (error: string | null, targetOverride?: ConversationTarget) => void;
  viewIsMounted: () => boolean;
  saveAgentPatch: (updates: Omit<UpdateAgentInput, "agentId">, targetAgentId?: string) => Promise<AgentPatchResult>;
}

export function createSettingsStore(deps: SettingsStoreDeps) {
  async function saveRuntimeSettings(
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
    errorMessage: string | null,
    targetAgentId = deps.props.agent?.id,
  ): Promise<boolean> {
    return (await saveRuntimeSettingsResult(settings, updates, errorMessage, targetAgentId)).saved;
  }

  async function saveRuntimeSettingsResult(
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
    errorMessage: string | null,
    targetAgentId = deps.props.agent?.id,
  ): Promise<AgentPatchResult> {
    const agentId = targetAgentId;
    if (!agentId) return { saved: false };
    const serverId = deps.props.server?.id ?? "local";
    const target = { agentId, serverId };
    // Both maps live on the controller, which outlives one server, so the key
    // has to say which server the settings belong to.
    const settingsKey = agentConversationKey(serverId, agentId);
    const previousAttempt = deps.runtimeSettingsAttempts.get(settingsKey);
    const generation = (previousAttempt?.generation ?? 0) + 1;
    deps.runtimeSettingsAttempts.set(settingsKey, { generation, pending: true, settings });
    if (errorMessage) deps.setComposerError(null, target);

    const previousSave = deps.runtimeSettingsSaveTails.get(settingsKey);
    let releaseSave!: (baseValid: boolean) => void;
    const saveTail = new Promise<boolean>((resolve) => {
      releaseSave = resolve;
    });
    deps.runtimeSettingsSaveTails.set(settingsKey, saveTail);
    let result: AgentPatchResult = { saved: false };
    let baseValid = true;
    let abandoned = false;
    try {
      if (previousSave) baseValid = await previousSave;
      // `agent.updateAgent` is routed by the server main has selected, not by the
      // agent id in its payload, so a save still queued behind an earlier one when
      // the user leaves would be applied to whichever server they arrive at. It
      // belongs to the one it was made on, and that one is gone.
      abandoned = !deps.viewIsMounted();
      const completePatch = isCompleteRuntimeSettingsPatch(updates);
      if (!abandoned && (baseValid || completePatch)) result = await deps.saveAgentPatch(updates, agentId);
      if (completePatch) baseValid = result.saved;
    } finally {
      releaseSave(baseValid);
      if (deps.runtimeSettingsSaveTails.get(settingsKey) === saveTail) {
        deps.runtimeSettingsSaveTails.delete(settingsKey);
      }
    }
    const latestAttempt = deps.runtimeSettingsAttempts.get(settingsKey);
    if (latestAttempt?.generation !== generation) return { saved: true };
    latestAttempt.pending = false;
    // Nothing left to report to: the pickers, the composer error and the agent
    // this would roll back to all belonged to the conversation that is gone.
    if (abandoned) return { saved: false };
    if (result.saved) {
      const activeAgent = deps.props.agent;
      if (activeAgent?.id === agentId) {
        const runtime = activeAgent.pendingRuntime ?? activeAgent;
        if (isKnownAgentProvider(runtime.provider)) deps.setSettingsProvider(runtime.provider);
        deps.setSettingsModel(runtime.model);
        deps.setSettingsReasoning(runtime.reasoningEffort);
      }
      return result;
    }

    const activeAgent = deps.props.agent;
    const currentSettings = {
      provider: deps.settingsProvider(),
      model: deps.settingsModel(),
      reasoningEffort: deps.settingsReasoning(),
    };
    if (activeAgent?.id !== agentId || !runtimeSettingsEqual(currentSettings, settings)) return result;
    const runtime = activeAgent.pendingRuntime ?? activeAgent;
    if (isKnownAgentProvider(runtime.provider)) deps.setSettingsProvider(runtime.provider);
    deps.setSettingsModel(runtime.model);
    deps.setSettingsReasoning(runtime.reasoningEffort);
    if (errorMessage) deps.setComposerError(currentText().errorMessage(result.error, errorMessage), target);
    return result;
  }

  async function updateRuntimeSettings(
    agentId: string,
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
  ): Promise<boolean> {
    if (deps.props.agent?.id === agentId) {
      deps.setSettingsProvider(settings.provider);
      deps.setSettingsModel(settings.model);
      deps.setSettingsReasoning(settings.reasoningEffort);
    }
    const result = await saveRuntimeSettingsResult(settings, updates, null, agentId);
    // The settings panel shows the reason of a failure that it is given.
    if (!result.saved && result.error !== undefined) throw result.error;
    return result.saved;
  }

  async function selectModel(
    model: AgentModelId,
    provider: AgentProviderId,
    persist = true,
    reportComposerError = false,
    accountId?: string | null,
  ): Promise<boolean> {
    const option = deps.props.modelOptions.find(
      (candidate) => candidate.provider === provider && candidate.id === model,
    );
    if (!option) return false;
    const reasoningEffort = option.supportedReasoningEfforts.includes(deps.settingsReasoning())
      ? deps.settingsReasoning()
      : option.defaultReasoningEffort;
    deps.setSettingsProvider(provider);
    deps.setSettingsModel(model);
    deps.setSettingsReasoning(reasoningEffort);
    if (!persist) return true;
    return saveRuntimeSettings(
      { provider, model, reasoningEffort },
      accountId === undefined
        ? { provider, model, reasoningEffort }
        : { provider, model, reasoningEffort, providerAccountId: accountId },
      reportComposerError ? currentText().t("composer.error.changeModel") : null,
    );
  }

  async function selectAndConfirmModel(
    model: AgentModelId,
    provider: AgentProviderId,
    accountId?: string | null,
  ): Promise<void> {
    await selectModel(model, provider, true, true, accountId);
  }

  async function selectAndConfirmReasoning(effort: AgentReasoningEffort): Promise<void> {
    const option = deps.props.modelOptions.find(
      (candidate) => candidate.provider === deps.settingsProvider() && candidate.id === deps.settingsModel(),
    );
    if (!option?.supportedReasoningEfforts.includes(effort)) return;
    const settings = {
      provider: deps.settingsProvider(),
      model: deps.settingsModel(),
      reasoningEffort: effort,
    };
    deps.setSettingsReasoning(effort);
    await saveRuntimeSettings(settings, { reasoningEffort: effort }, currentText().t("composer.error.changeEffort"));
  }

  return {
    saveRuntimeSettings,
    updateRuntimeSettings,
    selectModel,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
  };
}
