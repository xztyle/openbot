import type {
  EventCheckPickerOption,
  EventCheckPickerOptions,
  EventCheckTemplatePicker,
} from "@openbot/contracts/event-check-templates";
import { EVENT_CHECK_PICKER_MAX_ENTRIES, formatEventCheckPickerValue } from "@openbot/contracts/event-check-templates";
import {
  Button,
  Checkbox,
  Input,
  RefreshCw,
  Search,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  Textarea,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createStore, createUniqueId, For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";
import {
  entriesOutsideList,
  isPickerId,
  type PickerSection,
  pickerGroupKey,
  pickerLimitReached,
  pickerSections,
  readPickerEntries,
  withoutPickerEntry,
  withPickerEntry,
} from "./event-check-picker";

export interface EventCheckPickerFieldProps {
  /** The label of the setting, with its optional marker when it has one. */
  label: JSX.Element;
  description: string;
  picker: EventCheckTemplatePicker;
  /** The saved text: `ID:mode,ID:mode`. */
  value: string;
  onChange(value: string): void;
  /** Reads the list. It can fail with a sentence that is safe to show. */
  load(): Promise<EventCheckPickerOptions>;
  /** What is missing before the list can load, as a sentence. Absent when it can load. */
  blocked?: string | undefined;
  disabled?: boolean | undefined;
}

type LoadStatus = "idle" | "loading" | "loaded" | "failed";

interface PickerState {
  status: LoadStatus;
  options: EventCheckPickerOption[];
  truncated: boolean;
  error: string;
  query: string;
  manual: string;
  manualError: "" | "invalid" | "duplicate" | "limit";
}

/**
 * A setting that is filled from a list the program reads from the person's own account. The value
 * stays the text the program expects. Every name in the list is text from another party: it is shown
 * as text and never as markup. The list is only read when the person asks for it.
 */
export function EventCheckPickerField(props: EventCheckPickerFieldProps) {
  const { t, errorMessage } = useText();
  const id = createUniqueId();
  const [state, setState] = createStore<PickerState>({
    status: "idle",
    options: [],
    truncated: false,
    error: "",
    query: "",
    manual: "",
    manualError: "",
  });
  let generation = 0;
  onCleanup(() => {
    generation++;
  });

  const entries = createMemo(() => readPickerEntries(props.value, props.picker));
  const modeOf = createMemo(() => new Map((entries() ?? []).map((entry) => [entry.id, entry.mode])));
  const sections = createMemo(() => pickerSections(state.options, state.query));
  const outside = createMemo(() => entriesOutsideList(entries() ?? [], state.options));
  const labelOf = (optionId: string) => state.options.find((option) => option.id === optionId)?.label ?? optionId;
  const modeLabel = (mode: string) => props.picker.modes.find((entry) => entry.value === mode)?.label ?? mode;
  const defaultMode = () => props.picker.modes[0]?.value ?? "all";

  function commit(next: readonly { id: string; mode: string }[]) {
    props.onChange(formatEventCheckPickerValue(next));
  }
  function choose(optionId: string, on: boolean) {
    const current = entries() ?? [];
    if (on) {
      if (pickerLimitReached(current) && !current.some((entry) => entry.id === optionId)) return;
      commit(withPickerEntry(current, optionId, modeOf().get(optionId) ?? defaultMode()));
    } else commit(withoutPickerEntry(current, optionId));
  }
  function setMode(optionId: string, mode: string) {
    commit(withPickerEntry(entries() ?? [], optionId, mode));
  }
  function addManual() {
    const current = entries() ?? [];
    const manual = state.manual.trim();
    if (manual === "") return;
    const failure = !isPickerId(manual, props.picker)
      ? "invalid"
      : current.some((entry) => entry.id === manual)
        ? "duplicate"
        : pickerLimitReached(current)
          ? "limit"
          : "";
    setState((draft) => {
      draft.manualError = failure;
      if (!failure) draft.manual = "";
    });
    if (!failure) commit(withPickerEntry(current, manual, defaultMode()));
  }

  async function load() {
    if (props.blocked || state.status === "loading" || props.disabled) return;
    const requested = ++generation;
    setState((draft) => {
      draft.status = "loading";
      draft.error = "";
    });
    try {
      const result = await props.load();
      if (requested !== generation) return;
      setState((draft) => {
        draft.options = result.options;
        draft.truncated = result.truncated === true;
        draft.status = "loaded";
      });
    } catch (error) {
      if (requested !== generation) return;
      setState((draft) => {
        draft.status = "failed";
        draft.error = errorMessage(error, t("agentSettings.eventCheck.picker.failed"));
      });
    }
  }

  const ModeSelect = (selectProps: { optionId: string; mode: string }) => (
    <Select<string>
      options={props.picker.modes.map((mode) => mode.value)}
      value={selectProps.mode}
      disabled={props.disabled}
      onChange={(value) => {
        if (value) setMode(selectProps.optionId, value);
      }}
      itemComponent={(item) => <SelectItem item={item.item}>{modeLabel(item.item.rawValue)}</SelectItem>}
    >
      <SelectTrigger
        size="sm"
        class="event-check-picker-mode"
        aria-label={t("agentSettings.eventCheck.picker.mode", { name: labelOf(selectProps.optionId) })}
      >
        <SelectValue<string>>{(value) => modeLabel(value.selectedOption() ?? selectProps.mode)}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );

  const Row = (rowProps: { option: EventCheckPickerOption }) => {
    const rowId = createUniqueId();
    const mode = () => modeOf().get(rowProps.option.id);
    const full = () => pickerLimitReached(entries() ?? []) && mode() === undefined;
    return (
      <li class="event-check-picker-row">
        <label class="event-check-picker-choice" for={rowId}>
          <Checkbox
            id={rowId}
            checked={mode() !== undefined}
            disabled={props.disabled || full()}
            aria-label={t("agentSettings.eventCheck.picker.watch", { name: rowProps.option.label })}
            onChange={(event) => choose(rowProps.option.id, event.currentTarget.checked)}
          />
          <span class="event-check-picker-name">
            <span>{rowProps.option.label}</span>
            <Show when={rowProps.option.description}>
              <Text as="small" variant="caption" tone="muted">
                {rowProps.option.description}
              </Text>
            </Show>
          </span>
        </label>
        <Show when={mode()}>{(chosen) => <ModeSelect optionId={rowProps.option.id} mode={chosen()} />}</Show>
      </li>
    );
  };

  const Section = (sectionProps: { section: PickerSection }) => {
    const key = () => pickerGroupKey(sectionProps.section.group);
    return (
      <section class="event-check-picker-group">
        <h5 class="event-check-picker-group-title">
          {key()
            ? t(key() ?? "agentSettings.eventCheck.picker.group.other")
            : t("agentSettings.eventCheck.picker.group.other")}
        </h5>
        <ul class="event-check-picker-list">
          <For each={sectionProps.section.options}>{(option) => <Row option={option} />}</For>
        </ul>
      </section>
    );
  };

  return (
    <fieldset class="event-check-picker">
      <legend id={`${id}-label`} class="ui-label">
        {props.label}
      </legend>
      <Show when={props.description}>
        <Text as="small" variant="caption" tone="muted">
          {props.description}
        </Text>
      </Show>

      <Show
        when={entries()}
        fallback={
          <div class="event-check-picker-raw">
            <Text as="p" variant="caption" tone="muted" role="alert">
              {t("agentSettings.eventCheck.picker.invalidValue")}
            </Text>
            <Textarea
              value={props.value}
              spellcheck={false}
              maxlength={8192}
              disabled={props.disabled}
              aria-labelledby={`${id}-label`}
              onValueChange={(value) => props.onChange(value)}
            />
          </div>
        }
      >
        {(chosen) => (
          <>
            <div class="event-check-picker-actions">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={Boolean(props.blocked) || props.disabled}
                loading={state.status === "loading"}
                loadingLabel={t("agentSettings.eventCheck.picker.loading")}
                onClick={() => void load()}
              >
                <Show when={state.status === "loaded"}>
                  <RefreshCw aria-hidden="true" />
                </Show>
                {state.status === "loaded"
                  ? t("agentSettings.eventCheck.picker.reload")
                  : t("agentSettings.eventCheck.picker.load")}
              </Button>
              <Text as="span" variant="caption" tone="muted">
                {t("agentSettings.eventCheck.picker.selected", { count: chosen().length })}
              </Text>
            </div>
            <Show when={props.blocked}>
              <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                {props.blocked}
              </Text>
            </Show>
            <Show when={state.status === "failed"}>
              <Text as="p" variant="caption" role="alert" class="event-check-picker-error">
                {state.error}
              </Text>
            </Show>
            <Show when={pickerLimitReached(chosen())}>
              <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                {t("agentSettings.eventCheck.picker.limit", { max: EVENT_CHECK_PICKER_MAX_ENTRIES })}
              </Text>
            </Show>

            <Show when={state.status === "loaded"}>
              <Show
                when={state.options.length > 0}
                fallback={
                  <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                    {t("agentSettings.eventCheck.picker.empty")}
                  </Text>
                }
              >
                <Show when={state.truncated}>
                  <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                    {t("agentSettings.eventCheck.picker.truncated", { count: state.options.length })}
                  </Text>
                </Show>
                <div class="event-check-picker-search">
                  <Search aria-hidden="true" />
                  <Input
                    type="search"
                    value={state.query}
                    placeholder={t("agentSettings.eventCheck.picker.search")}
                    aria-label={t("agentSettings.eventCheck.picker.search")}
                    autocomplete="off"
                    spellcheck={false}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.query = value;
                      })
                    }
                  />
                </div>
                <div class="event-check-picker-scroll">
                  <Show
                    when={sections().length > 0}
                    fallback={
                      <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                        {t("agentSettings.eventCheck.picker.noMatch")}
                      </Text>
                    }
                  >
                    <For each={sections()}>{(section) => <Section section={section} />}</For>
                  </Show>
                </div>
              </Show>
            </Show>

            <Show when={outside().length > 0}>
              <section class="event-check-picker-group" aria-label={t("agentSettings.eventCheck.picker.outside")}>
                <h5 class="event-check-picker-group-title">{t("agentSettings.eventCheck.picker.outside")}</h5>
                <Text as="small" variant="caption" tone="muted">
                  {t("agentSettings.eventCheck.picker.outsideHelp")}
                </Text>
                <ul class="event-check-picker-list">
                  <For each={outside()}>
                    {(entry) => (
                      <li class="event-check-picker-row">
                        <span class="event-check-picker-name">
                          <code>{entry.id}</code>
                        </span>
                        <ModeSelect optionId={entry.id} mode={entry.mode} />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={props.disabled}
                          aria-label={t("agentSettings.eventCheck.picker.remove", { name: entry.id })}
                          onClick={() => choose(entry.id, false)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <div class="event-check-picker-manual">
              <div class="settings-field">
                <label for={`${id}-manual`}>{t("agentSettings.eventCheck.picker.addById")}</label>
                <span class="event-check-picker-manual-row">
                  <Input
                    id={`${id}-manual`}
                    value={state.manual}
                    maxlength={64}
                    placeholder={t("agentSettings.eventCheck.picker.addByIdPlaceholder")}
                    autocomplete="off"
                    spellcheck={false}
                    disabled={props.disabled}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.manual = value;
                        draft.manualError = "";
                      })
                    }
                    onKeyDown={(event) => {
                      // Enter adds the ID here, and does not submit the form around the field.
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addManual();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={props.disabled || state.manual.trim() === ""}
                    onClick={addManual}
                  >
                    {t("agentSettings.eventCheck.picker.add")}
                  </Button>
                </span>
              </div>
              <Show when={state.manualError === "invalid"}>
                <Text as="p" variant="caption" role="alert" class="event-check-picker-error">
                  {t("agentSettings.eventCheck.picker.idInvalid")}
                </Text>
              </Show>
              <Show when={state.manualError === "duplicate"}>
                <Text as="p" variant="caption" role="alert" class="event-check-picker-error">
                  {t("agentSettings.eventCheck.picker.idDuplicate")}
                </Text>
              </Show>
              <Show when={state.manualError === "limit"}>
                <Text as="p" variant="caption" role="alert" class="event-check-picker-error">
                  {t("agentSettings.eventCheck.picker.limit", { max: EVENT_CHECK_PICKER_MAX_ENTRIES })}
                </Text>
              </Show>
            </div>
          </>
        )}
      </Show>
    </fieldset>
  );
}
