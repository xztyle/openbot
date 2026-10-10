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
   * Whether the install needs the setting. `false` marks the label as optional. Absent when the
   * template of the check is not known: the label is then shown without a marker.
   */
  required?: boolean | undefined;
  /** `boolean` settings hold the text `true` or `false` and are shown as a switch. */
  type?: "text" | "boolean" | undefined;
  value: string;
  onChange(value: string): void;
  disabled?: boolean | undefined;
  /** How to read the list of a setting that is a picker. Without it, the setting is a text box. */
  picker?: PickerBinding | undefined;
  /** `form` is a field of a dialog form. `panel` is a row of the settings panel. */
  layout?: "form" | "panel" | undefined;
  /** A long value is edited in a text area. Only the `form` layout has one. */
  multiline?: boolean | undefined;
  /** What is wrong with the value, said under the field. Only the `form` layout shows it. */
  error?: JSX.Element;
}

/** The label of a setting. A setting that the install does not need says so. */
function SettingLabel(props: { label: string; required: boolean | undefined }) {
  const { t } = useText();
  return (
    <>
      {props.label}
      <Show when={props.required === false}>
        {" "}
        <span class="marketplace-install-optional">{t("marketplace.eventCheck.optional")}</span>
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
  const label = () => <SettingLabel label={props.label} required={props.required} />;
  const panel = () => props.layout === "panel";
  return (
    <Switch>
      <Match when={props.type === "boolean"}>
        <Row panel={panel()}>
          <SwitchField
            class={panel() ? undefined : "marketplace-install-switch"}
            label={label()}
            description={props.description}
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
              label={label()}
              description={props.description}
              picker={binding().picker}
              value={props.value}
              disabled={props.disabled}
              blocked={binding().blocked}
              initial={binding().initial}
              onLoaded={(options) => binding().onLoaded?.(options)}
              load={() => binding().load()}
              onChange={props.onChange}
            />
          </Row>
        )}
      </Match>
      <Match when={panel()}>
        <div class="event-check-config-field">
          <label class="settings-field">
            <span>{label()}</span>
            <Input
              value={props.value}
              maxlength={8192}
              disabled={props.disabled}
              aria-describedby={props.description ? descriptionId() : undefined}
              onInput={(event) => props.onChange(event.currentTarget.value)}
            />
          </label>
          <Show when={props.description}>
            <Text as="small" variant="caption" tone="muted" id={descriptionId()} class="event-check-field-help">
              {props.description}
            </Text>
          </Show>
        </div>
      </Match>
      <Match when={true}>
        <Field label={label()} description={props.description} required={props.required} error={props.error}>
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
