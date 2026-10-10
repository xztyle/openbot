import { agentProviderDescriptor, agentProviderName } from "@openbot/contracts/agent-providers";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_ACCESS_MODES,
  type AgentAccess,
  type AgentModelId,
  type AgentModelOption,
  type AgentProviderId,
  type AgentReasoningEffort,
  type AgentStatus,
  type AvatarHue,
  type AvatarImageInput,
  agentAutomationAllowed,
  agentComputerUseEnabled,
  type BusyMessageMode,
  type CustomAgentSummary,
  type CustomProviderSummary,
  DEFAULT_AGENT_ACCESS,
  DEFAULT_BUSY_MESSAGE_MODE,
  type ProviderRuntimeStatus,
  type UpdateAgentInput,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Bell,
  Brain,
  Button,
  ConfirmDialog,
  Cpu,
  IconButton,
  Input,
  Pencil,
  Popover,
  RefreshCw,
  RotateCcw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ShieldCheck,
  SlidersHorizontal,
  Switch,
  Text,
  Textarea,
} from "@openbot/ui";
import { normalizeAvatarFile } from "@openbot/ui/avatar-image";
import { AVATAR_HUE_OPTIONS, avatarCandidateSeeds, avatarHueSwatch } from "@openbot/ui/bloub-avatar";
import { ProviderModelPicker, reasoningLabel } from "@openbot/ui/components/ProviderModelPicker";
import {
  SettingsField,
  SettingsLinkGroup,
  SettingsLinkRow,
  SettingsPanel,
  SettingsPanelContent,
  SettingsPanelHeader,
} from "@openbot/ui/components/SettingsPanel";
import type { AgentProfile } from "@openbot/ui/data";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { useText } from "../../text";
import { AVATAR_HUE_LABEL } from "../agents/avatar-hue-label";
import { limitNoteText } from "../settings/limit-note";

export interface AgentRuntimeSettings {
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
}

export type AgentRuntimeSettingsPatch = AgentRuntimeSettings | Pick<AgentRuntimeSettings, "reasoningEffort">;

export interface AgentSettingsPanelProps {
  agent: AgentProfile;
  runtimeSettings: AgentRuntimeSettings;
  agentStatus: AgentStatus;
  modelOptions: AgentModelOption[];
  working: boolean;
  /** Access belongs to the computer that runs the agent, so a remote server hides the control. */
  accessEditable?: boolean;
  /** Computer Use is local-only too, and no remote host administers it yet. */
  computerUseEditable?: boolean;
  /** Local scripts reach only the computer that runs the agent, so a remote server hides the control. */
  automationEditable?: boolean;
  /** The busy-message setting is local-only too: the Team API does not carry it. */
  busyMessageModeEditable?: boolean;
  /** The app default an agent without its own busy-message setting follows. */
  defaultBusyMessageMode?: BusyMessageMode;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  /** The caller supplies providers available on the selected host. */
  customProviders?: readonly CustomProviderSummary[];
  /** The user's own ACP agents on this computer, for the model picker's Custom tab. */
  customAgents?: readonly CustomAgentSummary[];
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onAddCustomProvider?: (trigger: HTMLElement) => void;
  maxWidth: () => number;
  onClose: () => void;
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  /** Application-owned navigation and detail surfaces, in the existing panel layout. */
  links?: JSX.Element;
  detailOpen?: boolean;
  children?: JSX.Element;
  onUpdateAgent: (agentId: string, updates: Omit<UpdateAgentInput, "agentId">) => Promise<void>;
  onUpdateRuntimeSettings: (
    agentId: string,
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
  ) => Promise<boolean>;
  onSetAgentAvatar: (agentId: string, image: AvatarImageInput | null) => Promise<void>;
  /**
   * Starts a new chat with the agent after the user confirms. The agent forgets the messages before
   * it and keeps its setup. Left out when the host cannot do it.
   */
  onStartNewChat?: () => Promise<void>;
}

const INSTRUCTIONS_SAVE_DELAY_MS = 400;

/**
 * The pages behind the root list. The root edits the agent's face, name, title and instructions
 * in place, as the mobile app does, and shows one row for each page.
 */
type AgentSettingsPage = "permissions" | "advanced";

const PAGE_TITLE: Record<AgentSettingsPage, AppTextKey> = {
  permissions: "agentSettings.permissions.title",
  advanced: "agentSettings.advanced.title",
};

/** The three free-text fields of the panel, each with a flag for edits made since the last save. */
interface AgentTextFields {
  description: string;
  name: string;
  title: string;
}

interface AvatarEditor {
  batch: number;
  candidateSeed: string;
  hue: AvatarHue | null;
  pickerOpen: boolean;
  seed: string;
  uploadBusy: boolean;
}

/**
 * Everything the panel is editing for the agent it currently shows. `fields` and `dirty` stay
 * parallel records so the props sync can write every field the user has not touched; `runtime` is
 * one record because the three settings are sent, and rolled back, together.
 */
interface AgentSettingsDraft {
  avatar: AvatarEditor;
  dirty: Record<keyof AgentTextFields, boolean>;
  fields: AgentTextFields;
  notifications: boolean;
  access: AgentAccess;
  computerUse: boolean;
  allowAutomation: boolean;
  /** `default` follows the app setting. */
  busyMessage: BusyMessageChoice;
  /** Widening to full access waits here for the confirmation. */
  confirmingFullAccess: boolean;
  runtime: AgentRuntimeSettings;
  /** The name was left empty. An agent needs a name, so nothing is saved until there is one. */
  nameMissing: boolean;
  saveError: SaveFailure | null;
}

/**
 * The setting that a failed save belongs to. The failure shows next to that control and names it,
 * so it is not lost at the end of a long panel.
 */
type SaveField =
  | "avatar"
  | "avatarFace"
  | "avatarColor"
  | "name"
  | "title"
  | "description"
  | "runtime"
  | "notifications"
  | "access"
  | "computerUse"
  | "automation"
  | "busyMessage";

