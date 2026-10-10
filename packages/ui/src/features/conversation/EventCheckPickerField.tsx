import type {
  EventCheckPickerEntry,
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
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  createUniqueId,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
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
  /**
   * The saved names of the chosen options, by ID. They show before any list is loaded, so a person
   * reads a channel name and not its ID.
   */
  labels?: Record<string, string> | undefined;
  /**
   * The new value, with the names of the chosen options that this field knows. The owner keeps both
   * and saves them together: the names are display text, and the value is what the program reads.
   */
  onChange(value: string, labels: Record<string, string>): void;
  /**
   * Reads the list. It can fail with a sentence that is safe to show. `refresh` asks the owner to
   * read the app again and not to answer from a list that it kept.
   */
  load(options?: { refresh?: boolean }): Promise<EventCheckPickerOptions>;
  /**
   * Loads the list when the field appears and nothing blocks it, without a click. The owner sets it
   * only where the read is safe: an installed check with its saved private value, answered from the
   * host's memory when it has a current list. A draft never sets it.
   */
  autoLoad?: boolean | undefined;
  /**
   * Names the saved choices that have no name yet, with one cheap call. The field asks once, when it
   * can load and no list was loaded. A failure is silent: the choices keep showing their IDs.
   */
  resolve?(ids: string[]): Promise<EventCheckPickerOptions>;
  /** What is missing before the list can load, as a sentence. Absent when it can load. */
  blocked?: string | undefined;
  /** A list that was loaded before. The field starts with it, so a remount does not drop it. */
  initial?: EventCheckPickerOptions | undefined;
  /** Called with each list that this field loads, so the owner can pass it back as `initial`. */
  onLoaded?(options: EventCheckPickerOptions): void;
  disabled?: boolean | undefined;
}

type LoadStatus = "idle" | "loading" | "loaded" | "failed";

