import { foreignProvider, isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import {
  type AgentModelId,
  type AgentProviderRef,
  type AgentReasoningEffort,
  agentNextProviderAccountId,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerDisplayName,
} from "@openbot/contracts/ipc";
import { isAgentTaskActive } from "@openbot/team-client/agent-tasks";
import { reasoningLabel } from "@openbot/ui/components/ProviderModelPicker";
import { providerAccountName } from "@openbot/ui/components/provider-accounts";
import { ConversationHeader as SharedConversationHeader } from "@openbot/ui/features/conversation/ConversationHeader";
import { useConversationViewScope } from "./conversation-scope";

const loadAgentSettingsPanel = () => import("./AgentSettingsPanel");

/** The runtime of the running turn, or of the next one, as the "After this turn" badge names it. */
interface BadgeRuntime {
  provider: AgentProviderRef;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  providerAccountId?: string | undefined;
}

import { useText } from "@openbot/ui/text";

/** @internal Stable HMR boundary for conversation header. */
export function ConversationHeader() {
  const { t } = useText();
  const {
    actingBrowserControl,
    agentActivity,
    browserControlAgent,
    changeFastMode,
    channel,
    fastMode,
    props,
    runningTurnRuntime,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
    setActiveRightPanel,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    handleChatSearchShortcut,
    sidePanelOpen,
    toggleSidePanel,
  } = useConversationViewScope();
  const runningTasks = () => props.tasks?.snapshot?.tasks.filter(isAgentTaskActive).length ?? 0;
  const working = () => agentActivity() === "Working";
  const providerName = (provider: AgentProviderRef) =>
    isKnownAgentProvider(provider) ? providerDisplayName(provider) : String(provider);
  const accountId = (runtime: BadgeRuntime) => runtime.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
  const accountName = (runtime: BadgeRuntime) =>
    providerAccountName(
      t,
      props.agentStatus?.providers?.find((status) => status.id === runtime.provider)?.accounts ?? [],
      accountId(runtime),
    );
  /** Each part shows only where the two runtimes differ, so a model change alone names only the models. */
  const runtimeLabel = (runtime: BadgeRuntime, other: BadgeRuntime) => {
    const parts = [
      props.modelOptions.find((option) => option.provider === runtime.provider && option.id === runtime.model)?.name ??
        runtime.model,
    ];
    if (runtime.provider !== other.provider) parts.unshift(providerName(runtime.provider));
    else if (accountId(runtime) !== accountId(other)) parts.unshift(accountName(runtime));
    if (runtime.reasoningEffort !== other.reasoningEffort) parts.push(reasoningLabel(runtime.reasoningEffort, t));
    return parts.join(" · ");
  };
  /** A change chosen during a turn or a task. It applies from the next turn. */
  const pendingModel = () => {
    const agent = props.agent;
    if (!agent || !(working() || runningTasks() > 0)) return undefined;
    const running: BadgeRuntime = (working() ? runningTurnRuntime() : null) ?? agent;
    const next: BadgeRuntime = agent.pendingRuntime ?? {
      provider: settingsProvider(),
      model: settingsModel(),
      reasoningEffort: settingsReasoning(),
      providerAccountId: agent.providerAccountId,
    };
    if (
      running.provider === next.provider &&
      running.model === next.model &&
      running.reasoningEffort === next.reasoningEffort &&
      accountId(running) === accountId(next)
    )
      return undefined;
    return { running: runtimeLabel(running, next), next: runtimeLabel(next, running) };
  };
  return (
    <SharedConversationHeader
      actions={props.headerActions}
      agent={props.agent}
      title={channel ? <channel.HeaderTitle onOpenSettings={() => setActiveRightPanel("settings")} /> : undefined}
      onSettingsIntent={() => void loadAgentSettingsPanel()}
      onOpenSettings={() => setActiveRightPanel("settings")}
      // The scope exposes the search through its shortcut handler, so the button sends the same key.
      onOpenSearch={() =>
        handleChatSearchShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }))
      }
      pendingModel={pendingModel()}
      modelPicker={{
        provider: settingsProvider(),
        foreignProvider: props.agent ? foreignProvider(props.agent.provider) : undefined,
        value: settingsModel(),
        reasoningEffort: settingsReasoning(),
        modelOptions: props.modelOptions,
        agentStatus: props.agentStatus,
        runtimeStatuses: props.providerRuntimeStatuses,
        customProviders: props.customProviders,
        customAgents: props.customAgents,
        onDownloadProvider: props.onDownloadProvider,
        onCancelProviderDownload: props.onCancelProviderDownload,
        onConnectProvider: props.onConnectProvider,
        canConnectProvider: props.canConnectProvider,
        onManageProviders: props.onManageProviders,
        // A model, effort, provider or account chosen during a turn applies from the next turn.
        disabledReason: t("conversation.header.modelsUnavailable"),
        accountChoice: true,
        providerAccountId: props.agent ? agentNextProviderAccountId(props.agent) : undefined,
        onChange: (model, provider, accountId) => void selectAndConfirmModel(model, provider, accountId),
        onReasoningEffortChange: (effort) => void selectAndConfirmReasoning(effort),
        // Codex only for now, and only on this computer: the Team API does not carry fast mode.
        fastMode: fastMode(),
        onFastModeChange:
          settingsProvider() === "codex" && props.server?.kind === "local"
            ? (next) => void changeFastMode(next)
            : undefined,
      }}
      remoteControl={
        props.remoteDesktopEnabled !== false && props.server?.kind === "remote"
          ? {
              enabled: Boolean(props.remoteDesktopSessionActive || props.server.state === "online"),
              active: Boolean(props.remoteDesktopSessionActive),
              visible: Boolean(props.remoteDesktopVisible),
              onOpen: (trigger) => {
                if (props.server) void props.onOpenRemoteDesktop(props.server.id, trigger);
              },
            }
          : undefined
      }
      sidePanel={
        channel?.readOnly()
          ? undefined
          : {
              open: sidePanelOpen(),
              actingAgentName: actingBrowserControl()
                ? (browserControlAgent()?.name ?? t("conversation.header.agentFallback"))
                : undefined,
              running: runningTasks(),
              onToggle: toggleSidePanel,
            }
      }
    />
  );
}