const SAVE_FAILED_TEXT = {
  avatar: "agentSettings.avatar.saveFailed",
  avatarFace: "agentSettings.saveFailed.avatarFace",
  avatarColor: "agentSettings.saveFailed.avatarColor",
  name: "agentSettings.saveFailed.name",
  title: "agentSettings.saveFailed.title",
  description: "agentSettings.saveFailed.instructions",
  runtime: "agentSettings.saveFailed.runtime",
  notifications: "agentSettings.saveFailed.notifications",
  access: "agentSettings.saveFailed.access",
  computerUse: "agentSettings.saveFailed.computerUse",
  automation: "agentSettings.saveFailed.automation",
  busyMessage: "agentSettings.saveFailed.busyMessage",
} as const satisfies Record<SaveField, AppTextKey>;

interface SaveFailure {
  field: SaveField | null;
  message: string;
}

interface TextSaveRequest {
  agentId: string;
  draftValue: string;
  field: keyof AgentTextFields;
  storedValue: string;
}

export default function AgentSettingsPanel(props: AgentSettingsPanelProps) {
  const { t, format, errorMessage } = useText();
  const limitNote = limitNoteText(t, format);
  const [newChatOpen, setNewChatOpen] = createSignal(false);
  const [newChatError, setNewChatError] = createSignal<string | null>(null);
  async function startNewChat(start: () => Promise<void>): Promise<void> {
    setNewChatError(null);
    try {
      await start();
      setNewChatOpen(false);
    } catch (error) {
      setNewChatError(errorMessage(error, t("agentSettings.newChat.failed")));
    }
  }
  const [draft, setDraft] = createStore<AgentSettingsDraft>({
    avatar: {
      batch: 0,
      candidateSeed: "agent",
      hue: null,
      pickerOpen: false,
      seed: "agent",
      uploadBusy: false,
    },
    dirty: { description: false, name: false, title: false },
    fields: { description: "", name: "", title: "" },
    notifications: true,
    access: DEFAULT_AGENT_ACCESS,
    computerUse: true,
    allowAutomation: false,
    busyMessage: "default",
    confirmingFullAccess: false,
    runtime: untrack(() => ({ ...props.runtimeSettings })),
    nameMissing: false,
    saveError: null,
  });
  const avatarUrl = () => props.agent.avatarUrl ?? null;
  const [page, setPage] = createSignal<AgentSettingsPage | null>(null);
  // The root row that opened the closed page takes the focus back when the root shows again.
  let returnFocusPage: AgentSettingsPage | null = null;

  function pageRowRef(target: AgentSettingsPage) {
    return (element: HTMLButtonElement) => {
      if (returnFocusPage !== target) return;
      returnFocusPage = null;
      queueMicrotask(() => element.focus());
    };
  }

  let pageRoot: HTMLDivElement | undefined;

  /**
   * The row that opened the page is gone, so the focus moves to the first control of the page.
   * A page with no control, such as read-only permissions, gives the focus to the back button.
   */
  function openPage(target: AgentSettingsPage): void {
    setPage(target);
    queueMicrotask(() =>
      (
        pageRoot?.querySelector<HTMLElement>("button:not(:disabled), input, textarea, select") ??
        pageRoot?.closest("aside")?.querySelector<HTMLElement>(".settings-panel-nav-button")
      )?.focus(),
    );
  }

  function closePage(): void {
    returnFocusPage = page();
    setPage(null);
  }

  function workspaceEnforcementNote(provider: AgentProviderId): string {
    switch (agentProviderDescriptor(provider).workspaceEnforcement) {
      case "tool-sandbox":
        return t("agentSettings.runtime.workspaceEnforcedClaude");
      case "command-sandbox":
        return t("agentSettings.runtime.workspaceEnforcedCommand");
      case "confined-process":
        return t("agentSettings.runtime.workspaceEnforcedProcess", { provider: agentProviderName(provider) });
    }
  }

  /** The failure under the control: every save path clears it first and reports its failure through it. */
  function setSaveError(message: string | null, field: SaveField | null = null): void {
    setDraft((state) => {
      state.saveError = message === null ? null : { field, message };
    });
  }

  /** What failed, then why when the error gives a reason a person can read. */
  function failureText(field: SaveField | null, error: unknown): string {
    return failureWithReason(t(field ? SAVE_FAILED_TEXT[field] : "agentSettings.saveFailed"), error);
  }

  function failureWithReason(what: string, error: unknown): string {
    const reason = errorMessage(error, what);
    return reason === what ? what : `${what} ${reason}`;
  }

  /** The failed save of one control, shown right under it. */
  function SaveError(errorProps: { field: SaveField }): JSX.Element {
    return (
      <Show when={draft.saveError?.field === errorProps.field ? draft.saveError.message : null}>
        {(message) => (
          <p class="agent-settings-save-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    );
  }

  const selectedModel = createMemo(() =>
    props.modelOptions.find(
      (option) => option.provider === draft.runtime.provider && option.id === draft.runtime.model,
    ),
  );
  const reasoningOptions = createMemo(() => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const]);
  // The provider has no reasoning setting for this model, and the `medium` it lists is never sent.
  const reasoningSetByProvider = () => selectedModel()?.reasoningEffortConfigurable === false;
  const avatarCandidates = createMemo(() =>
    avatarCandidateSeeds(props.agent.id, draft.avatar.candidateSeed, draft.avatar.batch),
  );
  let avatarPickerRoot: HTMLDivElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;
  let lastSignature: string | undefined;
  let lastAgentId: string | undefined;
  // Instructions save while the field remains focused. One queue also keeps blur, panel-close and
  // agent-change saves ordered, so an older completion cannot declare a newer draft clean.
  let instructionsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTextSave: TextSaveRequest | null = null;
  let disposed = false;
  const pendingTextSaves = new Map<string, TextSaveRequest>();

  createEffect(
    () => {
      const agent = props.agent;
      const runtimeSettings = props.runtimeSettings;
      return {
        agent,
        runtimeSettings,
        signature: [
          agent.id,
          agent.name,
          agent.title,
          agent.description,
          String(agent.notifications),
          agent.access ?? DEFAULT_AGENT_ACCESS,
          String(agentComputerUseEnabled(agent)),
          String(agentAutomationAllowed(agent)),
          agent.busyMessageMode ?? "default",
          runtimeSettings.provider,
          runtimeSettings.model,
          runtimeSettings.reasoningEffort,
          agent.avatarSeed,
          String(agent.avatarHue),
        ].join("\u0000"),
      };
    },
    ({ agent, runtimeSettings, signature }) =>
      untrack(() => {
        if (signature === lastSignature) return;
        const agentChanged = agent.id !== lastAgentId;
        if (agentChanged && lastAgentId) flushDirtyTextFields(lastAgentId);
        // A field the user has edited keeps its draft, unless this is a different agent, whose values
        // replace the panel wholesale. Read before the write, so a fresh agent clears the flags here.
        const keep = {
          description: !agentChanged && draft.dirty.description,
          name: !agentChanged && draft.dirty.name,
          title: !agentChanged && draft.dirty.title,
        };
        lastSignature = signature;
        lastAgentId = agent.id;
        if (agentChanged) {
          returnFocusPage = null;
          setPage(null);
        }
        setDraft((state) => {
          if (agentChanged) {
            state.dirty.description = false;
            state.dirty.name = false;
            state.dirty.title = false;
            state.nameMissing = false;
          }
          if (!keep.name) state.fields.name = agent.name;
          if (!keep.title) state.fields.title = agent.title;
          if (!keep.description) state.fields.description = agent.description;
          state.notifications = agent.notifications;
          state.access = agent.access ?? DEFAULT_AGENT_ACCESS;
          state.computerUse = agentComputerUseEnabled(agent);
          state.allowAutomation = agentAutomationAllowed(agent);
          state.busyMessage = agent.busyMessageMode ?? "default";
          if (agentChanged) state.confirmingFullAccess = false;
          state.runtime.provider = runtimeSettings.provider;
          state.runtime.model = runtimeSettings.model;
          state.runtime.reasoningEffort = runtimeSettings.reasoningEffort;
          state.avatar.seed = agent.avatarSeed;
          state.avatar.hue = agent.avatarHue;
          if (agentChanged) {
            state.avatar.candidateSeed = agent.avatarSeed;
            state.avatar.batch = 0;
            state.avatar.pickerOpen = false;
          }
        });
      }),
  );

  onSettled(() => {
    const closeAvatarPicker = (event: PointerEvent) => {
      if (!draft.avatar.pickerOpen) return;
      if (event.target instanceof Node && avatarPickerRoot?.contains(event.target)) return;
      setDraft((state) => {
        state.avatar.pickerOpen = false;
      });
    };
    window.addEventListener("pointerdown", closeAvatarPicker);
    return () => window.removeEventListener("pointerdown", closeAvatarPicker);
  });

  onCleanup(() => {
    if (lastAgentId) flushDirtyTextFields(lastAgentId);
    disposed = true;
  });

  async function saveAgentPatch(
    updates: Omit<UpdateAgentInput, "agentId">,
    agentId = props.agent.id,
    field: SaveField | null = null,
  ): Promise<boolean> {
    if (!disposed && props.agent.id === agentId) setSaveError(null);
    try {
      await props.onUpdateAgent(agentId, updates);
      return true;
    } catch (error) {
      if (!disposed && props.agent.id === agentId) {
        setSaveError(failureText(field, error), field);
      }
      return false;
    }
  }

  function textSaveRequest(
    field: keyof AgentTextFields,
    agentId: string,
    draftValue = draft.fields[field],
  ): TextSaveRequest {
    return {
      agentId,
      draftValue,
      field,
      storedValue: field === "name" || field === "title" ? draftValue.trim() : draftValue,
    };
  }

  function textSaveKey(request: TextSaveRequest): string {
    return `${request.agentId}\u0000${request.field}`;
  }

  function textSavePatch(request: TextSaveRequest): Omit<UpdateAgentInput, "agentId"> {
    switch (request.field) {
      case "name":
        return { name: request.storedValue };
      case "title":
        return { title: request.storedValue };
      case "description":
        return { description: request.storedValue };
    }
  }

  function queueTextSave(request: TextSaveRequest): void {
    // An agent with no name is not saved as "New agent" in silence: the field shows the problem.
    if (request.field === "name" && !request.storedValue) return;
    if (
      activeTextSave?.agentId === request.agentId &&
      activeTextSave.field === request.field &&
      activeTextSave.draftValue === request.draftValue
    ) {
      return;
    }
    pendingTextSaves.set(textSaveKey(request), request);
    void drainTextSaves();
  }

  async function drainTextSaves(): Promise<void> {
    if (activeTextSave) return;
    const entry = pendingTextSaves.entries().next().value;
    if (!entry) return;
    const [key, request] = entry;
    pendingTextSaves.delete(key);
    activeTextSave = request;
    const saved = await saveAgentPatch(textSavePatch(request), request.agentId, request.field);
    if (
      !disposed &&
      saved &&
      props.agent.id === request.agentId &&
      draft.fields[request.field] === request.draftValue
    ) {
      setDraft((state) => {
        state.dirty[request.field] = false;
      });
    }
    activeTextSave = null;
    if (pendingTextSaves.size > 0) void drainTextSaves();
  }

  function cancelInstructionsSaveTimer(): void {
    if (instructionsSaveTimer === undefined) return;
    clearTimeout(instructionsSaveTimer);
    instructionsSaveTimer = undefined;
  }

  function scheduleInstructionsSave(value: string): void {
    cancelInstructionsSaveTimer();
    const request = textSaveRequest("description", props.agent.id, value);
    instructionsSaveTimer = setTimeout(() => {
      instructionsSaveTimer = undefined;
      queueTextSave(request);
    }, INSTRUCTIONS_SAVE_DELAY_MS);
  }

  function flushDirtyTextFields(agentId: string): void {
    cancelInstructionsSaveTimer();
    for (const field of ["name", "title", "description"] as const) {
      if (draft.dirty[field]) queueTextSave(textSaveRequest(field, agentId));
    }
  }

  async function saveRuntimeSettings(
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
    agentId = props.agent.id,
  ): Promise<boolean> {
    setSaveError(null);
    try {
      const saved = await props.onUpdateRuntimeSettings(agentId, settings, updates);
      if (!saved && props.agent.id === agentId) setSaveError(t(SAVE_FAILED_TEXT.runtime), "runtime");
      return saved;
    } catch (error) {
      if (props.agent.id === agentId) {
        setSaveError(failureText("runtime", error), "runtime");
      }
      return false;
    }
  }

  /**
   * Switching to another app blurs the focused field while the window is inactive. That is not the
   * person leaving the field: Chromium gives focus back on return, and the save happens at the next
   * real blur. The save when the panel closes does not depend on this.
   */
  const windowInactive = () => !document.hasFocus();

  function saveName(): void {
    if (windowInactive()) return;
    const value = draft.fields.name.trim();
    setDraft((state) => {
      state.fields.name = value;
      state.nameMissing = value === "";
    });
    queueTextSave(textSaveRequest("name", props.agent.id));
  }

  function saveTitle(): void {
    if (windowInactive()) return;
    const value = draft.fields.title.trim();
    setDraft((state) => {
      state.fields.title = value;
    });
    queueTextSave(textSaveRequest("title", props.agent.id));
  }

  function saveDescription(): void {
    cancelInstructionsSaveTimer();
    queueTextSave(textSaveRequest("description", props.agent.id));
  }

  async function setCustomAvatar(image: AvatarImageInput | null): Promise<boolean> {
    if (draft.avatar.uploadBusy) return false;
    setDraft((state) => {
      state.avatar.uploadBusy = true;
      state.saveError = null;
    });
    try {
      await props.onSetAgentAvatar(props.agent.id, image);
      return true;
    } catch (error) {
      setSaveError(failureText("avatar", error), "avatar");
      return false;
    } finally {
      setDraft((state) => {
        state.avatar.uploadBusy = false;
      });
    }
  }

  async function uploadAgentAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    setDraft((state) => {
      state.avatar.uploadBusy = true;
      state.saveError = null;
    });
    try {
      const image = await normalizeAvatarFile(file);
      await props.onSetAgentAvatar(props.agent.id, image);
    } catch (error) {
      setSaveError(failureWithReason(t("agentSettings.avatar.processFailed"), error), "avatar");
    } finally {
      setDraft((state) => {
        state.avatar.uploadBusy = false;
      });
      if (avatarFileInput) avatarFileInput.value = "";
    }
  }

  async function selectGeneratedAvatar(seed: string): Promise<void> {
    const agentId = props.agent.id;
    if (avatarUrl() && !(await setCustomAvatar(null))) return;
    const previous = draft.avatar.seed;
    setDraft((state) => {
      state.avatar.seed = seed;
    });
    if (await saveAgentPatch({ avatarSeed: seed }, agentId, "avatarFace")) return;
    // The face on screen must be the saved one, so a failed save puts the old face back.
    if (!disposed && props.agent.id === agentId && draft.avatar.seed === seed) {
      setDraft((state) => {
        state.avatar.seed = previous;
      });
    }
  }

  async function selectAvatarHue(next: AvatarHue | null): Promise<void> {
    const agentId = props.agent.id;
    const previous = draft.avatar.hue;
    setDraft((state) => {
      state.avatar.hue = next;
    });
    if (await saveAgentPatch({ avatarHue: next }, agentId, "avatarColor")) return;
    if (!disposed && props.agent.id === agentId && draft.avatar.hue === next) {
      setDraft((state) => {
        state.avatar.hue = previous;
      });
    }
  }

  async function saveNotifications(next: boolean): Promise<void> {
    const agentId = props.agent.id;
    const previous = draft.notifications;
    setDraft((state) => {
      state.notifications = next;
    });
    if (await saveAgentPatch({ notifications: next }, agentId, "notifications")) return;
    if (!disposed && props.agent.id === agentId && draft.notifications === next) {
      setDraft((state) => {
        state.notifications = previous;
      });
    }
  }

  async function selectModel(nextModel: AgentModelId, nextProvider: AgentProviderId): Promise<void> {
    const option = props.modelOptions.find(
      (candidate) => candidate.provider === nextProvider && candidate.id === nextModel,
    );
    if (!option) return;
    // A plain copy, not `snapshot`: a snapshot of an unmodified subtree is the store's own object,
    // which the write below would mutate, leaving nothing to roll back to.
    const previous: AgentRuntimeSettings = {
      model: draft.runtime.model,
      provider: draft.runtime.provider,
      reasoningEffort: draft.runtime.reasoningEffort,
    };
    const agentId = props.agent.id;
    const settings: AgentRuntimeSettings = {
      model: nextModel,
      provider: nextProvider,
      reasoningEffort: option.supportedReasoningEfforts.includes(previous.reasoningEffort)
        ? previous.reasoningEffort
        : option.defaultReasoningEffort,
    };
    setDraft((state) => {
      state.runtime.provider = settings.provider;
      state.runtime.model = settings.model;
      state.runtime.reasoningEffort = settings.reasoningEffort;
    });
    if (await saveRuntimeSettings(settings, settings, agentId)) return;
    // Roll back only what this call wrote: another agent, or a later pick, owns the panel now.
    if (props.agent.id !== agentId || !sameRuntimeSettings(draft.runtime, settings)) return;
    setDraft((state) => {
      state.runtime.provider = previous.provider;
      state.runtime.model = previous.model;
      state.runtime.reasoningEffort = previous.reasoningEffort;
    });
  }

  async function selectReasoning(nextReasoning: AgentReasoningEffort): Promise<void> {
    const agentId = props.agent.id;
    const previousReasoning = draft.runtime.reasoningEffort;
    const settings: AgentRuntimeSettings = {
      model: draft.runtime.model,
      provider: draft.runtime.provider,
      reasoningEffort: nextReasoning,
    };
    setDraft((state) => {
      state.runtime.reasoningEffort = nextReasoning;
    });
    if (await saveRuntimeSettings(settings, { reasoningEffort: nextReasoning }, agentId)) return;
    if (props.agent.id === agentId && sameRuntimeSettings(draft.runtime, settings)) {
      setDraft((state) => {
        state.runtime.reasoningEffort = previousReasoning;
      });
    }
  }

  async function saveAccess(nextAccess: AgentAccess): Promise<void> {
    const agentId = props.agent.id;
    const previousAccess = draft.access;
    setDraft((state) => {
      state.access = nextAccess;
    });
    if (await saveAgentPatch({ access: nextAccess }, agentId, "access")) return;
    if (!disposed && props.agent.id === agentId && draft.access === nextAccess) {
      setDraft((state) => {
        state.access = previousAccess;
      });
    }
  }

  async function saveBusyMessage(next: BusyMessageChoice): Promise<void> {
    const agentId = props.agent.id;
    const previous = draft.busyMessage;
    setDraft((state) => {
      state.busyMessage = next;
    });
    if (await saveAgentPatch({ busyMessageMode: next === "default" ? null : next }, agentId, "busyMessage")) return;
    if (!disposed && props.agent.id === agentId && draft.busyMessage === next) {
      setDraft((state) => {
        state.busyMessage = previous;
      });
    }
  }

  const appBusyMessageMode = () => props.defaultBusyMessageMode ?? DEFAULT_BUSY_MESSAGE_MODE;
  const busyMessageLabel = (choice: BusyMessageChoice) =>
    t(choice === "default" ? APP_DEFAULT_BUSY_MESSAGE_LABEL[appBusyMessageMode()] : BUSY_MESSAGE_LABEL[choice]);
  const steerUnsupported = () =>
    (draft.busyMessage === "default" ? appBusyMessageMode() : draft.busyMessage) === "steer" &&
    agentProviderDescriptor(draft.runtime.provider).steer !== "native";

  async function saveComputerUse(next: boolean): Promise<void> {
    const agentId = props.agent.id;
    setDraft((state) => {
      state.computerUse = next;
    });
    if (await saveAgentPatch({ computerUse: next }, agentId, "computerUse")) return;
    if (!disposed && props.agent.id === agentId && draft.computerUse === next) {
      setDraft((state) => {
        state.computerUse = !next;
      });
    }
  }

  async function saveAllowAutomation(next: boolean): Promise<void> {
    const agentId = props.agent.id;
    setDraft((state) => {
      state.allowAutomation = next;
    });
    if (await saveAgentPatch({ allowAutomation: next }, agentId, "automation")) return;
    if (!disposed && props.agent.id === agentId && draft.allowAutomation === next) {
      setDraft((state) => {
        state.allowAutomation = !next;
      });
    }
  }

  return (
    <SettingsPanel
      onResizeEnd={props.onResizeEnd}
      id="settings-side-panel"
      label={t("agentSettings.label")}
      width={props.width}
      maxWidth={props.maxWidth}
      onResize={props.onResize}
    >
      <Show when={!props.detailOpen}>
        <Show
          when={page()}
          fallback={
            <SettingsPanelHeader
              title={t("agentSettings.title")}
              onBack={props.onClose}
              backLabel={t("agentSettings.backToDetails")}
              onClose={props.onClose}
              closeLabel={t("agentSettings.closeDetails")}
            />
          }
        >
          {(current) => (
            <SettingsPanelHeader
              title={t(PAGE_TITLE[current()])}
              onBack={closePage}
              backLabel={t("agentSettings.backToSettings")}
              onClose={props.onClose}
              closeLabel={t("agentSettings.closeDetails")}
            />
          )}
        </Show>
      </Show>
      <Show when={!props.detailOpen}>
        <SettingsPanelContent>
          <div ref={(element) => (pageRoot = element)} class="agent-settings-page">
            <Show when={page() === null}>
              <div ref={(element) => (avatarPickerRoot = element)} class="agent-settings-avatar-picker">
                <Popover.Root
                  open={draft.avatar.pickerOpen}
                  placement="bottom"
                  gutter={11}
                  onOpenChange={(open) =>
                    setDraft((state) => {
                      if (open) {
                        state.avatar.candidateSeed = state.avatar.seed;
                        state.avatar.batch = 0;
                      }
                      state.avatar.pickerOpen = open;
                    })
                  }
                >
                  <Popover.Trigger class="agent-settings-avatar" aria-label={t("agentSettings.avatar.edit")}>
                    <AgentAvatar seed={draft.avatar.seed} hue={draft.avatar.hue} url={avatarUrl()} motion="always" />
                    <span class="agent-settings-avatar-badge" aria-hidden="true">
                      <Pencil class="agent-settings-avatar-badge-icon" />
                    </span>
                  </Popover.Trigger>
                  <Popover.Content class="avatar-editor" aria-hidden={draft.avatar.pickerOpen ? undefined : "true"}>
                    <Popover.Title class="sr-only">{t("agentSettings.avatar.editor")}</Popover.Title>
                    <Input
                      ref={(element) => (avatarFileInput = element)}
                      class="sr-only"
                      type="file"
                      aria-label={t("agentSettings.avatar.uploadImage")}
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => void uploadAgentAvatar(event.currentTarget.files?.[0])}
                    />
                    <div class="avatar-editor-heading">
                      <span>{t("agentSettings.avatar.image")}</span>
                      <div class="avatar-editor-actions">
                        <Show when={avatarUrl()}>
                          <Button
                            variant="outline"
                            type="button"
                            disabled={draft.avatar.uploadBusy}
                            onClick={() => void setCustomAvatar(null)}
                          >
                            {t("common.remove")}
                          </Button>
                        </Show>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      type="button"
                      class={["avatar-image-upload", { "avatar-image-upload-active": Boolean(avatarUrl()) }]}
                      disabled={draft.avatar.uploadBusy}
                      onClick={() => avatarFileInput?.click()}
                    >
                      <span class="avatar-image-upload-preview">
                        <Show
                          when={avatarUrl()}
                          fallback={
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M12 5v14M5 12h14" />
                            </svg>
                          }
                        >
                          <AgentAvatar seed={draft.avatar.seed} hue={draft.avatar.hue} url={avatarUrl()} />
                        </Show>
                      </span>
                      <span>
                        <strong>
                          {avatarUrl() ? t("agentSettings.avatar.replaceImage") : t("agentSettings.avatar.uploadImage")}
                        </strong>
                        <small>{t("agentSettings.avatar.imageHint")}</small>
                      </span>
                    </Button>
                    <div class="avatar-editor-divider" />
                    <div class="avatar-editor-heading">
                      <span>{t("agentSettings.avatar.generatedFace")}</span>
                      <div class="avatar-editor-actions">
                        <Show when={draft.avatar.seed !== props.agent.id}>
                          <IconButton
                            variant="outline"
                            type="button"
                            label={t("agentSettings.avatar.resetToId")}
                            onClick={() => {
                              setDraft((state) => {
                                state.avatar.candidateSeed = props.agent.id;
                                state.avatar.batch = 0;
                              });
                              void selectGeneratedAvatar(props.agent.id);
                            }}
                          >
                            <RotateCcw aria-hidden="true" />
                          </IconButton>
                        </Show>
                        <IconButton
                          variant="outline"
                          type="button"
                          label={t("agentSettings.avatar.newSet")}
                          onClick={() =>
                            setDraft((state) => {
                              state.avatar.candidateSeed = state.avatar.seed;
                              state.avatar.batch += 1;
                            })
                          }
                        >
                          <RefreshCw aria-hidden="true" />
                        </IconButton>
                      </div>
                    </div>
                    <fieldset class="avatar-face-grid" aria-label={t("agentSettings.avatar.faces")}>
                      <For each={avatarCandidates()}>
                        {(seed, index) => (
                          <Button
                            variant="ghost"
                            type="button"
                            class={[
                              "avatar-face-choice",
                              { "avatar-choice-selected": !avatarUrl() && draft.avatar.seed === seed },
                            ]}
                            aria-label={
                              !avatarUrl() && draft.avatar.seed === seed
                                ? t("agentSettings.avatar.selected")
                                : t("agentSettings.avatar.option", { number: index() + 1 })
                            }
                            aria-pressed={!avatarUrl() && draft.avatar.seed === seed ? "true" : "false"}
                            data-cuelume-tap="select"
                            onClick={() => void selectGeneratedAvatar(seed)}
                          >
                            <AgentAvatar seed={seed} hue={draft.avatar.hue} />
                          </Button>
                        )}
                      </For>
                    </fieldset>
                    <div class="avatar-editor-divider" />
                    <div class="avatar-editor-heading">
                      <span>{t("agentSettings.avatar.color")}</span>
                    </div>
                    <fieldset class="avatar-color-grid" aria-label={t("agentSettings.avatar.colorLabel")}>
                      <Button
                        variant="ghost"
                        type="button"
                        class={["avatar-color-choice", { "avatar-choice-selected": draft.avatar.hue === null }]}
                        aria-label={t("agentSettings.avatar.autoColor")}
                        aria-pressed={draft.avatar.hue === null ? "true" : "false"}
                        data-cuelume-tap="select"
                        onClick={() => void selectAvatarHue(null)}
                      >
                        <span class="avatar-color-swatch avatar-color-swatch-auto">
                          {t("agentSettings.avatar.autoInitial")}
                        </span>
                      </Button>
                      <For each={AVATAR_HUE_OPTIONS}>
                        {(option) => (
                          <Button
                            variant="ghost"
                            type="button"
                            class={[
                              "avatar-color-choice",
                              { "avatar-choice-selected": draft.avatar.hue === option.hue },
                            ]}
                            aria-label={t("agentSettings.avatar.hueColor", { hue: t(AVATAR_HUE_LABEL[option.hue]) })}
                            aria-pressed={draft.avatar.hue === option.hue ? "true" : "false"}
                            data-cuelume-tap="select"
                            onClick={() => void selectAvatarHue(option.hue)}
                          >
                            <span class="avatar-color-swatch" style={{ background: avatarHueSwatch(option.hue) }} />
                          </Button>
                        )}
                      </For>
                    </fieldset>
                  </Popover.Content>
                </Popover.Root>
              </div>
              <SaveError field="avatar" />
              <SaveError field="avatarFace" />
              <SaveError field="avatarColor" />
              <SettingsField label={t("agentSettings.name")}>
                <Input
                  value={draft.fields.name}
                  aria-label={t("agentSettings.nameLabel")}
                  maxlength={INPUT_LIMITS.agentName}
                  limitNote={limitNote}
                  invalid={draft.nameMissing}
                  aria-describedby={draft.nameMissing ? "agent-settings-name-missing" : undefined}
                  onValueChange={(value) =>
                    setDraft((state) => {
                      state.fields.name = value;
                      state.dirty.name = true;
                      if (value.trim()) state.nameMissing = false;
                    })
                  }
                  onBlur={saveName}
                />
                <Show when={draft.nameMissing}>
                  <small id="agent-settings-name-missing" class="agent-settings-field-error" role="alert">
                    {t("agentSettings.nameMissing")}
                  </small>
                </Show>
              </SettingsField>
              <SaveError field="name" />
              <SettingsField label={t("agentSettings.agentTitle")}>
                <Input
                  value={draft.fields.title}
                  aria-label={t("agentSettings.agentTitleLabel")}
                  placeholder={t("agentSettings.agentTitlePlaceholder")}
                  maxlength={INPUT_LIMITS.agentTitle}
                  limitNote={limitNote}
                  onValueChange={(value) =>
                    setDraft((state) => {
                      state.fields.title = value;
                      state.dirty.title = true;
                    })
                  }
                  onBlur={saveTitle}
                />
              </SettingsField>
              <SaveError field="title" />
              <SettingsField label={t("agentSettings.instructions")}>
                <Textarea
                  class="settings-instructions-input"
                  rows="5"
                  value={draft.fields.description}
                  aria-label={t("agentSettings.instructionsLabel")}
                  placeholder={t("agentSettings.instructionsPlaceholder")}
                  maxlength={INPUT_LIMITS.agentDescription}
                  limitNote={limitNote}
                  onValueChange={(value) => {
                    setDraft((state) => {
                      state.fields.description = value;
                      state.dirty.description = true;
                    });
                    scheduleInstructionsSave(value);
                  }}
                  onBlur={saveDescription}
                />
              </SettingsField>
              <SaveError field="description" />
              <SettingsLinkGroup inset class="agent-settings-runtime-rows" title={t("agentSettings.groups.brain")}>
                <ProviderModelPicker
                  variant="field"
                  icon={
                    <span class="settings-link-icon">
                      <Cpu aria-hidden="true" />
                    </span>
                  }
                  ariaLabel={t("agentSettings.runtime.model")}
                  provider={draft.runtime.provider}
                  value={draft.runtime.model}
                  agentStatus={props.agentStatus}
                  modelOptions={props.modelOptions}
                  runtimeStatuses={props.providerRuntimeStatuses}
                  customProviders={props.customProviders}
                  customAgents={props.customAgents}
                  onDownloadProvider={props.onDownloadProvider}
                  onCancelProviderDownload={props.onCancelProviderDownload}
                  onConnectProvider={props.onConnectProvider}
                  onAddCustomProvider={props.onAddCustomProvider}
                  disabled={props.working}
                  disabledReason={
                    props.working ? t("agentSettings.runtime.modelBusy") : t("agentSettings.runtime.modelUnavailable")
                  }
                  onChange={(nextModel, provider) => void selectModel(nextModel, provider)}
                />
                <Select<AgentReasoningEffort>
                  class="agent-settings-runtime-select"
                  options={reasoningOptions()}
                  value={draft.runtime.reasoningEffort}
                  disabled={reasoningSetByProvider()}
                  onChange={(nextReasoning) => {
                    if (!nextReasoning || nextReasoning === draft.runtime.reasoningEffort) return;
                    void selectReasoning(nextReasoning);
                  }}
                  itemComponent={(item) => (
                    <SelectItem item={item.item}>{reasoningLabel(item.item.rawValue)}</SelectItem>
                  )}
                >
                  <SelectTrigger
                    class="agent-settings-runtime-row"
                    aria-label={t("agentSettings.runtime.reasoningLabel")}
                  >
                    <span class="settings-link-icon">
                      <Brain aria-hidden="true" />
                    </span>
                    <span class="agent-settings-runtime-label">{t("agentSettings.runtime.reasoning")}</span>
                    <SelectValue<AgentReasoningEffort>>
                      {(state) => {
                        if (reasoningSetByProvider()) {
                          return t("agentSettings.runtime.reasoningSetByProvider", {
                            provider: agentProviderName(draft.runtime.provider),
                          });
                        }
                        const effort = state.selectedOption();
                        return effort ? reasoningLabel(effort) : t("agentSettings.runtime.selectReasoning");
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </SettingsLinkGroup>
              <SaveError field="runtime" />
              {props.links}
              <SettingsLinkGroup inset title={t("agentSettings.groups.rules")}>
                <SettingsLinkRow
                  ref={pageRowRef("permissions")}
                  icon={<ShieldCheck aria-hidden="true" />}
                  label={t("agentSettings.permissions.title")}
                  value={t(ACCESS_LABEL[draft.access])}
                  onClick={() => openPage("permissions")}
                />
                <div class="agent-settings-switch-row">
                  <span class="settings-link-label">
                    <span class="settings-link-icon">
                      <Bell aria-hidden="true" />
                    </span>
                    {t("agentSettings.notifications.title")}
                  </span>
                  <Switch
                    size="sm"
                    aria-label={t("agentSettings.notifications.title")}
                    checked={draft.notifications}
                    onChange={(next) => void saveNotifications(next)}
                  />
                </div>
                <SettingsLinkRow
                  ref={pageRowRef("advanced")}
                  icon={<SlidersHorizontal aria-hidden="true" />}
                  label={t("agentSettings.advanced.title")}
                  onClick={() => openPage("advanced")}
                />
              </SettingsLinkGroup>
              <SaveError field="notifications" />
            </Show>
            <Show when={page() === "permissions"}>
              <Show when={props.accessEditable}>
                <SettingsLinkGroup inset class="agent-settings-runtime-rows">
                  <Select<AgentAccess>
                    class="agent-settings-runtime-select"
                    options={[...AGENT_ACCESS_MODES]}
                    value={draft.access}
                    onChange={(nextAccess) => {
                      if (!nextAccess || nextAccess === draft.access) return;
                      // Widening is the move that needs the warning. Narrowing is never something a
                      // user needs protecting from, so it is written straight away.
                      if (nextAccess === "full") {
                        setDraft((state) => {
                          state.confirmingFullAccess = true;
                        });
                      } else void saveAccess(nextAccess);
                    }}
                    itemComponent={(item) => (
                      <SelectItem item={item.item}>{t(ACCESS_LABEL[item.item.rawValue])}</SelectItem>
                    )}
                  >
                    <SelectTrigger
                      class="agent-settings-runtime-row"
                      aria-label={t("agentSettings.runtime.accessLabel")}
                    >
                      <span class="agent-settings-runtime-label">{t("agentSettings.runtime.access")}</span>
                      <SelectValue<AgentAccess>>
                        {(state) => t(ACCESS_LABEL[state.selectedOption() ?? DEFAULT_AGENT_ACCESS])}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </SettingsLinkGroup>
                <SaveError field="access" />
              </Show>
              <Text as="p" class="agent-settings-runtime-note" variant="caption" tone="muted">
                <Show
                  when={draft.access === "workspace"}
                  fallback={
                    <>
                      {t("agentSettings.runtime.fullAccessNote")}{" "}
                      {draft.runtime.provider === "claude"
                        ? t("agentSettings.runtime.claudeApprovalNote")
                        : t("agentSettings.runtime.providerApprovalNote")}
                    </>
                  }
                >
                  {t("agentSettings.runtime.workspaceNote")} {workspaceEnforcementNote(draft.runtime.provider)}{" "}
                  {t("agentSettings.runtime.workspaceUnlimited")}
                </Show>
              </Text>
              <Show when={props.computerUseEditable}>
                <div class="agent-settings-notifications">
                  <div>
                    <strong>{t("agentSettings.computerUse.title")}</strong>
                    <span>{t("agentSettings.computerUse.description")}</span>
                  </div>
                  <Switch
                    size="sm"
                    aria-label={t("agentSettings.computerUse.title")}
                    checked={draft.computerUse}
                    onChange={(next) => void saveComputerUse(next)}
                  />
                </div>
                <SaveError field="computerUse" />
              </Show>
              <Show when={props.automationEditable}>
                <div class="agent-settings-notifications">
                  <div>
                    <strong>{t("agentSettings.automation.title")}</strong>
                    <span>{t("agentSettings.automation.description")}</span>
                  </div>
                  <Switch
                    size="sm"
                    aria-label={t("agentSettings.automation.title")}
                    checked={draft.allowAutomation}
                    onChange={(next) => void saveAllowAutomation(next)}
                  />
                </div>
                <SaveError field="automation" />
              </Show>
            </Show>
            <Show when={page() === "advanced"}>
              <SettingsLinkGroup inset class="agent-settings-runtime-rows">
                <Show when={props.busyMessageModeEditable}>
                  <Select<BusyMessageChoice>
                    class="agent-settings-runtime-select"
                    options={[...BUSY_MESSAGE_CHOICES]}
                    value={draft.busyMessage}
                    onChange={(next) => {
                      if (!next || next === draft.busyMessage) return;
                      void saveBusyMessage(next);
                    }}
                    itemComponent={(item) => (
                      <SelectItem item={item.item}>{busyMessageLabel(item.item.rawValue)}</SelectItem>
                    )}
                  >
                    <SelectTrigger
                      class="agent-settings-runtime-row"
                      aria-label={t("agentSettings.runtime.busyMessageLabel")}
                    >
                      <span class="agent-settings-runtime-label">{t("agentSettings.runtime.busyMessage")}</span>
                      <SelectValue<BusyMessageChoice>>
                        {(state) => busyMessageLabel(state.selectedOption() ?? "default")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </Show>
                <div class="agent-settings-runtime-path">
                  <span class="agent-settings-runtime-label">{t("agentSettings.runtime.workingDirectory")}</span>
                  <span>
                    {props.agent.workspacePath
                      ? breakablePath(props.agent.workspacePath)
                      : t("agentSettings.runtime.notAvailable")}
                  </span>
                </div>
              </SettingsLinkGroup>
              <SaveError field="busyMessage" />
              <Show when={props.busyMessageModeEditable && steerUnsupported()}>
                <Text as="p" class="agent-settings-runtime-note" variant="caption" tone="muted">
                  {t("agentSettings.busyMessage.steerUnsupported", {
                    provider: agentProviderName(draft.runtime.provider),
                  })}
                </Text>
              </Show>
              <Show when={props.onStartNewChat}>
                <div class="agent-settings-notifications">
                  <div>
                    <strong>{t("agentSettings.newChat.title")}</strong>
                    <span>{t("agentSettings.newChat.description")}</span>
                    <Show when={props.working}>
                      <span id="agent-settings-new-chat-busy" class="agent-settings-disabled-reason">
                        {t("agentSettings.newChat.busy")}
                      </span>
                    </Show>
                  </div>
                  <Button
                    variant="outline"
                    type="button"
                    aria-label={t("agentSettings.newChat.confirm")}
                    aria-haspopup="dialog"
                    aria-describedby={props.working ? "agent-settings-new-chat-busy" : undefined}
                    disabled={props.working}
                    onClick={() => {
                      setNewChatError(null);
                      setNewChatOpen(true);
                    }}
                  >
                    {t("agentSettings.newChat.button")}
                  </Button>
                </div>
              </Show>
            </Show>
            <Show when={draft.saveError?.field === null ? draft.saveError.message : null}>
              {(message) => (
                <p class="agent-settings-save-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          </div>
        </SettingsPanelContent>
        <Show when={props.onStartNewChat}>
          {(start) => (
            <ConfirmDialog
              open={newChatOpen()}
              tone="default"
              initialFocus="cancel"
              media={<AgentAvatar agent={props.agent} style={{ width: "44px", height: "44px" }} />}
              title={t("agentSettings.newChat.confirmTitle", { name: props.agent.name })}
              description={t("agentSettings.newChat.confirmDescription")}
              confirmLabel={t("agentSettings.newChat.confirm")}
              error={newChatError() ?? undefined}
              onCancel={() => setNewChatOpen(false)}
              onConfirm={() => startNewChat(start())}
            />
          )}
        </Show>
        <ConfirmDialog
          open={draft.confirmingFullAccess}
          tone="default"
          initialFocus="cancel"
          title={t("agentSettings.fullAccess.title")}
          description={t("agentSettings.fullAccess.description")}
          cancelLabel={t("agentSettings.fullAccess.cancel")}
          confirmLabel={t("agentSettings.fullAccess.confirm")}
          onCancel={() =>
            setDraft((state) => {
              state.confirmingFullAccess = false;
            })
          }
          onConfirm={() => {
            setDraft((state) => {
              state.confirmingFullAccess = false;
            });
            void saveAccess("full");
          }}
        />
      </Show>
      {props.children}
    </SettingsPanel>
  );
}

/** Lets a long path wrap after a slash instead of inside a folder name. */
function breakablePath(path: string) {
  return path.split("/").map((part, index) =>
    index === 0 ? (
      part
    ) : (
      <>
        /<wbr />
        {part}
      </>
    ),
  );
}

/** True when the panel still shows exactly the settings a save was issued for. */
function sameRuntimeSettings(current: AgentRuntimeSettings, settings: AgentRuntimeSettings): boolean {
  return (
    current.provider === settings.provider &&
    current.model === settings.model &&
    current.reasoningEffort === settings.reasoningEffort
  );
}

const BUSY_MESSAGE_CHOICES = ["default", "queue", "steer"] as const;
type BusyMessageChoice = (typeof BUSY_MESSAGE_CHOICES)[number];

const BUSY_MESSAGE_LABEL = {
  queue: "agentSettings.busyMessage.queue",
  steer: "agentSettings.busyMessage.steer",
} as const satisfies Record<BusyMessageMode, AppTextKey>;

const APP_DEFAULT_BUSY_MESSAGE_LABEL = {
  queue: "agentSettings.busyMessage.appDefaultQueue",
  steer: "agentSettings.busyMessage.appDefaultSteer",
} as const satisfies Record<BusyMessageMode, AppTextKey>;

const ACCESS_LABEL = {
  workspace: "agentSettings.access.workspace",
  full: "agentSettings.access.full",
} as const satisfies Record<AgentAccess, AppTextKey>;
