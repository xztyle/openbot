import type {
  EventCheck,
  EventCheckAccount,
  EventCheckApi,
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
  Input,
  Minus,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  SwitchField,
  Text,
  Textarea,
  TriangleAlert,
  X,
} from "@openbot/ui";
import { createEffect, createStore, For, onCleanup, Show, snapshot } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { SettingsBackIcon, SettingsForwardIcon } from "../../components/SettingsPanel";
import { useText } from "../../text";
import { EventCheckEnvironmentSettings } from "./EventCheckEnvironmentSettings";
import { RoutineSchedulePicker } from "./RoutineSchedulePicker";
import type { RoutineScheduleDraft } from "./routine-schedule-draft";
import { ROUTINE_SAVED_DRAFT_KINDS, routineScheduleFromDraft, routineScheduleToDraft } from "./routine-schedule-saved";
import { WatcherProgramFields } from "./WatcherProgramFields";

interface Props {
  api: EventCheckApi;
  apiProgramsAvailable?: boolean;
  agentId: string;
  onBack(): void;
  onClose(): void;
  onCountChange(count: number): void;
}
interface Editor {
  value: EventCheckInput;
  timing: "interval" | "calendar";
  seconds: number;
  calendar: RoutineScheduleDraft;
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
}
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
function editor(agentId: string, check?: EventCheck, api = false): Editor {
  const schedule = check?.schedule ?? defaultEventCheckSchedule();
  return {
    value: check
      ? structuredClone(snapshot(check))
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
    seconds:
      schedule.kind === "interval"
        ? schedule.amount *
          (schedule.unit === "seconds"
            ? 1
            : schedule.unit === "minutes"
              ? 60
              : schedule.unit === "hours"
                ? 3600
                : 86400)
        : 30,
    calendar: routineScheduleToDraft(schedule.kind === "interval" ? { kind: "daily", time: "09:00" } : schedule),
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
}) {
  return (
    <div class="settings-field">
      <span id={props.id}>{props.label}</span>
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
    </div>
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
  const { t, errorMessage, format } = useText();
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
  });
  const scrollFades = createScrollFades();
  onCleanup(scrollFades.stop);
  createEffect(
    () => [state.current?.value.id, state.checks.length, state.history.length, state.historyOpen, state.error] as const,
    () => {
      scrollFades.remeasure();
    },
  );
  let epoch = 0;
  const fail = (error: unknown) =>
    setState((draft) => {
      draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
    });
  const time = (value: string) => format.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });
  async function reload() {
    const requested = ++epoch;
    try {
      const checks = await props.api.list({ agentId: props.agentId });
      if (requested !== epoch) return;
      setState((draft) => {
        draft.checks = checks;
      });
      props.onCountChange(checks.length);
      return checks;
    } catch (error) {
      if (requested === epoch) fail(error);
    }
  }
  createEffect(
    () => [props.api, props.agentId] as const,
    () => {
      setState((draft) => {
        draft.current = null;
        draft.error = "";
      });
      void reload();
      void props.api
        .accounts({ agentId: props.agentId })
        .then((accounts) =>
          setState((draft) => {
            draft.accounts = accounts;
          }),
        )
        .catch(fail);
    },
  );
  async function open(check?: EventCheck) {
    const next = editor(props.agentId, check, props.apiProgramsAvailable ?? Boolean(props.api.environment));
    setState((draft) => {
      draft.current = next;
      draft.historyOpen = false;
      draft.history = [];
      draft.tools = [];
      draft.confirmDelete = false;
      draft.error = "";
    });
    // A store write is visible only after the next flush, so the new editor, not the store, names the account.
    if (next.value.source.kind === "mcp" && next.value.source.connectionId)
      await loadTools(next.value.source.connectionId);
  }
  function closeEditor() {
    setState((draft) => {
      draft.current = null;
      draft.error = "";
    });
  }
  async function loadTools(connectionId: string) {
    try {
      const tools = await props.api.tools({ agentId: props.agentId, connectionId });
      if (state.current?.value.source.connectionId === connectionId)
        setState((draft) => {
          draft.tools = tools;
        });
    } catch (error) {
      fail(error);
    }
  }
  async function action(run: () => Promise<unknown>) {
    setState((draft) => {
      draft.busy = true;
      draft.error = "";
    });
    try {
      await run();
      await reload();
    } catch (error) {
      fail(error);
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }
  async function save() {
    const current = state.current;
    if (!current) return;
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
    await action(async () => {
      const check = await props.api.save({ ...snapshot(current.value), schedule });
      setState((draft) => {
        draft.current = editor(props.agentId, check, props.apiProgramsAvailable ?? Boolean(props.api.environment));
      });
    });
  }
  async function history() {
    const id = state.current?.value.id;
    if (!id) return;
    const runs = await props.api.history({ agentId: props.agentId, id });
    setState((draft) => {
      draft.history = runs;
      draft.historyOpen = true;
    });
  }
  const dirty = () => {
    const current = state.current;
    const saved = state.checks.find((check) => check.id === current?.value.id);
    if (!current || !saved || JSON.stringify(current.value) !== JSON.stringify(saved)) return true;
    if (current.timing === "interval")
      return saved.schedule.kind !== "interval" || current.seconds !== editor(props.agentId, saved).seconds;
    return (
      saved.schedule.kind === "interval" ||
      JSON.stringify(snapshot(current.calendar)) !== JSON.stringify(routineScheduleToDraft(saved.schedule))
    );
  };
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
  return (
    <section class="agent-routines-settings event-check-settings" aria-label={t("agentSettings.eventCheck.title")}>
      <header class="settings-panel-header agent-routines-header">
        <Button
          variant="ghost"
          type="button"
          class="settings-panel-nav-button"
          aria-label={state.current ? t("agentSettings.eventCheck.all") : t("agentSettings.backToSettings")}
          disabled={state.busy && Boolean(state.current)}
          onClick={() => (state.current ? closeEditor() : props.onBack())}
        >
          <SettingsBackIcon />
        </Button>
        <div class="agent-routines-heading">
          <h2>
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
              onClick={props.onClose}
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
            <div class="event-check-list-view">
              <Text as="p" variant="caption" tone="muted" class="event-check-intro">
                {t("agentSettings.eventCheck.description")}
              </Text>
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
                <div class="agent-routines-list">
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
                            </small>
                          </span>
                        </Button>
                        <Switch
                          checked={check.active}
                          aria-label={t("agentSettings.eventCheck.activeName", { name: check.name })}
                          onChange={(active) => void action(() => props.api.save({ ...snapshot(check), active }))}
                          disabled={state.busy}
                        />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          }
        >
          {(current) => (
            <div class="agent-routine-editor event-check-editor">
              <div class="agent-routine-editor-actions">
                <div class="agent-routine-active-toggle">
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
                  <label for="event-check-active">
                    {current().value.active
                      ? t("agentSettings.eventCheck.active")
                      : t("agentSettings.eventCheck.paused")}
                  </label>
                </div>
                <div class="agent-routine-action-buttons">
                  <Show
                    when={!state.confirmDelete}
                    fallback={
                      <>
                        <Button
                          variant="destructive"
                          type="button"
                          size="sm"
                          disabled={state.busy}
                          onClick={() =>
                            void action(async () => {
                              await props.api.remove({ agentId: props.agentId, id: current().value.id ?? "" });
                              closeEditor();
                            })
                          }
                        >
                          {t("agentSettings.eventCheck.deleteNow")}
                        </Button>
                        <Button
                          variant="secondary"
                          type="button"
                          size="sm"
                          onClick={() =>
                            setState((draft) => {
                              draft.confirmDelete = false;
                            })
                          }
                        >
                          {t("common.cancel")}
                        </Button>
                      </>
                    }
                  >
                    <Show when={current().value.id}>
                      <Button
                        variant="destructive"
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
                    </Show>
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        state.busy ||
                        !current().value.source.toolName ||
                        !current().value.name.trim() ||
                        !current().value.instruction.trim()
                      }
                      onClick={() => void save()}
                    >
                      {t("common.save")}
                    </Button>
                  </Show>
                </div>
              </div>
              <label class="settings-field">
                <span>{t("agentSettings.eventCheck.name")}</span>
                <Input
                  value={current().value.name}
                  maxlength={256}
                  onInput={(e) =>
                    setState((s) => {
                      if (s.current) s.current.value.name = e.currentTarget.value;
                    })
                  }
                />
              </label>
              <Show when={templateLink(current().value.source)}>
                {(link) => (
                  <Text as="p" variant="caption" tone="muted" class="event-check-help">
                    {t("agentSettings.eventCheck.fromTemplate", { name: link().slug, version: link().version })}
                  </Text>
                )}
              </Show>
              <section class="event-check-section" aria-labelledby="event-check-source-heading">
                <h3 id="event-check-source-heading">{t("agentSettings.eventCheck.source")}</h3>
                <Show when={current().value.source.kind === "mcp"}>
                  <Choice
                    id="event-check-account-label"
                    label={t("agentSettings.eventCheck.account")}
                    options={state.accounts}
                    value={current().value.source.connectionId}
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
                  <Show when={!state.accounts.length}>
                    <Text as="p" variant="caption" tone="muted" class="event-check-help">
                      {t("agentSettings.eventCheck.noAccounts")}
                    </Text>
                  </Show>
                  <Choice
                    id="event-check-tool-label"
                    label={t("agentSettings.eventCheck.read")}
                    value={current().value.source.toolName}
                    options={state.tools.map((tool) => ({ id: tool.name, name: tool.name }))}
                    change={(name) =>
                      setState((s) => {
                        if (s.current) s.current.value.source.toolName = name;
                      })
                    }
                  />
                  <Show when={state.tools.find((tool) => tool.name === current().value.source.toolName)}>
                    {(tool) => (
                      <Text as="p" variant="caption" tone="muted" class="event-check-help">
                        {tool().description}
                      </Text>
                    )}
                  </Show>
                </Show>
                <Show when={apiSource(current().value.source)}>
                  {(source) => (
                    <WatcherProgramFields
                      source={source()}
                      change={(value) =>
                        setState((draft) => {
                          if (draft.current) draft.current.value.source = value;
                        })
                      }
                    />
                  )}
                </Show>
              </section>
              <Show when={current().value.source.kind === "api"}>
                <Show
                  when={state.checks.find((check) => check.id === current().value.id && check.source.kind === "api")}
                  keyed
                  fallback={
                    <Text as="p" variant="caption" tone="muted" class="event-check-help">
                      {t("agentSettings.eventCheck.saveBeforeVariables")}
                    </Text>
                  }
                >
                  {(check) => (
                    <EventCheckEnvironmentSettings
                      api={props.api}
                      check={check}
                      disabled={dirty()}
                      changed={async () => {
                        const id = check.id;
                        const checks = await reload();
                        const updated = checks?.find((entry) => entry.id === id);
                        if (updated && state.current?.value.id === id) await open(updated);
                      }}
                    />
                  )}
                </Show>
              </Show>
              <label class="settings-field agent-routine-instruction-field">
                <span>{t("agentSettings.eventCheck.instruction")}</span>
                <Textarea
                  value={current().value.instruction}
                  maxlength={16000}
                  onInput={(e) =>
                    setState((s) => {
                      if (s.current) s.current.value.instruction = e.currentTarget.value;
                    })
                  }
                />
              </label>
              <section class="event-check-section" aria-labelledby="event-check-timing-heading">
                <h3 id="event-check-timing-heading">{t("agentSettings.eventCheck.timing")}</h3>
                <div class="event-check-segmented">
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
                </div>
                <Show
                  when={current().timing === "interval"}
                  fallback={
                    <div class="event-check-schedule">
                      <RoutineSchedulePicker
                        schedule={current().calendar}
                        kinds={ROUTINE_SAVED_DRAFT_KINDS}
                        onChange={(calendar) =>
                          setState((s) => {
                            if (s.current) s.current.calendar = calendar;
                          })
                        }
                      />
                    </div>
                  }
                >
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.seconds")}</span>
                    <Input
                      type="number"
                      min={30}
                      max={8640000000}
                      value={String(current().seconds)}
                      onInput={(e) =>
                        setState((s) => {
                          if (s.current) s.current.seconds = Number(e.currentTarget.value);
                        })
                      }
                    />
                  </label>
                </Show>
                <label class="settings-field">
                  <span>{t("agentSettings.eventCheck.timezone")}</span>
                  <Input
                    value={current().value.timezone}
                    onInput={(e) =>
                      setState((s) => {
                        if (s.current) s.current.value.timezone = e.currentTarget.value;
                      })
                    }
                  />
                </label>
              </section>
              <section class="event-check-section event-check-card">
                <SwitchField
                  checked={current().value.selfEvents.mode === "exclude"}
                  label={t("agentSettings.eventCheck.skipSelf")}
                  description={t("agentSettings.eventCheck.selfHelp")}
                  onChange={(exclude) =>
                    setState((s) => {
                      if (s.current) s.current.value.selfEvents.mode = exclude ? "exclude" : "include";
                    })
                  }
                />
                <Show when={current().value.selfEvents.mode === "exclude"}>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.actor")}</span>
                    <Input
                      value={current().value.selfEvents.actorPointer}
                      onInput={(e) =>
                        setState((s) => {
                          if (s.current) s.current.value.selfEvents.actorPointer = e.currentTarget.value;
                        })
                      }
                    />
                  </label>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.actorIds")}</span>
                    <Textarea
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
                  </label>
                </Show>
              </section>
              <details class="event-check-details">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  {t("agentSettings.eventCheck.readOptions")}
                </summary>
                <div class="event-check-details-body">
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.arguments")}</span>
                    <Textarea
                      class="event-check-code"
                      value={current().value.source.argumentsJson}
                      onInput={(e) => sourceChange("argumentsJson", e.currentTarget.value)}
                    />
                  </label>
                  <Text as="p" variant="caption" tone="muted" class="event-check-help">
                    {t("agentSettings.eventCheck.argumentsHelp")}
                  </Text>
                  <Show when={state.tools.find((tool) => tool.name === current().value.source.toolName)}>
                    {(tool) => <pre class="event-check-schema">{tool().inputSchemaJson}</pre>}
                  </Show>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.items")}</span>
                    <Input
                      class="event-check-code"
                      value={current().value.selection.itemsPointer}
                      onInput={(e) => selectionChange("itemsPointer", e.currentTarget.value)}
                    />
                  </label>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.id")}</span>
                    <Input
                      class="event-check-code"
                      value={current().value.selection.idPointer}
                      onInput={(e) => selectionChange("idPointer", e.currentTarget.value)}
                    />
                  </label>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.revision")}</span>
                    <Input
                      class="event-check-code"
                      value={current().value.selection.revisionPointer}
                      onInput={(e) => selectionChange("revisionPointer", e.currentTarget.value)}
                    />
                  </label>
                  <Text as="p" variant="caption" tone="muted" class="event-check-help">
                    {t("agentSettings.eventCheck.pathHelp")}
                  </Text>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.cursorArgument")}</span>
                    <Input
                      class="event-check-code"
                      value={current().value.source.cursorArgument}
                      onInput={(e) => sourceChange("cursorArgument", e.currentTarget.value)}
                    />
                  </label>
                  <label class="settings-field">
                    <span>{t("agentSettings.eventCheck.nextCursor")}</span>
                    <Input
                      class="event-check-code"
                      value={current().value.source.nextCursorPointer}
                      onInput={(e) => sourceChange("nextCursorPointer", e.currentTarget.value)}
                    />
                  </label>
                </div>
              </details>
              <Show when={current().value.id}>
                {(id) => (
                  <section class="event-check-section" aria-labelledby="event-check-activity-heading">
                    <h3 id="event-check-activity-heading">{t("agentSettings.eventCheck.activity")}</h3>
                    <div class="event-check-run-actions">
                      <Button
                        variant="secondary"
                        type="button"
                        size="sm"
                        disabled={state.busy || dirty() || !current().value.active}
                        onClick={() =>
                          void action(async () => {
                            await props.api.checkNow({ agentId: props.agentId, id: id() });
                            await history();
                          })
                        }
                      >
                        {t("agentSettings.eventCheck.checkNow")}
                      </Button>
                      <Show when={current().value.source.kind === "api"}>
                        <Button
                          variant="secondary"
                          type="button"
                          size="sm"
                          disabled={state.busy || dirty() || !props.api.test}
                          onClick={() =>
                            void action(async () => {
                              const target = { agentId: props.agentId, id: id() };
                              await props.api.test?.(target);
                              await history();
                            })
                          }
                        >
                          {t("agentSettings.eventCheck.test")}
                        </Button>
                      </Show>
                      <Button
                        variant="ghost"
                        type="button"
                        size="sm"
                        disabled={state.busy}
                        onClick={() => void action(history)}
                      >
                        {t("agentSettings.eventCheck.history")}
                      </Button>
                    </div>
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
                                </small>
                                <Show when={run.error}>
                                  <p class="event-check-log-error">{run.error}</p>
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                      </section>
                    </Show>
                  </section>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={state.error}>
          <p class="agent-settings-save-error" role="alert">
            {state.error}
          </p>
        </Show>
      </div>
    </section>
  );
}
