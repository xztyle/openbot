import type {
  EventCheck,
  EventCheckAccount,
  EventCheckApi,
  EventCheckExecution,
  EventCheckInput,
  EventCheckTool,
} from "@openbot/contracts/event-checks";
import { defaultEventCheckSchedule } from "@openbot/contracts/event-checks";
import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  SwitchField,
  Textarea,
} from "@openbot/ui";
import { createEffect, createStore, For, Show, snapshot } from "solid-js";
import { useText } from "../../text";
import { RoutineSchedulePicker } from "./RoutineSchedulePicker";
import type { RoutineScheduleDraft } from "./routine-schedule-draft";
import { ROUTINE_SAVED_DRAFT_KINDS, routineScheduleFromDraft, routineScheduleToDraft } from "./routine-schedule-saved";

interface Props {
  api: EventCheckApi;
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
  busy: boolean;
  error: string;
}
function editor(agentId: string, check?: EventCheck): Editor {
  const schedule = check?.schedule ?? defaultEventCheckSchedule();
  return {
    value: check
      ? structuredClone(snapshot(check))
      : {
          agentId,
          name: "",
          instruction: "",
          active: true,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          schedule,
          selfEvents: { mode: "exclude", connectionId: "", actorPointer: "", accountActorIds: [] },
          source: {
            kind: "mcp",
            connectionId: "",
            toolName: "",
            argumentsJson: "{}",
            cursorArgument: "",
            nextCursorPointer: "",
          },
          selection: { itemsPointer: "", idPointer: "/id", revisionPointer: "" },
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
  label: string;
  value: string;
  options: { id: string; name: string }[];
  change(value: string): void;
}) {
  return (
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
      <SelectTrigger aria-label={props.label}>
        <SelectValue<string>>
          {(state) => props.options.find((choice) => choice.id === state.selectedOption())?.name ?? props.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}
/** Shared controls only; the host adapter owns authentication, storage and scheduling. */
export function EventChecksSettings(props: Props) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<State>({
    checks: [],
    accounts: [],
    tools: [],
    current: null,
    history: [],
    historyOpen: false,
    busy: false,
    error: "",
  });
  let epoch = 0;
  const fail = (error: unknown) =>
    setState((draft) => {
      draft.error = errorMessage(error, t("agentSettings.eventCheck.failed"));
    });
  async function reload() {
    const requested = ++epoch;
    try {
      const checks = await props.api.list({ agentId: props.agentId });
      if (requested !== epoch) return;
      setState((draft) => {
        draft.checks = checks;
      });
      props.onCountChange(checks.length);
    } catch (error) {
      if (requested === epoch) fail(error);
    }
  }
  createEffect(
    () => [props.api, props.agentId] as const,
    () => {
      setState((draft) => {
        draft.current = null;
      });
      setState((draft) => {
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
    setState((draft) => {
      draft.current = editor(props.agentId, check);
    });
    setState((draft) => {
      draft.historyOpen = false;
    });
    setState((draft) => {
      draft.history = [];
    });
    setState((draft) => {
      draft.tools = [];
    });
    setState((draft) => {
      draft.error = "";
    });
    if (check) await loadTools(check.source.connectionId);
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
    });
    setState((draft) => {
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
        draft.current = editor(props.agentId, check);
      });
    });
  }
  async function history() {
    const id = state.current?.value.id;
    if (!id) return;
    const runs = await props.api.history({ agentId: props.agentId, id });
    setState((draft) => {
      draft.history = runs;
    });
    setState((draft) => {
      draft.historyOpen = true;
    });
  }
  const dirty = () => {
    const current = state.current;
    const saved = state.checks.find((check) => check.id === current?.value.id);
    if (!current || !saved || JSON.stringify(snapshot(current.value)) !== JSON.stringify(snapshot(saved))) return true;
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
  return (
    <section class="event-check-settings" aria-label={t("agentSettings.eventCheck.title")}>
      <div class="event-check-actions">
        <Button variant="ghost" onClick={props.onBack}>
          {t("common.back")}
        </Button>
        <Button variant="ghost" onClick={props.onClose}>
          {t("common.close")}
        </Button>
      </div>
      <h2>{t("agentSettings.eventCheck.title")}</h2>
      <p>{t("agentSettings.eventCheck.description")}</p>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
      <Show
        when={state.current}
        fallback={
          <>
            <Button onClick={() => void open()}>{t("agentSettings.eventCheck.add")}</Button>
            <Show when={!state.checks.length}>
              <p>{t("agentSettings.eventCheck.empty")}</p>
            </Show>
            <For each={state.checks}>
              {(check) => (
                <div class="event-check-row">
                  <Button variant="ghost" onClick={() => void open(check)}>
                    {check.name}
                  </Button>
                  <Switch
                    checked={check.active}
                    aria-label={t("agentSettings.eventCheck.activeName", { name: check.name })}
                    onChange={(active) => void action(() => props.api.save({ ...snapshot(check), active }))}
                    disabled={state.busy}
                  />
                  <span>
                    {check.active
                      ? t("agentSettings.eventCheck.next", { time: new Date(check.nextCheckAt).toLocaleString() })
                      : t("agentSettings.eventCheck.paused")}
                  </span>
                </div>
              )}
            </For>
          </>
        }
      >
        {(current) => (
          <div class="event-check-editor">
            <Button
              variant="ghost"
              onClick={() =>
                setState((draft) => {
                  draft.current = null;
                })
              }
            >
              {t("agentSettings.eventCheck.all")}
            </Button>
            <label>
              {t("agentSettings.eventCheck.name")}
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
            <Choice
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
              <p>{t("agentSettings.eventCheck.noAccounts")}</p>
            </Show>
            <Choice
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
              {(tool) => <p>{tool().description}</p>}
            </Show>
            <label>
              {t("agentSettings.eventCheck.instruction")}
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
            <div class="event-check-actions">
              <Button
                variant={current().timing === "interval" ? "secondary" : "ghost"}
                onClick={() =>
                  setState((s) => {
                    if (s.current) s.current.timing = "interval";
                  })
                }
              >
                {t("agentSettings.eventCheck.interval")}
              </Button>
              <Button
                variant={current().timing === "calendar" ? "secondary" : "ghost"}
                onClick={() =>
                  setState((s) => {
                    if (s.current) s.current.timing = "calendar";
                  })
                }
              >
                {t("agentSettings.eventCheck.calendar")}
              </Button>
            </div>
            <Show
              when={current().timing === "interval"}
              fallback={
                <RoutineSchedulePicker
                  schedule={current().calendar}
                  kinds={ROUTINE_SAVED_DRAFT_KINDS}
                  onChange={(calendar) =>
                    setState((s) => {
                      if (s.current) s.current.calendar = calendar;
                    })
                  }
                />
              }
            >
              <label>
                {t("agentSettings.eventCheck.seconds")}
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
            <label>
              {t("agentSettings.eventCheck.timezone")}
              <Input
                value={current().value.timezone}
                onInput={(e) =>
                  setState((s) => {
                    if (s.current) s.current.value.timezone = e.currentTarget.value;
                  })
                }
              />
            </label>
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
              <label>
                {t("agentSettings.eventCheck.actor")}
                <Input
                  value={current().value.selfEvents.actorPointer}
                  onInput={(e) =>
                    setState((s) => {
                      if (s.current) s.current.value.selfEvents.actorPointer = e.currentTarget.value;
                    })
                  }
                />
              </label>
              <label>
                {t("agentSettings.eventCheck.actorIds")}
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
            <details>
              <summary>{t("agentSettings.eventCheck.readOptions")}</summary>
              <label>
                {t("agentSettings.eventCheck.arguments")}
                <Textarea
                  value={current().value.source.argumentsJson}
                  onInput={(e) => sourceChange("argumentsJson", e.currentTarget.value)}
                />
              </label>
              <p>{t("agentSettings.eventCheck.argumentsHelp")}</p>
              <Show when={state.tools.find((tool) => tool.name === current().value.source.toolName)}>
                {(tool) => <pre>{tool().inputSchemaJson}</pre>}
              </Show>
              <label>
                {t("agentSettings.eventCheck.items")}
                <Input
                  value={current().value.selection.itemsPointer}
                  onInput={(e) => selectionChange("itemsPointer", e.currentTarget.value)}
                />
              </label>
              <label>
                {t("agentSettings.eventCheck.id")}
                <Input
                  value={current().value.selection.idPointer}
                  onInput={(e) => selectionChange("idPointer", e.currentTarget.value)}
                />
              </label>
              <label>
                {t("agentSettings.eventCheck.revision")}
                <Input
                  value={current().value.selection.revisionPointer}
                  onInput={(e) => selectionChange("revisionPointer", e.currentTarget.value)}
                />
              </label>
              <p>{t("agentSettings.eventCheck.pathHelp")}</p>
              <label>
                {t("agentSettings.eventCheck.cursorArgument")}
                <Input
                  value={current().value.source.cursorArgument}
                  onInput={(e) => sourceChange("cursorArgument", e.currentTarget.value)}
                />
              </label>
              <label>
                {t("agentSettings.eventCheck.nextCursor")}
                <Input
                  value={current().value.source.nextCursorPointer}
                  onInput={(e) => sourceChange("nextCursorPointer", e.currentTarget.value)}
                />
              </label>
            </details>
            <div class="event-check-actions">
              <SwitchField
                checked={current().value.active}
                label={t("agentSettings.eventCheck.active")}
                onChange={(active) =>
                  setState((s) => {
                    if (s.current) s.current.value.active = active;
                  })
                }
              />
              <Button
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
              <Show when={current().value.id}>
                {(id) => (
                  <>
                    <Button
                      variant="secondary"
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
                    <Button variant="ghost" disabled={state.busy} onClick={() => void action(history)}>
                      {t("agentSettings.eventCheck.history")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={state.busy}
                      onClick={() =>
                        void action(async () => {
                          await props.api.remove({ agentId: props.agentId, id: id() });
                          setState((draft) => {
                            draft.current = null;
                          });
                        })
                      }
                    >
                      {t("common.delete")}
                    </Button>
                  </>
                )}
              </Show>
            </div>
            <Show when={state.historyOpen}>
              <section aria-label={t("agentSettings.eventCheck.history")}>
                <h3>{t("agentSettings.eventCheck.history")}</h3>
                <For each={state.history}>
                  {(run) => (
                    <div class="event-check-log">
                      <time datetime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                      <span>{t(STATUS_KEYS[run.status])}</span>
                      <span>
                        {t("agentSettings.eventCheck.result", {
                          items: run.itemCount,
                          events: run.eventCount,
                          ms: run.durationMs,
                        })}
                      </span>
                      <Show when={run.skippedSelfCount > 0}>
                        <span>{t("agentSettings.eventCheck.skipped", { events: run.skippedSelfCount })}</span>
                      </Show>
                      <Show when={run.error}>
                        <p>{run.error}</p>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={!state.history.length}>
                  <p>{t("agentSettings.eventCheck.noHistory")}</p>
                </Show>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
