import type { JSX } from "@solidjs/web";
import { createUniqueId, omit, Show } from "solid-js";
import { Monitor } from "./icons";
import { useText } from "./text";
import { Heading, Text } from "./typography";
import { cx } from "./utils";

export interface SettingsSectionProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "title"> {
  title: JSX.Element;
  description?: JSX.Element;
  actions?: JSX.Element;
}

export function SettingsSection(props: SettingsSectionProps): JSX.Element {
  const headingId = `settings-section-${createUniqueId()}`;
  const others = omit(props, "class", "title", "description", "actions", "children");

  return (
    <section class={cx("ui-settings-section", props.class)} aria-labelledby={headingId} {...others}>
      <div class="ui-settings-section-header">
        <div class="ui-settings-section-copy">
          <Heading id={headingId} class="ui-settings-section-heading" as="h3" size="sm" tone="secondary">
            {props.title}
          </Heading>
          <Show when={props.description}>
            <Text class="ui-settings-section-description" variant="caption" tone="muted">
              {props.description}
            </Text>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="ui-settings-section-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

export interface SettingsGroupProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "title"> {
  /** The name of the group, above its card. Without one, `label` names the region for a screen reader. */
  title?: JSX.Element;
  description?: JSX.Element;
  label?: string;
  /** Controls beside the title, such as a Save button. */
  actions?: JSX.Element;
}

/**
 * A card of settings rows under one name: a section holds one or more groups. The rows inside draw
 * the lines between themselves; the group gives them the card and the heading that tells them apart
 * from the rows of the next group.
 */
export function SettingsGroup(props: SettingsGroupProps): JSX.Element {
  const headingId = `settings-group-${createUniqueId()}`;
  const others = omit(props, "class", "title", "description", "label", "actions", "children");
  return (
    <section
      class={cx("ui-settings-group", props.class)}
      aria-labelledby={props.title ? headingId : undefined}
      aria-label={props.title ? undefined : props.label}
      {...others}
    >
      <Show when={props.title || props.actions}>
        <div class="ui-settings-group-header">
          <div class="ui-settings-group-copy">
            <Show when={props.title}>
              <Heading id={headingId} class="ui-settings-group-heading" as="h4" size="sm">
                {props.title}
              </Heading>
            </Show>
            <Show when={props.description}>
              <Text class="ui-settings-group-description" variant="caption" tone="muted">
                {props.description}
              </Text>
            </Show>
          </div>
          <Show when={props.actions}>
            <div class="ui-settings-group-actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      <div class="ui-settings-group-card settings-modal-card">{props.children}</div>
    </section>
  );
}

export interface SettingsRowProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "title"> {
  /** What the row sets. */
  label: JSX.Element;
  /** What it does, in a line under the label. */
  description?: JSX.Element;
  /** A note under the description, such as an error or a hint. */
  help?: JSX.Element;
  /** The id the control should take, so the label names it. */
  controlId?: string;
  /**
   * `inline`: the control stays beside the label on a phone too (a switch, a short value).
   * `stack`: the control goes under the label at every width (a long field, a list).
   * Without one, the control is beside the label on a computer and under it on a phone.
   */
  layout?: "inline" | "stack";
  /** The control on the right. A row with none shows only its text. */
  children?: JSX.Element;
}

/** One setting: its name and what it does on the left, the control that changes it on the right. */
export function SettingsRow(props: SettingsRowProps): JSX.Element {
  const labelId = `settings-row-${createUniqueId()}`;
  const others = omit(props, "class", "label", "description", "help", "controlId", "layout", "children");
  return (
    <div class={cx("ui-settings-row", props.class)} data-layout={props.layout} {...others}>
      <div class="ui-settings-row-copy">
        <Show
          when={props.controlId}
          fallback={
            <span id={labelId} class="ui-settings-row-label">
              {props.label}
            </span>
          }
        >
          {(controlId) => (
            <label id={labelId} class="ui-settings-row-label" for={controlId()}>
              {props.label}
            </label>
          )}
        </Show>
        <Show when={props.description}>
          <span class="ui-settings-row-description">{props.description}</span>
        </Show>
        <Show when={props.help}>
          <span class="ui-settings-row-help">{props.help}</span>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="ui-settings-row-control">{props.children}</div>
      </Show>
    </div>
  );
}

/** A line between two parts of one row group that do not share a card edge. */
export function SettingsDivider(props: { class?: string }): JSX.Element {
  return <hr class={cx("ui-settings-divider", props.class)} />;
}

/** A short explanation under a group or a row: what a choice means, or where a value comes from. */
export function SettingsHelp(props: { class?: string; children: JSX.Element }): JSX.Element {
  return (
    <Text class={cx("ui-settings-help", props.class)} variant="caption" tone="muted">
      {props.children}
    </Text>
  );
}

/** The note on a setting that this browser or computer keeps for itself: "Only on this device". */
export function SettingsDeviceNote(props: { class?: string }): JSX.Element {
  const { t } = useText();
  return (
    <span class={cx("ui-settings-device-note", props.class)}>
      <Monitor aria-hidden="true" />
      {t("settings.deviceOnly")}
    </span>
  );
}