/** When a list was read, in milliseconds: the time the host gave, or now for a host that gives none. */
function readTime(options: EventCheckPickerOptions): number {
  const parsed = options.readAt === undefined ? Number.NaN : Date.parse(options.readAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

interface PickerState {
  status: LoadStatus;
  /** Whether a list was loaded at least once. A reload or a failed reload keeps that list on screen. */
  listed: boolean;
  options: EventCheckPickerOption[];
  /** The names that this field has seen, by ID: from the loaded lists and from the rows that were chosen. */
  labels: Record<string, string>;
  truncated: boolean;
  /** The account that the loaded list is for, when the program said. */
  account: string;
  /** When the loaded list was read from the app, in milliseconds. Null before any list. */
  readAt: number | null;
  /** The app could not be read just now, so the list on screen is an older one. */
  stale: boolean;
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
  const initial = untrack(() => props.initial);
  const [state, setState] = createStore<PickerState>({
    status: initial ? "loaded" : "idle",
    listed: initial !== undefined,
    options: initial ? [...initial.options] : [],
    labels: Object.fromEntries((initial?.options ?? []).map((option) => [option.id, option.label])),
    truncated: initial?.truncated === true,
    account: initial?.account?.label ?? "",
    readAt: initial ? readTime(initial) : null,
    stale: initial?.stale === true,
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
  // Before a list is loaded no entry is known to be outside it: each one is simply a chosen entry.
  const outside = createMemo(() => (state.listed ? entriesOutsideList(entries() ?? [], state.options) : []));
  const unlisted = createMemo(() => (state.listed ? [] : (entries() ?? [])));
  /**
   * The name that the field has for an ID, or undefined: the loaded list and chosen rows first, then
   * the names saved with the check. A name is never made up from an ID.
   */
  const nameOf = (optionId: string): string | undefined => state.labels[optionId] ?? props.labels?.[optionId];
  /** The names of the given entries, for the owner to keep with the value. */
  const namesFor = (chosen: readonly { id: string }[]): Record<string, string> => {
    const names: Record<string, string> = {};
    for (const entry of chosen) {
      const name = nameOf(entry.id);
      if (name !== undefined) names[entry.id] = name;
    }
    return names;
  };
  const labelOf = (optionId: string) => nameOf(optionId) ?? optionId;
  const modeLabel = (mode: string) => props.picker.modes.find((entry) => entry.value === mode)?.label ?? mode;
  const defaultMode = () => props.picker.modes[0]?.value ?? "all";

  function commit(next: readonly { id: string; mode: string }[]) {
    props.onChange(formatEventCheckPickerValue(next), namesFor(next));
  }
  function choose(optionId: string, on: boolean, label?: string) {
    const current = entries() ?? [];
    if (on) {
      if (pickerLimitReached(current) && !current.some((entry) => entry.id === optionId)) return;
      if (label !== undefined)
        setState((draft) => {
          draft.labels[optionId] = label;
        });
      commit(withPickerEntry(current, optionId, modeOf().get(optionId) ?? defaultMode()));
    } else commit(withoutPickerEntry(current, optionId));
  }
  function setMode(optionId: string, mode: string) {
    // The select reports its value again when its row is updated. Writing it back would loop.
    if (modeOf().get(optionId) === mode) return;
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

  /** One tick each half minute, so "Loaded 3 minutes ago" moves while the field is open. */
  const [now, setNow] = createSignal(Date.now());
  const clock = window.setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => window.clearInterval(clock));
  const age = () => {
    const readAt = state.readAt;
    if (readAt === null) return "";
    const minutes = Math.floor(Math.max(0, now() - readAt) / 60_000);
    return minutes < 1
      ? t("agentSettings.eventCheck.picker.loadedNow")
      : t("agentSettings.eventCheck.picker.loadedAgo", { count: minutes });
  };

  async function load(refresh = false) {
    if (props.blocked || state.status === "loading" || props.disabled) return;
    const requested = ++generation;
    setState((draft) => {
      draft.status = "loading";
      draft.error = "";
    });
    try {
      const result = await props.load(refresh ? { refresh: true } : undefined);
      if (requested !== generation) return;
      setState((draft) => {
        draft.options = result.options;
        draft.truncated = result.truncated === true;
        draft.account = result.account?.label ?? "";
        draft.readAt = readTime(result);
        draft.stale = result.stale === true;
        draft.status = "loaded";
        draft.listed = true;
        for (const option of result.options) draft.labels[option.id] = option.label;
      });
      props.onLoaded?.(result);
      // A conversation that was renamed has its new name saved with the check from here on.
      const chosen = entries() ?? [];
      const listed = new Map(result.options.map((option) => [option.id, option.label]));
      if (chosen.some((entry) => listed.has(entry.id) && listed.get(entry.id) !== props.labels?.[entry.id]))
        props.onChange(props.value, namesFor(chosen));
    } catch (error) {
      if (requested !== generation) return;
      setState((draft) => {
        draft.status = "failed";
        draft.error = errorMessage(error, t("agentSettings.eventCheck.picker.failed"));
      });
    }
  }

  /** Names the chosen options that have no name with one call that asks for just those. */
  async function resolveNames(unnamed: string[]) {
    const resolve = props.resolve;
    if (!resolve) return;
    const requested = generation;
    try {
      const result = await resolve(unnamed);
      // A list that loaded meanwhile already has every name it can give.
      if (requested !== generation || state.listed) return;
      setState((draft) => {
        for (const option of result.options) draft.labels[option.id] = option.label;
      });
      const chosen = entries() ?? [];
      if (chosen.some((entry) => nameOf(entry.id) !== props.labels?.[entry.id]))
        props.onChange(props.value, namesFor(chosen));
    } catch {
      // Names are a convenience. The IDs stay, and Load still works.
    }
  }

  /**
   * Once, as soon as the field can ask: names the saved choices that have no name, with the cheap
   * call, and then loads the list when the owner allows it. The owner answers both from the host's
   * memory when it can. Neither runs while a list is on screen or while something blocks the field.
   */
  let started = false;
  createEffect(
    () => ({
      ready: entries() !== null && !props.blocked && !props.disabled && !state.listed && state.status === "idle",
      unnamed:
        props.resolve === undefined
          ? []
          : (entries() ?? []).filter((entry) => nameOf(entry.id) === undefined).map((entry) => entry.id),
      auto: props.autoLoad === true,
    }),
    ({ ready, unnamed, auto }) => {
      if (!ready || started || (unnamed.length === 0 && !auto)) return;
      started = true;
      void (async () => {
        if (unnamed.length > 0) await resolveNames(unnamed);
        if (auto) await load();
      })();
    },
  );

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
            onChange={(event) => choose(rowProps.option.id, event.currentTarget.checked, rowProps.option.label)}
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

  /** A chosen entry that has no row in the list: with its remembered name, or only its ID when none is known. */
  const ChosenRow = (rowProps: { entry: EventCheckPickerEntry }) => {
    const name = () => nameOf(rowProps.entry.id);
    const mode = createMemo(() => rowProps.entry.mode);
    return (
      <li class="event-check-picker-row">
        <span class="event-check-picker-name">
          <Show
            when={name()}
            fallback={
              <Text as="small" variant="caption" tone="muted">
                {rowProps.entry.id}
              </Text>
            }
          >
            {(label) => (
              <>
                <span>{label()}</span>
                <Show when={state.listed}>
                  <Text as="small" variant="caption" tone="muted">
                    {rowProps.entry.id}
                  </Text>
                </Show>
              </>
            )}
          </Show>
        </span>
        <ModeSelect optionId={rowProps.entry.id} mode={mode()} />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.disabled}
          aria-label={t("agentSettings.eventCheck.picker.remove", { name: labelOf(rowProps.entry.id) })}
          onClick={() => choose(rowProps.entry.id, false)}
        >
          <X aria-hidden="true" />
        </Button>
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
              onValueChange={(value) => props.onChange(value, props.labels ?? {})}
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
                onClick={() => void load(state.listed)}
              >
                <Show when={state.listed}>
                  <RefreshCw aria-hidden="true" />
                </Show>
                {state.listed
                  ? t("agentSettings.eventCheck.picker.reload")
                  : state.status === "failed"
                    ? t("common.tryAgain")
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
            <Show when={state.listed && state.readAt !== null}>
              <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                {age()}
              </Text>
            </Show>
            <Show when={state.listed && state.stale}>
              <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                {t("agentSettings.eventCheck.picker.stale")}
              </Text>
            </Show>
            <Show when={state.listed && state.account}>
              <Text as="p" variant="caption" tone="muted" class="event-check-picker-note">
                {t("agentSettings.eventCheck.picker.account", { name: state.account })}
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

            <Show when={state.listed}>
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

            <Show when={unlisted().length > 0}>
              <section class="event-check-picker-group" aria-label={t("agentSettings.eventCheck.picker.chosen")}>
                <h5 class="event-check-picker-group-title">{t("agentSettings.eventCheck.picker.chosen")}</h5>
                <Show when={unlisted().some((entry) => nameOf(entry.id) === undefined)}>
                  <Text as="small" variant="caption" tone="muted">
                    {t("agentSettings.eventCheck.picker.chosenHelp")}
                  </Text>
                </Show>
                <ul class="event-check-picker-list">
                  <For each={unlisted()} keyed={(entry) => entry.id}>
                    {(entry) => <ChosenRow entry={entry()} />}
                  </For>
                </ul>
              </section>
            </Show>
            <Show when={outside().length > 0}>
              <section class="event-check-picker-group" aria-label={t("agentSettings.eventCheck.picker.outside")}>
                <h5 class="event-check-picker-group-title">{t("agentSettings.eventCheck.picker.outside")}</h5>
                <Text as="small" variant="caption" tone="muted">
                  {t("agentSettings.eventCheck.picker.outsideHelp")}
                </Text>
                <ul class="event-check-picker-list">
                  <For each={outside()} keyed={(entry) => entry.id}>
                    {(entry) => <ChosenRow entry={entry()} />}
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
