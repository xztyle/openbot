import { TEAM_AGENT_CREATE_MODEL_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import {
  FIRST_AGENT_SUGGESTIONS,
  type FirstAgentDraft,
  FirstAgentSetup,
} from "@openbot/ui/features/agents/FirstAgentSetup";
import { NewAgentDialog } from "@openbot/ui/features/agents/NewAgentDialog";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useProviders } from "../../providers";
import { useCustomAgents } from "../custom-agents/custom-agents-context";
import { useCustomProviders } from "../custom-providers/custom-providers-context";
import { useSetup } from "../onboarding/onboarding-context";
import { useServerSettings } from "../servers/server-settings";
import { useServers } from "../servers/servers-context";
import { useAgentActions } from "./agent-actions";
import { resolveCreationModel } from "./agent-creation-model";
import { useAgents } from "./agents-context";

/**
 * The create-an-agent form. The server's first agent takes over the conversation pane, as a step of
 * setting the server up; a later agent opens the New agent dialog over it (`dialog`), the same
 * frame as a new channel or space. Both are the same command with the same fields.
 */
export function WorkspaceAgentSetup(props: { dialog?: boolean }) {
  const {
    agentList,
    agentSetupDraft,
    setAgentSetupDraft,
    agentSetupError,
    creatingAgent,
    cancelAgentSetup,
    modelOptions,
    agentStatus,
    serverSetupChoice,
    developmentCreation,
  } = useAgents();
  const { createAgent } = useAgentActions();
  const { setupState } = useSetup();
  // Not gated on the server: the picker needs these IDs to label a model it is already showing,
  // and a remote server's OpenCode has its own catalogue. Only the write paths are local-only.
  const { customProviders } = useCustomProviders();
  const { customAgents } = useCustomAgents();
  const { activeServer, activeServerSupportsCapability } = useServers();
  const {
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    connectProvider,
    providerAdminServerId,
  } = useProviders();
  const { openServerSettings } = useServerSettings();
  /** Provider downloads are the local machine's business, never a remote host's. */
  const localProviderDownloads = createMemo(
    () => activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable(),
  );
  /** Providers are managed on this computer, or on a joined host by its owner or an admin. */
  const manageProviders = createMemo(() => activeServer()?.kind === "local" || providerAdminServerId() !== undefined);
  const openProviderSettings = (trigger: HTMLElement) => {
    const server = activeServer();
    if (server) openServerSettings(server.id, trigger, "providers");
  };
  /**
   * A remote host without the capability drops the pair in its frozen projection and starts the
   * agent on its own default, so the form offers no choice there: the backend default stands.
   */
  const createModelSupported = createMemo(
    () => activeServer()?.kind !== "remote" || activeServerSupportsCapability(TEAM_AGENT_CREATE_MODEL_CAPABILITY),
  );
  /**
   * The draft opens on the hard-coded default, which would bypass the saved setup choice and fail
   * outright after onboarding with a provider the default does not cover. Resolve it from the
   * saved choice and the live catalog until the user picks a model themselves. A joined server's
   * provider step chose for that server, so its choice comes first. A chosen reasoning level
   * also stops it, so the development default's level does not replace the user's.
   */
  const [modelTouched, setModelTouched] = createSignal(false);
  createEffect(
    () => ({
      touched: modelTouched(),
      setup: serverSetupChoice() ?? setupState(),
      options: modelOptions(),
      status: agentStatus(),
      development: developmentCreation(),
      draft: agentSetupDraft(),
    }),
    ({ touched, setup, options, status, development, draft }) => {
      if (touched) return;
      const resolved = resolveCreationModel(setup, options, status, development);
      if (!resolved) return;
      if (
        draft.provider === resolved.provider &&
        draft.model === resolved.model &&
        draft.reasoningEffort === resolved.reasoningEffort
      )
        return;
      setAgentSetupDraft({
        ...draft,
        provider: resolved.provider,
        model: resolved.model,
        reasoningEffort: resolved.reasoningEffort,
      });
    },
  );

  const fieldProps = {
    get value() {
      return agentSetupDraft();
    },
    suggestions: FIRST_AGENT_SUGGESTIONS,
    get submitting() {
      return creatingAgent();
    },
    get error() {
      return agentSetupError();
    },
    get modelOptions() {
      return createModelSupported() ? modelOptions() : undefined;
    },
    get agentStatus() {
      return agentStatus();
    },
    get runtimeStatuses() {
      return localProviderDownloads() ? providerRuntimeStatuses() : undefined;
    },
    get customProviders() {
      return customProviders();
    },
    // The custom agents are this computer's. A joined host's picker counts its own from its models.
    get customAgents() {
      return activeServer()?.kind === "local" ? customAgents() : undefined;
    },
    get onDownloadProvider() {
      return localProviderDownloads() ? downloadProviderRuntime : undefined;
    },
    get onCancelProviderDownload() {
      return localProviderDownloads() ? cancelProviderRuntimeDownload : undefined;
    },
    get onConnectProvider() {
      return localProviderDownloads() ? connectProvider : undefined;
    },
    get onAddCustomProvider() {
      return manageProviders() ? openProviderSettings : undefined;
    },
    get onManageProviders() {
      return manageProviders() ? openProviderSettings : undefined;
    },
    onChange: (next: FirstAgentDraft) => {
      const current = agentSetupDraft();
      if (
        next.provider !== current.provider ||
        next.model !== current.model ||
        next.reasoningEffort !== current.reasoningEffort
      )
        setModelTouched(true);
      setAgentSetupDraft(next);
    },
    onSubmit: createAgent,
  };

  return (
    <Show
      when={props.dialog}
      fallback={
        <FirstAgentSetup
          {...fieldProps}
          mode={agentList().length === 0 ? "first" : "additional"}
          onCancel={agentList().length > 0 ? cancelAgentSetup : undefined}
        />
      }
    >
      <NewAgentDialog
        {...fieldProps}
        open
        onOpenChange={(open) => {
          if (!open) cancelAgentSetup();
        }}
      />
    </Show>
  );
}
