import type { ComponentProps, JSX } from "@solidjs/web";
import { createContext, createSignal, createUniqueId, flush, omit, Show, useContext } from "solid-js";
import { cx } from "./utils";

export type ControlSize = "sm" | "md" | "lg";

interface ControlOptions {
  size?: ControlSize;
  invalid?: boolean;
}

export interface FieldContextValue {
  controlId: string;
  /* A field that only names its control leaves the rest unset. */
  describedBy?: string | undefined;
  invalid?: boolean;
  required?: boolean;
}

/** Lets a custom field frame hand its control an id for label association. */
export const FieldContext = createContext<FieldContextValue | null>(null);

/** What a limit note can say: how full the field is, and whether a paste lost its end. */
export interface LimitNoteState {
  length: number;
  max: number;
  /** The last paste was longer than the room left, so the browser cut its end. */
  cut: boolean;
}

interface TextControlOptions extends ControlOptions {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /**
   * Text under the field that tells the person about `maxlength`. It shows when the value is within
   * a tenth of the limit, and after a paste that lost its end, so text is never cut in silence.
   * Return `null` to stay quiet. A field with no `maxlength` shows nothing.
   */
  limitNote?: (state: LimitNoteState) => string | null;
}

type InputElementEvent<T extends HTMLInputElement | HTMLTextAreaElement> = Parameters<
  JSX.InputEventHandler<T, InputEvent>
>[0];
type PasteElementEvent<T extends HTMLInputElement | HTMLTextAreaElement> = Parameters<
  JSX.EventHandler<T, ClipboardEvent>
>[0];

/** How full the field must be before its note shows. */
const LIMIT_NOTE_FROM = 0.9;

/**
 * The state behind `limitNote`. The browser cuts a value at `maxlength` without a word, so this
 * reads the paste that would overflow, and the length after each input.
 */
