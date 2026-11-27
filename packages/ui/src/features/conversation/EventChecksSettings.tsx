import type {
  EventCheckPickerOptions,
  EventCheckTemplate,
  EventCheckTemplatePicker,
} from "@openbot/contracts/event-check-templates";
import type {
  EventCheck,
  EventCheckAccount,
  EventCheckApi,
  EventCheckEnvironmentStatus,
  EventCheckExecution,
  EventCheckInput,
  EventCheckSource,
  EventCheckTool,
} from "@openbot/contracts/event-checks";
import { defaultEventCheckSchedule } from "@openbot/contracts/event-checks";
import type { AppTextKey } from "@openbot/i18n";
import {
  Bell,
  Button,
  Check,
  ChevronRight,
  CirclePause,
  ConfirmDialog,
  Input,
  Minus,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  Spinner,
  Switch,
  Text,
  Textarea,
  TriangleAlert,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createStore, For, onCleanup, Show, snapshot, untrack } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { SettingsBackIcon, SettingsForwardIcon } from "../../components/SettingsPanel";
import { useText } from "../../text";
import { createUnsavedGuard, DiscardChangesDialog } from "../settings/unsaved-changes";
import { EventCheckEnvironmentSettings } from "./EventCheckEnvironmentSettings";
import { itemFiltersFromText, itemFiltersToText } from "./event-check-item-filters";
import type { PickerBinding } from "./event-check-picker";
import {
  emptyVariableDraft,
  hasVariableChanges,
  type VariableDraft,
  variableChanges,
  writeVariables,
} from "./event-check-variables";
import { RoutineSchedulePicker } from "./RoutineSchedulePicker";
import type { RoutineScheduleDraft } from "./routine-schedule-draft";
import { ROUTINE_SAVED_DRAFT_KINDS, routineScheduleFromDraft, routineScheduleToDraft } from "./routine-schedule-saved";
import { WatcherProgramFields, type WatcherSettingKind } from "./WatcherProgramFields";

/**
 * What an editor needs from the templates of the host to show a setting as a picker: the templates,
 * to learn which settings are pickers, and the discovery of an installed check. Absent: every
 * setting is a text box.
 */
export interface EventCheckPickerSource {
  list(): Promise<EventCheckTemplate[]>;
  discoverCheck?(input: {
    agentId: string;
    id: string;
    field: string;
    ids?: string[];
    refresh?: boolean;
  }): Promise<EventCheckPickerOptions>;
}
interface Props {
  api: EventCheckApi;
  /** Lets a setting that its template declares as a picker be filled from a list. */
  pickers?: EventCheckPickerSource | undefined;
  apiProgramsAvailable?: boolean;
  /** Whether the host keeps the delivery setting. Defaults to what the API says, then to yes. */
  deliveryAvailable?: boolean;
  agentId: string;
  onBack(): void;
  onClose(): void;
  onCountChange(count: number): void;
  /** Called when the editor gains or loses changes that were not saved, so the owner can keep it open. */
  onUnsavedChange?(unsaved: boolean): void;
  /**
   * Ask the browser to confirm when the tab or window closes with unsaved changes. A web page sets
   * it; a desktop window closes without a prompt.
   */
  warnOnPageClose?: boolean | undefined;
}
interface Editor {
  value: EventCheckInput;
  timing: "interval" | "calendar";
  seconds: number;
  /** What the person typed in the interval box. It can be empty, which `seconds` cannot say. */
  secondsText: string;
  calendar: RoutineScheduleDraft;
  /** Seconds to combine events into one message. Zero delivers each find at once. */
  digestSeconds: number;
  filtersText: string;
}
interface State {
  checks: EventCheck[];
  accounts: EventCheckAccount[];
  tools: EventCheckTool[];
  current: Editor | null;
  history: EventCheckExecution[];
  historyOpen: boolean;
  confirmDelete: boolean;
  busy: boolean;
  error: string;
  /** The list of checks is being read: when the panel opens, for another agent, or after Retry. */
  loading: boolean;
  /** Why the list could not be read. Empty when it could. */
  loadError: string;
  /** The picker settings of the open check, with what is missing before its list can load. */
  pickers: Record<string, EventCheckTemplatePicker>;
  /** What the template of the open check says about its settings, by name. */
  fields: Record<string, WatcherSettingKind>;
  /** The private variables that the template of the open check declares, or null while that is not known. */
  templateVariables: { name: string; label: string }[] | null;
  /** The status of the private variables of the open check, or null while that is not known. */
  environment: EventCheckEnvironmentStatus[] | null;
  /** The values typed in the private variable fields and the removals. Saved with the check. */
  variables: VariableDraft;
  /** The fields that the person has reached, so an empty one says it is required only then. */
  touched: { name: boolean; program: boolean; instruction: boolean };
  /** A save worked and nothing was edited since: it is announced as "Saved". */
  saved: boolean;
  /** Save is writing the check and its private values: the masked fields are off until it ends. */
  saving: boolean;
}
/** The list answer carries `health`. It is not part of what the user edits or saves. */
function withoutHealth(check: EventCheck): EventCheck {
  const { health: _health, ...rest } = check;
  return rest;
}
/**
 * What the person can edit in a check, as text. The host sets the revision, the times, the author and
 * the program digest by itself, so a change of those is not an edit.
 */
