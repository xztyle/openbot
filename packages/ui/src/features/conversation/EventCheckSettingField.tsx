import { Field, Input, SwitchField, Text, Textarea } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { EventCheckPickerField } from "./EventCheckPickerField";
import type { PickerBinding } from "./event-check-picker";

export interface EventCheckSettingFieldProps {
  /** The name of the setting. It makes the ids of the help text. */
  name: string;
  label: string;
  description: string;
  /**
   * Whether the install needs the setting. `true` marks the label with `*` and `false` marks it as
   * optional. A switch has no marker: it always holds a value. Absent when the template of the check
   * is not known: the label is then shown without a marker.
   */
  required?: boolean | undefined;
  /** `boolean` settings hold the text `true` or `false` and are shown as a switch. */
  type?: "text" | "boolean" | undefined;
  value: string;
  /** The saved names of the chosen options of a picker, by ID. */
  labels?: Record<string, string> | undefined;
  /** The names come with a picker's value: the choices that the person made, and the names they had. */
  onChange(value: string, labels?: Record<string, string>): void;
  disabled?: boolean | undefined;
  /** How to read the list of a setting that is a picker. Without it, the setting is a text box. */
  picker?: PickerBinding | undefined;
  /** `form` is a field of a dialog form. `panel` is a row of the settings panel. */
  layout?: "form" | "panel" | undefined;
  /** A long value is edited in a text area. Only the `form` layout has one. */
  multiline?: boolean | undefined;
  /** What is wrong with the value, said under the field. Only the `form` layout shows it. */
  error?: JSX.Element;
  /** The id of the text box of the `form` layout, so the owner can move focus to it. */
  controlId?: string | undefined;
}

/** `Optional. Pick a channel.` says it twice when the label already carries the chip. */
function withoutOptionalWord(description: string): string {
  return description.replace(/^optional[.:]\s+/iu, "");
}

/** `Labels (optional)` says it twice when the label already carries the chip. */
function withoutOptionalSuffix(label: string): string {
  return label.replace(/\s*\(optional\)\s*$/iu, "");
}

/**
 * The label of a setting: `*` for a setting that the install needs, and a chip for one that it does
 * not. `marker` is off where a `Field` draws the `*` itself.
 */
function SettingLabel(props: { label: string; required: boolean | undefined; marker: boolean }) {
  const { t } = useText();
  return (
    <>
      {props.required === false ? withoutOptionalSuffix(props.label) : props.label}
      <Show when={props.required === false}>
        {" "}
        <span class="marketplace-install-optional">{t("marketplace.eventCheck.optional")}</span>
      </Show>
      <Show when={props.required === true && props.marker}>
        <span class="ui-field-required" aria-hidden="true">
          *
        </span>
      </Show>
    </>
  );
}

/** A row of the settings panel groups a setting with its help. A dialog form lays its own fields out. */
function Row(props: { panel: boolean; children: JSX.Element }) {
  return (
    <Show when={props.panel} fallback={props.children}>
      <div class="event-check-config-field">{props.children}</div>
    </Show>
  );
}

/**
 * One setting of an event check as the person edits it: a switch for a true-or-false setting, a list
 * to choose from for a picker, or a text box. The install dialog and the check editor both use it,
 * so a setting looks and works the same where it is first filled in and where it is changed.
 */
export function EventCheckSettingField(props: EventCheckSettingFieldProps) {
  const descriptionId = () => `event-check-config-${props.name}`;
  const isSwitch = () => props.type === "boolean";
  // A switch is never marked: it holds a value whether or not the person touches it.
  const mark = () => (isSwitch() ? undefined : props.required);
  const label = (marker: boolean) => <SettingLabel label={props.label} required={mark()} marker={marker} />;
  const description = () => (mark() === false ? withoutOptionalWord(props.description) : props.description);
  const panel = () => props.layout === "panel";
  return (
    <Switch>
      <Match when={props.type === "boolean"}>
        <Row panel={panel()}>
          <SwitchField
            class={panel() ? undefined : "marketplace-install-switch"}
            label={label(true)}
            description={description()}
            checked={props.value === "true"}
            disabled={props.disabled}
            onChange={(on) => props.onChange(on ? "true" : "false")}
          />
        </Row>
      </Match>
      <Match when={props.picker}>
        {(binding) => (
          <Row panel={panel()}>
            <EventCheckPickerField
              label={label(true)}
              description={description()}
              picker={binding().picker}
              value={props.value}
              labels={props.labels}
              disabled={props.disabled}
              blocked={binding().blocked}
              initial={binding().initial}
              onLoaded={(options) => binding().onLoaded?.(options)}
              load={(options) => binding().load(options)}
              resolve={binding().resolve}
              autoLoad={binding().autoLoad}
              onChange={(value, labels) => props.onChange(value, labels)}
            />
          </Row>
        )}
      </Match>
      <Match when={panel()}>
        <div class="event-check-config-field">
          <label class="settings-field">
            <span>{label(true)}</span>
            <Input
              value={props.value}
              maxlength={8192}
              required={props.required === true}
              disabled={props.disabled}
              aria-describedby={description() ? descriptionId() : undefined}
              onInput={(event) => props.onChange(event.currentTarget.value)}
            />
          </label>
          <Show when={description()}>
            <Text as="small" variant="caption" tone="muted" id={descriptionId()} class="event-check-field-help">
              {description()}
            </Text>
          </Show>
        </div>
      </Match>
      <Match when={true}>
        <Field
          label={label(false)}
          description={description()}
          required={props.required === true}
          htmlFor={props.controlId}
          error={props.error}
        >
          <Show
            when={props.multiline}
            fallback={
              <Input value={props.value} maxlength={8192} disabled={props.disabled} onValueChange={props.onChange} />
            }
          >
            <Textarea value={props.value} maxlength={8192} disabled={props.disabled} onValueChange={props.onChange} />
          </Show>
        </Field>
      </Match>
    </Switch>
  );
}