function createLimitNote(options: {
  maxlength: () => unknown;
  length: () => number | null;
  note: () => ((state: LimitNoteState) => string | null) | undefined;
}) {
  const id = createUniqueId();
  const [typedLength, setTypedLength] = createSignal<number | null>(null);
  const [cut, setCut] = createSignal(false);
  let pasteCuts = false;
  const max = () => {
    const value = Number(options.maxlength());
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const length = () => options.length() ?? typedLength() ?? 0;
  const text = () => {
    const limit = max();
    const build = options.note();
    if (limit === undefined || !build) return null;
    const current = length();
    if (!cut() && current < limit * LIMIT_NOTE_FROM) return null;
    return build({ length: current, max: limit, cut: cut() });
  };
  return {
    id,
    text,
    active: () => options.note() !== undefined && max() !== undefined,
    describedBy: () => (text() ? id : undefined),
    paste(element: HTMLInputElement | HTMLTextAreaElement, pasted: string) {
      const limit = max();
      if (limit === undefined) return;
      const selected = Math.abs((element.selectionEnd ?? 0) - (element.selectionStart ?? 0));
      pasteCuts = element.value.length - selected + pasted.length > limit;
    },
    input(element: HTMLInputElement | HTMLTextAreaElement) {
      setTypedLength(element.value.length);
      // The input event of a paste comes right after its paste event. A later keystroke clears the note.
      setCut(pasteCuts);
      pasteCuts = false;
    },
  };
}

function LimitNote(props: { limit: ReturnType<typeof createLimitNote> }): JSX.Element {
  return (
    <Show when={props.limit.text()}>
      {(text) => (
        <small id={props.limit.id} class="ui-field-limit" role="status">
          {text()}
        </small>
      )}
    </Show>
  );
}

export type InputProps = ComponentProps<"input"> & TextControlOptions;

/** Input types where a keystroke edits the text. Password is not here: bind() skips it. */
const TYPED_INPUT_TYPES = new Set<string>(["text", "search", "email", "url", "tel", "number"]);

export function Input(props: InputProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const inputProps = omit(
    props,
    "class",
    "size",
    "invalid",
    "id",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
    "required",
    "onValueChange",
    "onInput",
    "onPaste",
    "limitNote",
    "value",
    "defaultValue",
  );
  const limit = createLimitNote({
    maxlength: () => local.maxlength,
    length: () => ("value" in props ? (local.value ?? "").length : null),
    note: () => local.limitNote,
  });
  const describedBy = () =>
    [local["aria-describedby"], field?.describedBy, limit.describedBy()].filter(Boolean).join(" ") || undefined;
  const handleInput = (event: InputElementEvent<HTMLInputElement>) => {
    limit.input(event.currentTarget);
    if (local.onValueChange) flush(() => local.onValueChange?.(event.currentTarget.value));
    else if (typeof local.onInput === "function") local.onInput(event);
  };
  const handlePaste = (event: PasteElementEvent<HTMLInputElement>) => {
    limit.paste(event.currentTarget, event.clipboardData?.getData("text") ?? "");
    if (typeof local.onPaste === "function") local.onPaste(event);
  };
  // A text field plays a keystroke cue. A radio plays select when its value changes.
  const typeCue = () => {
    const type = local.type;
    return type === undefined || (typeof type === "string" && TYPED_INPUT_TYPES.has(type)) ? "" : undefined;
  };
  const selectCue = () => (local.type === "radio" ? "" : undefined);
  const wired = () => limit.active();
  if (!("value" in props)) {
    return (
      <>
        <input
          data-cuelume-type={typeCue()}
          data-cuelume-select={selectCue()}
          {...inputProps}
          defaultValue={local.defaultValue}
          class={cx("ui-input", local.class)}
          data-size={local.size ?? "md"}
          id={local.id ?? field?.controlId}
          aria-label={local["aria-label"]}
          aria-labelledby={local["aria-labelledby"]}
          aria-describedby={describedBy()}
          aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
          required={local.required ?? field?.required}
          onPaste={wired() ? handlePaste : local.onPaste}
          onInput={wired() || local.onValueChange ? handleInput : local.onInput}
        />
        <LimitNote limit={limit} />
      </>
    );
  }
  return (
    <>
      <input
        data-cuelume-type={typeCue()}
        data-cuelume-select={selectCue()}
        {...inputProps}
        value={local.value}
        class={cx("ui-input", local.class)}
        data-size={local.size ?? "md"}
        id={local.id ?? field?.controlId}
        aria-label={local["aria-label"]}
        aria-labelledby={local["aria-labelledby"]}
        aria-describedby={describedBy()}
        aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
        required={local.required ?? field?.required}
        onPaste={wired() ? handlePaste : local.onPaste}
        onInput={wired() || local.onValueChange ? handleInput : local.onInput}
      />
      <LimitNote limit={limit} />
    </>
  );
}

export type TextareaProps = ComponentProps<"textarea"> & TextControlOptions;

export function Textarea(props: TextareaProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const textareaProps = omit(
    props,
    "class",
    "size",
    "invalid",
    "id",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
    "required",
    "onValueChange",
    "onInput",
    "onPaste",
    "limitNote",
    "value",
    "defaultValue",
  );
  const limit = createLimitNote({
    maxlength: () => local.maxlength,
    length: () => ("value" in props ? (local.value ?? "").length : null),
    note: () => local.limitNote,
  });
  const describedBy = () =>
    [local["aria-describedby"], field?.describedBy, limit.describedBy()].filter(Boolean).join(" ") || undefined;
  const handleInput = (event: InputElementEvent<HTMLTextAreaElement>) => {
    limit.input(event.currentTarget);
    if (local.onValueChange) flush(() => local.onValueChange?.(event.currentTarget.value));
    else if (typeof local.onInput === "function") local.onInput(event);
  };
  const handlePaste = (event: PasteElementEvent<HTMLTextAreaElement>) => {
    limit.paste(event.currentTarget, event.clipboardData?.getData("text") ?? "");
    if (typeof local.onPaste === "function") local.onPaste(event);
  };
  const wired = () => limit.active();
  if (!("value" in props)) {
    return (
      <>
        <textarea
          data-cuelume-type=""
          {...textareaProps}
          defaultValue={local.defaultValue}
          class={cx("ui-textarea", local.class)}
          data-size={local.size ?? "md"}
          id={local.id ?? field?.controlId}
          aria-label={local["aria-label"]}
          aria-labelledby={local["aria-labelledby"]}
          aria-describedby={describedBy()}
          aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
          required={local.required ?? field?.required}
          onPaste={wired() ? handlePaste : local.onPaste}
          onInput={wired() || local.onValueChange ? handleInput : local.onInput}
        />
        <LimitNote limit={limit} />
      </>
    );
  }
  return (
    <>
      <textarea
        data-cuelume-type=""
        {...textareaProps}
        value={local.value}
        class={cx("ui-textarea", local.class)}
        data-size={local.size ?? "md"}
        id={local.id ?? field?.controlId}
        aria-label={local["aria-label"]}
        aria-labelledby={local["aria-labelledby"]}
        aria-describedby={describedBy()}
        aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
        required={local.required ?? field?.required}
        onPaste={wired() ? handlePaste : local.onPaste}
        onInput={wired() || local.onValueChange ? handleInput : local.onInput}
      />
      <LimitNote limit={limit} />
    </>
  );
}

export type NativeSelectProps = ComponentProps<"select"> & ControlOptions;

export function NativeSelect(props: NativeSelectProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const others = omit(props, "class", "size", "invalid", "id", "aria-describedby", "aria-invalid", "required");
  const describedBy = () => [local["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <select
      data-cuelume-select=""
      {...others}
      class={cx("ui-native-select", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
    />
  );
}

export function Label(props: ComponentProps<"label">): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const others = omit(props, "class", "children", "for");
  return (
    <label class={cx("ui-label", local.class)} for={local.for ?? field?.controlId} {...others}>
      {local.children}
    </label>
  );
}

export interface FieldProps extends JSX.HTMLAttributes<HTMLDivElement> {
  label: JSX.Element;
  description?: JSX.Element;
  error?: JSX.Element;
  required?: boolean;
  htmlFor?: string;
}

export function Field(props: FieldProps): JSX.Element {
  const generatedId = createUniqueId();
  const local = props;
  const others = omit(props, "class", "children", "label", "description", "error", "required", "htmlFor");
  const descriptionId = `${generatedId}-description`;
  const errorId = `${generatedId}-error`;
  const fieldValue: FieldContextValue = {
    controlId: local.htmlFor ?? `${generatedId}-control`,
    get describedBy() {
      return local.error ? errorId : local.description ? descriptionId : undefined;
    },
    get invalid() {
      return Boolean(local.error);
    },
    get required() {
      return Boolean(local.required);
    },
  };
  return (
    <FieldContext value={fieldValue}>
      <div class={cx("ui-field", local.class)} data-invalid={local.error ? "" : undefined} {...others}>
        <Label>
          {local.label}
          <Show when={local.required}>
            <span class="ui-field-required" aria-hidden="true">
              *
            </span>
          </Show>
        </Label>
        {local.children}
        <Show when={local.description}>
          <div id={descriptionId} class="ui-field-description">
            {local.description}
          </div>
        </Show>
        <Show when={local.error}>
          <div id={errorId} class="ui-field-error" role="alert">
            {local.error}
          </div>
        </Show>
      </div>
    </FieldContext>
  );
}