function editableJson(
  value: EventCheckInput & Partial<Pick<EventCheck, "revision" | "nextCheckAt" | "createdAt" | "updatedAt" | "health">>,
): string {
  const {
    health: _health,
    revision: _revision,
    nextCheckAt: _next,
    createdAt: _created,
    updatedAt: _updated,
    lastSavedBy: _author,
    ...rest
  } = value;
  if (rest.source.kind !== "api") return JSON.stringify(rest);
  // The names of picked choices are display text: a rename alone is not an edit to save.
  const { programDigest: _digest, configuration, ...source } = rest.source;
  return JSON.stringify({
    ...rest,
    source: { ...source, configuration: configuration.map(({ optionLabels: _names, ...field }) => field) },
  });
}
const DIGEST_CHOICES = [0, 60, 300, 900, 3600] as const;
function apiSource(source: EventCheckSource) {
  return source.kind === "api" ? source : undefined;
}
/** The marketplace template a check was installed from, when it has one. */
function templateLink(source: EventCheckSource) {
  return source.kind === "api" ? source.template : undefined;
}
function defaultSource(api: boolean): EventCheckSource {
  const common = { toolName: "", argumentsJson: "{}", cursorArgument: "cursor", nextCursorPointer: "/cursor" };
  return api
    ? { ...common, kind: "api", connectionId: "API account", variables: [], configuration: [] }
    : { ...common, kind: "mcp", connectionId: "" };
}
const MIN_INTERVAL_SECONDS = 30;
/** The shortest and the longest interval that the editor offers. A saved interval beyond it stays valid. */
const MAX_INTERVAL_SECONDS = 86_400;
const MAX_SAVED_INTERVAL_SECONDS = 8_640_000_000;
function intervalValid(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds >= MIN_INTERVAL_SECONDS && seconds <= MAX_SAVED_INTERVAL_SECONDS;
}
function editor(agentId: string, check?: EventCheck, api = false): Editor {
  const schedule = check?.schedule ?? defaultEventCheckSchedule();
  const seconds =
    schedule.kind === "interval"
      ? schedule.amount *
        (schedule.unit === "seconds" ? 1 : schedule.unit === "minutes" ? 60 : schedule.unit === "hours" ? 3600 : 86400)
      : 30;
  return {
    value: check
      ? structuredClone(snapshot(withoutHealth(check)))
      : {
          agentId,
          name: "",
          instruction: "",
          active: !api,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          schedule,
          selfEvents: { mode: "exclude", connectionId: "", actorPointer: "", accountActorIds: [] },
          source: defaultSource(api),
          selection: { itemsPointer: api ? "/items" : "", idPointer: "/id", revisionPointer: api ? "/revision" : "" },
        },
    timing: schedule.kind === "interval" ? "interval" : "calendar",
    seconds,
    secondsText: String(seconds),
    calendar: routineScheduleToDraft(schedule.kind === "interval" ? { kind: "daily", time: "09:00" } : schedule),
    digestSeconds: check?.delivery?.digestSeconds ?? 0,
    filtersText: itemFiltersToText(check?.delivery?.itemFilters ?? []),
  };
}
const STATUS_KEYS = {
  baseline: "agentSettings.eventCheck.baseline",
  unchanged: "agentSettings.eventCheck.unchanged",
  triggered: "agentSettings.eventCheck.triggered",
  error: "agentSettings.eventCheck.error",
  cancelled: "agentSettings.eventCheck.cancelled",
} as const satisfies Record<EventCheckExecution["status"], AppTextKey>;
function Choice(props: {
  id: string;
  label: string;
  value: string;
  options: { id: string; name: string }[];
  change(value: string): void;
  /** A note under the label, such as what the chosen tool does. */
  help?: JSX.Element;
}) {
  return (
    <SettingsRow label={<span id={props.id}>{props.label}</span>} help={props.help}>
      <Select<string>
        placeholder={props.label}
        options={props.options.map((item) => item.id)}
        value={props.value || undefined}
        onChange={(value) => {
          if (value) props.change(value);
        }}
        itemComponent={(item) => (
          <SelectItem item={item.item}>
            {props.options.find((choice) => choice.id === item.item.rawValue)?.name}
          </SelectItem>
        )}
      >
        <SelectTrigger aria-labelledby={props.id}>
          <SelectValue<string>>
            {(state) => props.options.find((choice) => choice.id === state.selectedOption())?.name ?? props.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    </SettingsRow>
  );
}
function RunStatus(props: { status: EventCheckExecution["status"] }) {
  const { t } = useText();
  return (
    <span class={`event-check-run-status event-check-run-status-${props.status}`}>
      <Show when={props.status === "triggered"}>
        <Bell aria-hidden="true" />
      </Show>
      <Show when={props.status === "baseline"}>
        <Check aria-hidden="true" />
      </Show>
      <Show when={props.status === "unchanged"}>
        <Minus aria-hidden="true" />
      </Show>
      <Show when={props.status === "error"}>
        <TriangleAlert aria-hidden="true" />
      </Show>
      <Show when={props.status === "cancelled"}>
        <X aria-hidden="true" />
      </Show>
      {t(STATUS_KEYS[props.status])}
    </span>
  );
}
/** Shared controls only; the host adapter owns authentication, storage and scheduling. */
export function EventChecksSettings(props: Props) {
  const { t, errorMessage, format, sourceText } = useText();
  const [state, setState] = createStore<State>({
    checks: [],
    accounts: [],
    tools: [],
    current: null,
    history: [],
    historyOpen: false,
    confirmDelete: false,
    busy: false,
    error: "",
    loading: true,
    loadError: "",
    pickers: {},
    fields: {},
    templateVariables: null,
    environment: null,
    variables: emptyVariableDraft(),
    touched: { name: false, program: false, instruction: false },
    saved: false,
    saving: false,
  });
  /**
   * The agent whose checks the panel shows. It follows `props.agentId`, except while the person still
   * edits a check of the agent they left: that editor keeps its own agent until they decide. It is
   * not state: each reader is an action that needs the value now, not after the next flush.
   */
  let shownAgent = untrack(() => props.agentId);
  const scrollFades = createScrollFades();
  onCleanup(() => {
    scrollFades.stop();
    // The typed values live only here. They are gone when the panel closes.
    setState((draft) => {
      draft.variables = emptyVariableDraft();
    });
    props.onUnsavedChange?.(false);
  });
  createEffect(
    () => [state.current?.value.id, state.checks.length, state.history.length, state.historyOpen, state.error] as const,
    () => {
      scrollFades.remeasure();
    },
  );
  let epoch = 0;
  const fail = (error: unknown, fallback: string) =>
    setState((draft) => {
      draft.error = errorMessage(error, fallback);
    });
  const time = (value: string) => format.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });
  const deliveryAvailable = () => props.deliveryAvailable ?? props.api.deliverySettings ?? true;
  const apiPrograms = () => props.apiProgramsAvailable ?? Boolean(props.api.environment);
  const digestName = (seconds: number) =>
    seconds === 0
      ? t("agentSettings.eventCheck.digestOff")
      : seconds >= 3600
        ? t("agentSettings.eventCheck.digestHours", { count: seconds / 3600 })
        : t("agentSettings.eventCheck.digestMinutes", { count: seconds / 60 });
  /** The lists that pickers loaded, by check and setting. A remounted field starts from its list. */
  const loadedLists = new Map<string, EventCheckPickerOptions>();
  const listKey = (checkId: string, field: string) => `${checkId}:${field}`;
  async function reload(agentId = shownAgent) {
    const requested = ++epoch;
    try {
      const checks = await props.api.list({ agentId });
      if (requested !== epoch) return;
      setState((draft) => {
        draft.checks = checks;
        draft.loading = false;
        draft.loadError = "";
      });
      // The count belongs to the agent of the panel, not to the one an unsaved editor still holds.
      if (agentId === props.agentId) props.onCountChange(checks.length);
      return checks;
    } catch (error) {
      if (requested !== epoch) return;
      const message = errorMessage(error, t("agentSettings.eventCheck.loadFailed"));
      setState((draft) => {
        // Without a list to show, the list view says so and offers Retry. With one, a banner is enough.
        if (draft.loading) {
          draft.loadError = message;
          if (draft.current) draft.error = message;
        } else draft.error = message;
        draft.loading = false;
      });
    }
  }
  function retryLoad() {
    setState((draft) => {
      draft.loading = true;
      draft.loadError = "";
      draft.error = "";
    });
    void reload();
  }
  function readAccounts(agentId: string) {
    void props.api
      .accounts({ agentId })
      .then((accounts) => {
        if (agentId !== shownAgent) return;
        setState((draft) => {
          draft.accounts = accounts;
        });
      })
      .catch((error) => fail(error, t("agentSettings.eventCheck.accountsFailed")));
  }
  /** Starts over for another agent: its list, its accounts, and no open editor. */
  function startAgent(agentId: string) {
    loadedLists.clear();
    shownAgent = agentId;
    setState((draft) => {
      draft.current = null;
      draft.error = "";
      draft.checks = [];
      draft.accounts = [];
      draft.loading = true;
      draft.loadError = "";
      draft.variables = emptyVariableDraft();
      draft.saved = false;
    });
    void reload(agentId);
    readAccounts(agentId);
  }
  // The templates are read once for this panel, and only for a check that came from one.
  let templatesRead: Promise<EventCheckTemplate[]> | null = null;
  /**
   * Reads what the template of a check says about its settings: which one is a switch, which one a
   * list, which one is optional, and what the private variables are called.
   */
  async function loadTemplateSettings(check: EventCheck) {
    const link = check.source.kind === "api" ? check.source.template : undefined;
    const source = props.pickers;
    if (!source || !link || check.source.kind !== "api") return;
    try {
      templatesRead ??= source.list();
      const template = (await templatesRead).find((entry) => entry.slug === link.slug);
      if (!template || state.current?.value.id !== check.id) return;
      const configured = new Set(check.source.configuration.map((field) => field.name));
      // The kind of a setting follows its name, whichever version made the check. Only the version
      // that the template ships has a program that can list the choices of a picker.
      const shipped = template.version === link.version;
      const fields: Record<string, WatcherSettingKind> = {};
      const pickers: Record<string, EventCheckTemplatePicker> = {};
      for (const field of template.configuration) {
        if (!configured.has(field.name)) continue;
        fields[field.name] = { type: field.type, required: field.required };
        if (shipped && field.picker && source.discoverCheck) pickers[field.name] = field.picker;
      }
      setState((draft) => {
        draft.fields = fields;
        draft.templateVariables = template.variables.map((variable) => ({
          name: variable.name,
          label: variable.label,
        }));
      });
      if (Object.keys(pickers).length === 0) return;
      const status = props.api.environment ? await props.api.environment({ agentId: check.agentId, id: check.id }) : [];
      if (state.current?.value.id !== check.id) return;
      setState((draft) => {
        draft.pickers = pickers;
        draft.environment = status;
      });
    } catch {
      // The settings stay as they are. Nothing here is needed to edit the check.
      templatesRead = null;
    }
  }
  /** The editor of a new check as it opened. A new check with no edit has nothing to lose. */
  let newBaseline = "";
  async function open(check?: EventCheck) {
    const next = editor(shownAgent, check, apiPrograms());
    newBaseline = check ? "" : JSON.stringify(next);
    setState((draft) => {
      draft.current = next;
      draft.historyOpen = false;
      draft.history = [];
      draft.tools = [];
      draft.confirmDelete = false;
      draft.error = "";
      draft.pickers = {};
      draft.fields = {};
      draft.templateVariables = null;
      draft.environment = null;
      draft.variables = emptyVariableDraft();
      draft.touched = { name: false, program: false, instruction: false };
      draft.saved = false;
    });
    if (check?.id) void loadTemplateSettings(check);
    // A store write is visible only after the next flush, so the new editor, not the store, names the account.
    if (next.value.source.kind === "mcp" && next.value.source.connectionId)
      await loadTools(next.value.source.connectionId);
  }
  function closeEditor() {
    setState((draft) => {
      draft.current = null;
      draft.error = "";
      draft.variables = emptyVariableDraft();
      draft.saved = false;
    });
    // The person left the agent while the editor was open and chose to keep editing: now they follow.
    if (props.agentId !== shownAgent) startAgent(props.agentId);
  }
  async function loadTools(connectionId: string) {
    try {
      const tools = await props.api.tools({ agentId: shownAgent, connectionId });
      if (state.current?.value.source.connectionId === connectionId)
        setState((draft) => {
          draft.tools = tools;
        });
    } catch (error) {
      fail(error, t("agentSettings.eventCheck.toolsFailed"));
    }
  }
  async function action(run: () => Promise<unknown>, failure: string) {
    setState((draft) => {
      draft.busy = true;
      draft.error = "";
    });
    try {
      await run();
      await reload();
    } catch (error) {
      fail(error, failure);
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }
  async function save() {
    const current = state.current;
    if (!current || state.busy) return;
    const schedule =
      current.timing === "interval"
        ? {
            kind: "interval" as const,
            amount: current.seconds,
            unit: "seconds" as const,
            anchorAt:
              current.value.schedule.kind === "interval" ? current.value.schedule.anchorAt : new Date().toISOString(),
          }
        : routineScheduleFromDraft(current.calendar);
    const filters = itemFiltersFromText(current.filtersText);
    if (!filters) {
      setState((draft) => {
        draft.error = t("agentSettings.eventCheck.filtersInvalid");
      });
      return;
    }
    // A check that never had delivery settings keeps none until the user sets one. A host that does
    // not know the setting is not sent one.
    const delivery =
      deliveryAvailable() && (current.digestSeconds > 0 || filters.length > 0 || current.value.delivery)
        ? { delivery: { digestSeconds: current.digestSeconds, itemFilters: filters } }
        : {};
    const agentId = shownAgent;
    const declared = current.value.source.kind === "api" ? current.value.source.variables : [];
    const changes = variableChanges(snapshot(state.variables), declared);
    const checkChanged = checkDirty();
    setState((draft) => {
      draft.busy = true;
      draft.saving = true;
      draft.error = "";
      draft.saved = false;
    });
    try {
      // The check first: a private value is written to the saved check, so it must exist and be current.
      let checkId = current.value.id;
      if (checkChanged) {
        const check = await props.api.save({ ...snapshot(current.value), schedule, ...delivery });
        checkId = check.id;
        setState((draft) => {
          draft.current = editor(agentId, check, apiPrograms());
        });
      }
      let failure: { name: string; error: unknown } | undefined;
      if (changes.length > 0 && checkId) {
        // A failure stops the run. The value that failed and the ones after it stay typed.
        const outcome = await writeVariables(props.api, { agentId, id: checkId }, changes, (change, variables) =>
          setState((draft) => {
            draft.variables.values[change.name] = "";
            draft.variables.removed[change.name] = false;
            draft.environment = variables;
          }),
        );
        failure = outcome.failed;
      }
      const checks = await reload(agentId);
      const updated = checks?.find((entry) => entry.id === checkId);
      if (updated && state.current?.value.id === checkId)
        setState((draft) => {
          draft.current = editor(agentId, updated, apiPrograms());
        });
      if (failure) {
        const name = failure.name;
        const reason = errorMessage(failure.error, t("agentSettings.eventCheck.failed"));
        setState((draft) => {
          draft.error = t("agentSettings.eventCheck.variableFailed", {
            name: variableLabels()[name] ?? name,
            reason,
          });
        });
      } else if (checks) {
        setState((draft) => {
          draft.saved = true;
        });
        // The Save button is gone, and focus with it: it moves to the editor, not to the page.
        queueMicrotask(() => {
          if (!document.activeElement || document.activeElement === document.body) editorRoot?.focus();
        });
      }
    } catch (error) {
      fail(error, t("agentSettings.eventCheck.saveFailed"));
    } finally {
      setState((draft) => {
        draft.busy = false;
        draft.saving = false;
      });
    }
  }
  /** Puts the editor back to the saved check, and drops the typed private values and removals. */
  function reset() {
    const current = state.current;
    if (!current || state.busy) return;
    const saved = savedCheck();
    if (current.value.id && !saved) return;
    const next = editor(shownAgent, current.value.id ? saved : undefined, apiPrograms());
    if (!current.value.id) newBaseline = JSON.stringify(next);
    setState((draft) => {
      draft.current = next;
      draft.variables = emptyVariableDraft();
      draft.touched = { name: false, program: false, instruction: false };
      draft.error = "";
      draft.saved = false;
    });
  }
  async function history() {
    const id = state.current?.value.id;
    if (!id) return;
    try {
      const runs = await props.api.history({ agentId: shownAgent, id });
      setState((draft) => {
        draft.history = runs;
        draft.historyOpen = true;
      });
    } catch (error) {
      fail(error, t("agentSettings.eventCheck.historyFailed"));
    }
  }
  /**
   * A private value or an approval was saved. The host pauses the check and approves its program,
   * so the saved check changed. An editor with no unsaved edit takes the saved check over; the
   * history, the tools and the lists of the pickers stay. An editor with an edit keeps the draft.
   */
  async function variablesChanged(id: string) {
    const clean = state.current?.value.id === id && !checkDirty();
    const before = clean ? JSON.stringify(snapshot(state.current)) : "";
    const checks = await reload();
    const updated = checks?.find((entry) => entry.id === id);
    if (!updated || state.current?.value.id !== id) return;
    if (clean && JSON.stringify(snapshot(state.current)) === before)
      setState((draft) => {
        draft.current = editor(shownAgent, updated, apiPrograms());
      });
  }
  /** The check differs from the saved one. The private values are not part of it. */
  const checkDirty = () => {
    const current = state.current;
    if (!current) return false;
    // A new check has no saved one: it is unsaved once it differs from the blank form that opened.
    // The store is read directly, not through `snapshot`: only a read here is tracked.
    if (!current.value.id) return JSON.stringify(current) !== newBaseline;
    const saved = state.checks.find((check) => check.id === current.value.id);
    if (!saved || editableJson(current.value) !== editableJson(saved)) return true;
    if (
      current.digestSeconds !== (saved.delivery?.digestSeconds ?? 0) ||
      current.filtersText.trim() !== itemFiltersToText(saved.delivery?.itemFilters ?? [])
    )
      return true;
    if (current.timing === "interval")
      return saved.schedule.kind !== "interval" || current.seconds !== editor(shownAgent, saved).seconds;
    return (
      saved.schedule.kind === "interval" ||
      JSON.stringify(current.calendar) !== JSON.stringify(routineScheduleToDraft(saved.schedule))
    );
  };
  /** Anything the person typed or changed and Save has not written: the check, a value, or a removal. */
  const unsaved = () => checkDirty() || hasVariableChanges(state.variables);
  const guard = createUnsavedGuard({
    dirty: unsaved,
    warnOnPageClose: () => props.warnOnPageClose === true,
  });
  createEffect(
    () => unsaved(),
    (value) => {
      props.onUnsavedChange?.(value);
    },
  );
  createEffect(
    () => [props.api, props.agentId] as const,
    ([, agentId]) => {
      if (agentId !== shownAgent) {
        // Another agent starts over. An editor with unsaved changes asks first: the person may have
        // changed agent by accident, and what they typed, private values included, would be lost.
        // Keep editing leaves the editor on the agent it was opened for.
        if (state.current !== null && unsaved())
          guard.request(() => {
            startAgent(props.agentId);
            props.onBack();
          });
        else startAgent(agentId);
        return;
      }
      // The same agent with another api object only reads the lists again: the check that is open
      // and its unsaved edits stay.
      void reload(agentId);
      readAccounts(agentId);
    },
  );
  /** Each picker setting of the open check, with the call that reads its list from the saved check. */
  const pickerBindings = (): Record<string, PickerBinding> => {
    const discover = props.pickers?.discoverCheck;
    const id = state.current?.value.id;
    const missing = missingVariables();
    if (!discover || !id) return {};
    return Object.fromEntries(
      Object.entries(state.pickers).map(([field, picker]) => [
        field,
        {
          picker,
          load: (options?: { refresh?: boolean }) =>
            discover({ agentId: shownAgent, id, field, ...(options?.refresh ? { refresh: true } : {}) }),
          // The list opens with the editor when every private value is saved and approved. The host
          // answers from its memory when it has a current list, so opening a check is not a request.
          autoLoad: missing !== null && missing.length === 0,
          // Names for saved choices that have none, from the saved check's own private value.
          resolve: (ids: string[]) => discover({ agentId: shownAgent, id, field, ids }),
          blocked:
            missing === null
              ? undefined
              : missing.length > 0
                ? t("agentSettings.eventCheck.picker.needSaved", { name: missing.join(", ") })
                : undefined,
          initial: loadedLists.get(listKey(id, field)),
          onLoaded: (options: EventCheckPickerOptions) => {
            loadedLists.set(listKey(id, field), options);
          },
        },
      ]),
    );
  };
  /** The labels of the private variables that are not set yet, or null while that is not known. */
  const missingVariables = (): string[] | null => {
    const declared = state.templateVariables;
    const status = state.environment;
    if (declared === null || status === null) return null;
    const ready = new Set(status.filter((entry) => entry.configured && !entry.reapprove).map((entry) => entry.name));
    return declared.filter((variable) => !ready.has(variable.name)).map((variable) => variable.label);
  };
  const variableLabels = () =>
    Object.fromEntries((state.templateVariables ?? []).map((variable) => [variable.name, variable.label]));
  const sourceChange = (key: "argumentsJson" | "cursorArgument" | "nextCursorPointer", value: string) =>
    setState((draft) => {
      if (draft.current) draft.current.value.source[key] = value;
    });
  const selectionChange = (key: "itemsPointer" | "idPointer" | "revisionPointer", value: string) =>
    setState((draft) => {
      if (draft.current) draft.current.value.selection[key] = value;
    });
  const setTiming = (timing: Editor["timing"]) =>
    setState((draft) => {
      if (draft.current) draft.current.timing = timing;
    });
  /** The saved check that the open editor edits, with its health. Absent for a check that is not saved yet. */
  const savedCheck = () => state.checks.find((check) => check.id === state.current?.value.id);
  const touch = (field: keyof State["touched"]) =>
    setState((draft) => {
      draft.touched[field] = true;
    });
  /** An empty required field says so once the person has reached it. */
  const fieldError = (field: keyof State["touched"], value: string) =>
    state.touched[field] && !value.trim() ? t("agentSettings.eventCheck.required") : undefined;
  const setVariable = (name: string, value: string) =>
    setState((draft) => {
      draft.variables.values[name] = value;
      draft.saved = false;
    });
  const removeVariable = (name: string, remove: boolean) =>
    setState((draft) => {
      draft.variables.removed[name] = remove;
      // A value that is marked for removal is not also a new value.
      if (remove) draft.variables.values[name] = "";
      draft.saved = false;
    });
  const failing = () => {
    const health = savedCheck()?.health;
    return health && health.consecutiveErrors > 0 ? health : undefined;
  };
  /** The settings that Save needs and that are empty, named as the form names them. */
  const missingForSave = () => {
    const current = state.current;
    if (!current) return [];
    const missing: string[] = [];
    if (!current.value.name.trim()) missing.push(t("agentSettings.eventCheck.name"));
    if (!current.value.source.toolName)
      missing.push(
        current.value.source.kind === "api"
          ? t("agentSettings.eventCheck.program")
          : t("agentSettings.eventCheck.read"),
      );
    if (!current.value.instruction.trim()) missing.push(t("agentSettings.eventCheck.instruction"));
    return missing;
  };
  /** The interval, in seconds, that the saved check has: a longer one than the editor offers stays valid. */
  const savedIntervalSeconds = () => {
    const saved = savedCheck();
    return saved ? editor(shownAgent, saved).seconds : 0;
  };
  const intervalProblem = () => state.current?.timing === "interval" && !intervalValid(state.current.seconds);
  /** Why Check now is off, or null when it is on. */
  const checkNowReason = () =>
    unsaved()
      ? t("agentSettings.eventCheck.runNeedsSave")
      : state.current?.value.active
        ? null
        : t("agentSettings.eventCheck.runNeedsActive");
  const testReason = () => (unsaved() ? t("agentSettings.eventCheck.runNeedsSave") : null);
  const saveReason = () => {
    const missing = missingForSave();
    return missing.length > 0 ? t("agentSettings.eventCheck.saveNeeds", { fields: format.list(missing) }) : null;
  };
  let editorRoot: HTMLDivElement | undefined;
  return (
    <section class="agent-routines-settings event-check-settings" aria-label={t("agentSettings.eventCheck.title")}>
      <header class="settings-panel-header agent-routines-header">
        <Button
          variant="ghost"
          type="button"
          class="settings-panel-nav-button"
          aria-label={state.current ? t("agentSettings.eventCheck.all") : t("agentSettings.backToSettings")}
          disabled={state.busy && Boolean(state.current)}
          onClick={() => (state.current ? guard.request(closeEditor) : props.onBack())}
        >
          <SettingsBackIcon />
        </Button>
        <div class="agent-routines-heading">
          <h2 aria-describedby={failing() ? "event-check-failing-reason" : undefined}>
            {state.current
              ? state.current.value.id
                ? t("agentSettings.eventCheck.check")
                : t("agentSettings.eventCheck.newCheck")
              : t("agentSettings.eventCheck.title")}
          </h2>
        </div>
        <Show
          when={!state.current}
          fallback={
            <Button
              variant="ghost"
              type="button"
              class="settings-panel-nav-button"
              aria-label={t("common.close")}
              disabled={state.busy}
              onClick={() => guard.request(props.onClose)}
            >
              <SettingsForwardIcon />
            </Button>
          }
        >
          <Button
            variant="ghost"
            type="button"
            class="settings-panel-nav-button"
            aria-label={t("agentSettings.eventCheck.add")}
            onClick={() => void open()}
          >
            <Plus aria-hidden="true" />
          </Button>
        </Show>
      </header>
      <div ref={scrollFades.bind} class={["agent-routines-body", scrollFades.classes()]} onScroll={scrollFades.measure}>
        <Show
          when={state.current}
          fallback={
            <div class="event-check-list-view settings-panel-page">
              <SettingsHelp class="event-check-intro">{t("agentSettings.eventCheck.description")}</SettingsHelp>
              <Show
                when={!state.loading}
                fallback={
                  <div class="event-check-empty" role="status">
                    <Spinner size="sm" />
                    <p class="agent-routines-empty">{t("agentSettings.eventCheck.loading")}</p>
                  </div>
                }
              >
                <Show
                  when={!state.loadError}
                  fallback={
                    <div class="event-check-empty">
                      <p class="agent-settings-save-error" role="alert">
                        {state.loadError}
                      </p>
                      <Button type="button" size="sm" variant="secondary" onClick={retryLoad}>
                        {t("common.retry")}
                      </Button>
                    </div>
                  }
                >
                  <Show
                    when={state.checks.length}
                    fallback={
                      <div class="event-check-empty">
                        <p class="agent-routines-empty">{t("agentSettings.eventCheck.empty")}</p>
                        <Button type="button" size="sm" onClick={() => void open()}>
                          <Plus aria-hidden="true" />
                          {t("agentSettings.eventCheck.add")}
                        </Button>
                      </div>
                    }
                  >
                    <SettingsGroup label={t("agentSettings.eventCheck.title")}>
                      <For each={state.checks}>
                        {(check) => (
                          <div class="event-check-row">
                            <Button
                              variant="ghost"
                              type="button"
                              class="agent-routine-row"
                              aria-labelledby={`event-check-${check.id}-name`}
                              aria-describedby={`event-check-${check.id}-summary`}
                              onClick={() => void open(check)}
                            >
                              <span
                                class={
                                  check.active ? "agent-routine-status-icon-active" : "agent-routine-status-icon-paused"
                                }
                              >
                                <Show when={check.active} fallback={<CirclePause aria-hidden="true" />}>
                                  <Bell aria-hidden="true" />
                                </Show>
                              </span>
                              <span>
                                <strong id={`event-check-${check.id}-name`}>{check.name}</strong>
                                <small id={`event-check-${check.id}-summary`}>
                                  {check.active
                                    ? t("agentSettings.eventCheck.next", { time: time(check.nextCheckAt) })
                                    : t("agentSettings.eventCheck.paused")}
                                  <Show when={templateLink(check.source)}>
                                    {(link) => (
                                      <>
                                        {" · "}
                                        {t("agentSettings.eventCheck.fromTemplate", {
                                          name: link().slug,
                                          version: link().version,
                                        })}
                                      </>
                                    )}
                                  </Show>
                                  <Show when={(check.health?.consecutiveErrors ?? 0) > 0}>
                                    {" · "}
                                    <span class="event-check-failing" title={sourceText(check.health?.lastError ?? "")}>
                                      <TriangleAlert aria-hidden="true" />
                                      {t("agentSettings.eventCheck.failing")}
                                    </span>
                                  </Show>
                                </small>
                              </span>
                            </Button>
                            <Switch
                              checked={check.active}
                              aria-label={t("agentSettings.eventCheck.activeName", { name: check.name })}
                              onChange={(active) =>
                                void action(
                                  () => props.api.save({ ...snapshot(check), active }),
                                  t("agentSettings.eventCheck.toggleFailed"),
                                )
                              }
                              disabled={state.busy}
                            />
                          </div>
                        )}
                      </For>
                    </SettingsGroup>
                  </Show>
                </Show>
              </Show>
            </div>
          }
        >
          {(current) => (
            <div
              ref={(element) => (editorRoot = element)}
              tabindex="-1"
              class="agent-routine-editor event-check-editor settings-panel-page"
            >
              <Show when={failing()}>
                {(health) => (
                  <Text
                    as="p"
                    variant="caption"
                    id="event-check-failing-reason"
                    class="event-check-help event-check-failing"
                  >
                    <TriangleAlert aria-hidden="true" />
                    {t("agentSettings.eventCheck.failingReason", {
                      count: health().consecutiveErrors,
                      reason: sourceText(health().lastError ?? ""),
                    })}
                  </Text>
                )}
              </Show>
              <SettingsGroup label={t("agentSettings.eventCheck.check")}>
                <SettingsRow
                  layout="inline"
                  controlId="event-check-active"
                  label={t("agentSettings.eventCheck.active")}
                  description={current().value.active ? undefined : t("agentSettings.eventCheck.paused")}
                >
                  <Switch
                    id="event-check-active"
                    aria-label={t("agentSettings.eventCheck.active")}
                    checked={current().value.active}
                    onChange={(active) =>
                      setState((s) => {
                        if (s.current) s.current.value.active = active;
                      })
                    }
                  />
                </SettingsRow>
                <SettingsRow
                  layout="stack"
                  controlId="event-check-name"
                  label={
                    <>
                      {t("agentSettings.eventCheck.name")}
                      <span class="ui-field-required" aria-hidden="true">
                        *
                      </span>
                    </>
                  }
                  help={
                    fieldError("name", current().value.name) ? (
                      <span class="event-check-field-error">{fieldError("name", current().value.name)}</span>
                    ) : undefined
                  }
                >
                  <Input
                    id="event-check-name"
                    aria-required="true"
                    invalid={Boolean(fieldError("name", current().value.name))}
                    value={current().value.name}
                    maxlength={256}
                    onInput={(e) =>
                      setState((s) => {
                        if (s.current) s.current.value.name = e.currentTarget.value;
                        s.touched.name = true;
                        s.saved = false;
                      })
                    }
                    onBlur={() => touch("name")}
                  />
                </SettingsRow>
              </SettingsGroup>
              <Show when={templateLink(current().value.source)}>
                {(link) => (
                  <SettingsHelp>
                    {t("agentSettings.eventCheck.fromTemplate", { name: link().slug, version: link().version })}
                  </SettingsHelp>
                )}
              </Show>
              <SettingsGroup title={t("agentSettings.eventCheck.source")}>
                <Show when={current().value.source.kind === "mcp"}>
                  <Choice
                    id="event-check-account-label"
                    label={t("agentSettings.eventCheck.account")}
                    options={state.accounts}
                    value={current().value.source.connectionId}
                    help={state.accounts.length ? undefined : t("agentSettings.eventCheck.noAccounts")}
                    change={(id) => {
                      setState((s) => {
                        if (s.current) {
                          s.current.value.source.connectionId = id;
                          s.current.value.source.toolName = "";
                          s.current.value.selfEvents = {
                            mode: "exclude",
                            connectionId: id,
                            actorPointer: "",
                            accountActorIds: [],
                          };
                        }
                      });
                      void loadTools(id);
                    }}
                  />
                  <Choice
                    id="event-check-tool-label"
                    label={t("agentSettings.eventCheck.read")}
                    value={current().value.source.toolName}
                    options={state.tools.map((tool) => ({ id: tool.name, name: tool.name }))}
                    help={state.tools.find((tool) => tool.name === current().value.source.toolName)?.description}
                    change={(name) =>
                      setState((s) => {
                        if (s.current) s.current.value.source.toolName = name;
                      })
                    }
                  />
                </Show>
                <Show when={apiSource(current().value.source)}>
                  {(source) => (
                    <WatcherProgramFields
                      pickers={pickerBindings()}
                      fields={state.fields}
                      source={source()}
                      programError={fieldError("program", source().toolName)}
                      onProgramBlur={() => touch("program")}
                      change={(value) =>
                        setState((draft) => {
                          if (draft.current) draft.current.value.source = value;
                        })
                      }
                    />
                  )}
                </Show>
              </SettingsGroup>
              <Show when={current().value.source.kind === "api"}>
                <Show
                  when={state.checks.find((check) => check.id === current().value.id && check.source.kind === "api")}
                  fallback={<SettingsHelp>{t("agentSettings.eventCheck.saveBeforeVariables")}</SettingsHelp>}
                >
                  {/* Not keyed on the check: a new revision of it must not drop the values that were typed. */}
                  {(check) => (
                    <EventCheckEnvironmentSettings
                      api={props.api}
                      check={check()}
                      labels={variableLabels()}
                      values={state.variables.values}
                      removed={state.variables.removed}
                      busy={state.saving}
                      saveAction={t("common.save")}
                      approveBlocked={checkDirty()}
                      onValue={setVariable}
                      onRemove={removeVariable}
                      onStatus={(status) => {
                        if (state.current?.value.id === check().id)
                          setState((draft) => {
                            draft.environment = status;
                          });
                      }}
                      changed={() => variablesChanged(check().id)}
                    />
                  )}
                </Show>
              </Show>
              <SettingsGroup label={t("agentSettings.eventCheck.instruction")}>
                <SettingsRow
                  layout="stack"
                  controlId="event-check-instruction"
                  class="agent-routine-instruction-field"
                  label={
                    <>
                      {t("agentSettings.eventCheck.instruction")}
                      <span class="ui-field-required" aria-hidden="true">
                        *
                      </span>
                    </>
                  }
                  help={
                    fieldError("instruction", current().value.instruction) ? (
                      <span class="event-check-field-error">
                        {fieldError("instruction", current().value.instruction)}
                      </span>
                    ) : undefined
                  }
                >
                  <Textarea
                    id="event-check-instruction"
                    aria-required="true"
                    invalid={Boolean(fieldError("instruction", current().value.instruction))}
                    value={current().value.instruction}
                    maxlength={16000}
                    onInput={(e) =>
                      setState((s) => {
                        if (s.current) s.current.value.instruction = e.currentTarget.value;
                        s.touched.instruction = true;
                        s.saved = false;
                      })
                    }
                    onBlur={() => touch("instruction")}
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup label={t("agentSettings.eventCheck.timing")}>
                <SettingsRow layout="stack" label={t("agentSettings.eventCheck.timing")}>
                  <fieldset class="event-check-segmented">
                    <legend class="sr-only">{t("agentSettings.eventCheck.timing")}</legend>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-pressed={current().timing === "interval" ? "true" : "false"}
                      onClick={() => setTiming("interval")}
                    >
                      {t("agentSettings.eventCheck.interval")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-pressed={current().timing === "calendar" ? "true" : "false"}
                      onClick={() => setTiming("calendar")}
                    >
                      {t("agentSettings.eventCheck.calendar")}
                    </Button>
                  </fieldset>
                </SettingsRow>
                <Show
                  when={current().timing === "interval"}
                  fallback={
                    <SettingsRow
                      layout="stack"
                      class="event-check-schedule"
                      label={t("agentSettings.eventCheck.calendar")}
                    >
                      <RoutineSchedulePicker
                        schedule={current().calendar}
                        kinds={ROUTINE_SAVED_DRAFT_KINDS}
                        onChange={(calendar) =>
                          setState((s) => {
                            if (s.current) s.current.calendar = calendar;
                          })
                        }
                      />
                    </SettingsRow>
                  }
                >
                  <SettingsRow
                    controlId="event-check-seconds"
                    label={t("agentSettings.eventCheck.seconds")}
                    description={t("agentSettings.eventCheck.intervalHelp", { min: MIN_INTERVAL_SECONDS })}
                    help={
                      intervalProblem() ? (
                        <span class="event-check-field-error">
                          {t("agentSettings.eventCheck.intervalInvalid", { min: MIN_INTERVAL_SECONDS })}
                        </span>
                      ) : undefined
                    }
                  >
                    <div class="event-check-unit-row">
                      <Input
                        id="event-check-seconds"
                        invalid={intervalProblem()}
                        type="number"
                        min={MIN_INTERVAL_SECONDS}
                        // An interval that was saved above the day still opens as valid.
                        max={Math.max(MAX_INTERVAL_SECONDS, savedIntervalSeconds())}
                        value={current().secondsText}
                        onInput={(e) =>
                          setState((s) => {
                            if (!s.current) return;
                            const text = e.currentTarget.value;
                            s.current.secondsText = text;
                            s.current.seconds = text.trim() === "" ? Number.NaN : Number(text);
                            s.saved = false;
                          })
                        }
                      />
                      <span class="event-check-unit" aria-hidden="true">
                        {t("agentSettings.eventCheck.secondsUnit")}
                      </span>
                    </div>
                  </SettingsRow>
                </Show>
                <SettingsRow controlId="event-check-timezone" label={t("agentSettings.eventCheck.timezone")}>
                  <Input
                    id="event-check-timezone"
                    value={current().value.timezone}
                    onInput={(e) =>
                      setState((s) => {
                        if (s.current) s.current.value.timezone = e.currentTarget.value;
                      })
                    }
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup label={t("agentSettings.eventCheck.skipSelf")}>
                <SettingsRow
                  layout="inline"
                  controlId="event-check-skip-self"
                  label={t("agentSettings.eventCheck.skipSelf")}
                  description={t("agentSettings.eventCheck.selfHelp")}
                >
                  <Switch
                    id="event-check-skip-self"
                    aria-label={t("agentSettings.eventCheck.skipSelf")}
                    checked={current().value.selfEvents.mode === "exclude"}
                    onChange={(exclude) =>
                      setState((s) => {
                        if (s.current) s.current.value.selfEvents.mode = exclude ? "exclude" : "include";
                      })
                    }
                  />
                </SettingsRow>
                <Show when={current().value.selfEvents.mode === "exclude"}>
                  <SettingsRow layout="stack" controlId="event-check-actor" label={t("agentSettings.eventCheck.actor")}>
                    <Input
                      id="event-check-actor"
                      value={current().value.selfEvents.actorPointer}
                      onInput={(e) =>
                        setState((s) => {
                          if (s.current) s.current.value.selfEvents.actorPointer = e.currentTarget.value;
                        })
                      }
                    />
                  </SettingsRow>
                  <SettingsRow
                    layout="stack"
                    controlId="event-check-actor-ids"
                    label={t("agentSettings.eventCheck.actorIds")}
                  >
                    <Textarea
                      id="event-check-actor-ids"
                      value={current().value.selfEvents.accountActorIds.join("\n")}
                      onInput={(e) =>
                        setState((s) => {
                          if (s.current)
                            s.current.value.selfEvents.accountActorIds = e.currentTarget.value
                              .split("\n")
                              .map((id) => id.trim())
                              .filter(Boolean);
                        })
                      }
                    />
                  </SettingsRow>
                </Show>
              </SettingsGroup>
              <Show when={deliveryAvailable()}>
                <SettingsGroup title={t("agentSettings.eventCheck.delivery")}>
                  <Choice
                    id="event-check-digest-label"
                    label={t("agentSettings.eventCheck.digest")}
                    value={String(current().digestSeconds)}
                    help={t("agentSettings.eventCheck.digestHelp")}
                    options={DIGEST_CHOICES.map((seconds) => ({
                      id: String(seconds),
                      name: digestName(seconds),
                    }))}
                    change={(seconds) =>
                      setState((s) => {
                        if (s.current) s.current.digestSeconds = Number(seconds);
                      })
                    }
                  />
                  <SettingsRow
                    layout="stack"
                    controlId="event-check-filters"
                    label={t("agentSettings.eventCheck.filters")}
                    help={t("agentSettings.eventCheck.filtersHelp")}
                  >
                    <Textarea
                      id="event-check-filters"
                      class="event-check-code"
                      placeholder={t("agentSettings.eventCheck.filtersPlaceholder")}
                      value={current().filtersText}
                      onInput={(e) =>
                        setState((s) => {
                          if (s.current) s.current.filtersText = e.currentTarget.value;
                        })
                      }
                    />
                  </SettingsRow>
                </SettingsGroup>
              </Show>
              <details class="event-check-details">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  {t("agentSettings.eventCheck.readOptions")}
                </summary>
                <SettingsGroup class="event-check-details-body" label={t("agentSettings.eventCheck.readOptions")}>
                  <SettingsRow
                    layout="stack"
                    controlId="event-check-arguments"
                    label={t("agentSettings.eventCheck.arguments")}
                    help={t("agentSettings.eventCheck.argumentsHelp")}
                  >
                    <Textarea
                      id="event-check-arguments"
                      class="event-check-code"
                      value={current().value.source.argumentsJson}
                      onInput={(e) => sourceChange("argumentsJson", e.currentTarget.value)}
                    />
                    <Show when={state.tools.find((tool) => tool.name === current().value.source.toolName)}>
                      {(tool) => <pre class="event-check-schema">{tool().inputSchemaJson}</pre>}
                    </Show>
                  </SettingsRow>
                  <SettingsRow layout="stack" controlId="event-check-items" label={t("agentSettings.eventCheck.items")}>
                    <Input
                      id="event-check-items"
                      class="event-check-code"
                      value={current().value.selection.itemsPointer}
                      onInput={(e) => selectionChange("itemsPointer", e.currentTarget.value)}
                    />
                  </SettingsRow>
                  <SettingsRow layout="stack" controlId="event-check-id" label={t("agentSettings.eventCheck.id")}>
                    <Input
                      id="event-check-id"
                      class="event-check-code"
                      value={current().value.selection.idPointer}
                      onInput={(e) => selectionChange("idPointer", e.currentTarget.value)}
                    />
                  </SettingsRow>
                  <SettingsRow
                    layout="stack"
                    controlId="event-check-revision"
                    label={t("agentSettings.eventCheck.revision")}
                    help={t("agentSettings.eventCheck.pathHelp")}
                  >
                    <Input
                      id="event-check-revision"
                      class="event-check-code"
                      value={current().value.selection.revisionPointer}
                      onInput={(e) => selectionChange("revisionPointer", e.currentTarget.value)}
                    />
                  </SettingsRow>
                  <SettingsRow
                    layout="stack"
                    controlId="event-check-cursorArgument"
                    label={t("agentSettings.eventCheck.cursorArgument")}
                  >
                    <Input
                      id="event-check-cursorArgument"
                      class="event-check-code"
                      value={current().value.source.cursorArgument}
                      onInput={(e) => sourceChange("cursorArgument", e.currentTarget.value)}
                    />
                  </SettingsRow>
                  <SettingsRow
                    layout="stack"
                    controlId="event-check-nextCursor"
                    label={t("agentSettings.eventCheck.nextCursor")}
                  >
                    <Input
                      id="event-check-nextCursor"
                      class="event-check-code"
                      value={current().value.source.nextCursorPointer}
                      onInput={(e) => sourceChange("nextCursorPointer", e.currentTarget.value)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </details>
              <Show when={current().value.id}>
                {(id) => (
                  <SettingsGroup label={t("agentSettings.eventCheck.activity")}>
                    <SettingsRow
                      layout="stack"
                      label={t("agentSettings.eventCheck.activity")}
                      help={checkNowReason() ? <span id="event-check-run-reason">{checkNowReason()}</span> : undefined}
                    >
                      <div class="event-check-run-actions">
                        <Button
                          variant="outline"
                          type="button"
                          size="sm"
                          aria-describedby={checkNowReason() ? "event-check-run-reason" : undefined}
                          disabled={state.busy || checkNowReason() !== null}
                          onClick={() =>
                            void action(async () => {
                              await props.api.checkNow({ agentId: shownAgent, id: id() });
                              await history();
                            }, t("agentSettings.eventCheck.checkNowFailed"))
                          }
                        >
                          {t("agentSettings.eventCheck.checkNow")}
                        </Button>
                        <Show when={current().value.source.kind === "api"}>
                          <Button
                            variant="outline"
                            type="button"
                            size="sm"
                            aria-describedby={testReason() ? "event-check-run-reason" : undefined}
                            disabled={state.busy || testReason() !== null || !props.api.test}
                            onClick={() =>
                              void action(async () => {
                                const target = { agentId: shownAgent, id: id() };
                                await props.api.test?.(target);
                                await history();
                              }, t("agentSettings.eventCheck.testFailed"))
                            }
                          >
                            {t("agentSettings.eventCheck.test")}
                          </Button>
                        </Show>
                        <Button
                          variant="outline"
                          type="button"
                          size="sm"
                          disabled={state.busy}
                          onClick={() => void action(history, t("agentSettings.eventCheck.historyFailed"))}
                        >
                          {t("agentSettings.eventCheck.history")}
                        </Button>
                      </div>
                    </SettingsRow>
                    <Show when={state.historyOpen}>
                      <section class="event-check-history" aria-label={t("agentSettings.eventCheck.history")}>
                        <Show
                          when={state.history.length}
                          fallback={<p class="agent-routines-empty">{t("agentSettings.eventCheck.noHistory")}</p>}
                        >
                          <For each={state.history}>
                            {(run) => (
                              <div class="event-check-log">
                                <div class="event-check-log-line">
                                  <time datetime={run.startedAt}>{time(run.startedAt)}</time>
                                  <RunStatus status={run.status} />
                                </div>
                                <small>
                                  {t("agentSettings.eventCheck.result", {
                                    items: run.itemCount,
                                    events: run.eventCount,
                                    ms: run.durationMs,
                                  })}
                                  <Show when={run.skippedSelfCount > 0}>
                                    {" · "}
                                    {t("agentSettings.eventCheck.skipped", { events: run.skippedSelfCount })}
                                  </Show>
                                  <Show when={run.filteredCount > 0}>
                                    {" · "}
                                    {t("agentSettings.eventCheck.filtered", { events: run.filteredCount })}
                                  </Show>
                                </small>
                                <Show when={run.error}>
                                  <p class="event-check-log-error">{sourceText(run.error ?? "")}</p>
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                      </section>
                    </Show>
                  </SettingsGroup>
                )}
              </Show>
              {/* Delete is last, away from Save, and it asks first. */}
              <Show when={current().value.id}>
                <SettingsGroup label={t("common.delete")}>
                  <SettingsRow
                    label={t("agentSettings.eventCheck.deleteRow")}
                    description={t("agentSettings.eventCheck.deleteRowDescription")}
                  >
                    <Button
                      variant="outline"
                      type="button"
                      size="sm"
                      disabled={state.busy}
                      onClick={() =>
                        setState((draft) => {
                          draft.confirmDelete = true;
                        })
                      }
                    >
                      {t("common.delete")}
                    </Button>
                  </SettingsRow>
                </SettingsGroup>
              </Show>
              <div class="event-check-save-region">
                <Show when={state.error}>
                  <p class="agent-settings-save-error" role="alert">
                    {state.error}
                  </p>
                </Show>
                {/* Always present, so a screen reader hears the text when it is set. */}
                <p role="status" class="event-check-saved">
                  {state.saved && !unsaved() ? t("agentSettings.eventCheck.saved") : ""}
                </p>
                <Show when={unsaved()}>
                  <div class="event-check-save-bar">
                    <Show when={hasVariableChanges(state.variables)}>
                      <Text as="p" variant="caption" tone="muted" class="event-check-save-note">
                        {t("agentSettings.eventCheck.variablesPause")}
                      </Text>
                    </Show>
                    <Show when={saveReason()}>
                      {(reason) => (
                        <Text
                          as="p"
                          variant="caption"
                          tone="muted"
                          id="event-check-save-reason"
                          class="event-check-save-note"
                        >
                          {reason()}
                        </Text>
                      )}
                    </Show>
                    <div class="event-check-save-actions">
                      <Button variant="ghost" type="button" size="sm" disabled={state.busy} onClick={reset}>
                        {t("agentSettings.eventCheck.reset")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        aria-describedby={saveReason() ? "event-check-save-reason" : undefined}
                        disabled={state.busy || missingForSave().length > 0 || intervalProblem()}
                        onClick={() => void save()}
                      >
                        {t("common.save")}
                      </Button>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <Show when={state.error && !state.current}>
          <p class="agent-settings-save-error" role="alert">
            {state.error}
          </p>
        </Show>
      </div>
      <ConfirmDialog
        open={state.confirmDelete && Boolean(state.current?.value.id)}
        onCancel={() =>
          setState((draft) => {
            draft.confirmDelete = false;
          })
        }
        onConfirm={async () => {
          const id = state.current?.value.id;
          if (!id) return;
          await action(async () => {
            await props.api.remove({ agentId: shownAgent, id });
            loadedLists.clear();
            closeEditor();
          }, t("agentSettings.eventCheck.deleteFailed"));
        }}
        tone="destructive"
        title={t("agentSettings.eventCheck.deleteTitle", { name: state.current?.value.name.trim() ?? "" })}
        description={t("agentSettings.eventCheck.deleteDescription")}
        confirmLabel={t("common.delete")}
        pendingLabel={t("common.deleting")}
        pending={state.busy}
        error={state.confirmDelete && state.error ? state.error : undefined}
        initialFocus="cancel"
      />
      <DiscardChangesDialog
        guard={guard}
        description={hasVariableChanges(state.variables) ? t("agentSettings.eventCheck.discardDescription") : undefined}
      />
    </section>
  );
}
