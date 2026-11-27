import type { JSX } from "@solidjs/web";
import { createContext, createSignal, createUniqueId, omit, onSettled, Show, useContext } from "solid-js";
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

/**
 * One text form inside a settings surface that saves through the surface's one save bar: whether
 * it holds a change, how to store it, and how to put the stored value back.
 */
export interface SettingsDraft {
  dirty: () => boolean;
  /** Stores the change. A failure throws, and the bar shows why. */
  save: () => Promise<void>;
  reset: () => void;
}

/** The text forms of one settings surface, saved and reset together by its save bar. */
export interface SettingsDrafts {
  register: (draft: SettingsDraft) => () => void;
  dirty: () => boolean;
  saving: () => boolean;
  /** Why the last save failed, until the next save or reset. */
  error: () => string | null;
  /** Saves every draft with a change, one after another. False when one failed. */
  save: () => Promise<boolean>;
  reset: () => void;
}

/**
 * The registry behind a settings surface's save bar (docs/ux/standard.md § 5): switches and
 * selects save at once; text fields register here and save with the bar.
 */
export function createSettingsDrafts(failureText: (error: unknown) => string): SettingsDrafts {
  const [drafts, setDrafts] = createSignal<readonly SettingsDraft[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const dirty = () => drafts().some((draft) => draft.dirty());
  return {
    register(draft) {
      setDrafts((list) => [...list, draft]);
      return () => setDrafts((list) => list.filter((item) => item !== draft));
    },
    dirty,
    saving,
    error: () => (dirty() ? error() : null),
    async save() {
      if (saving()) return false;
      setSaving(true);
      setError(null);
      try {
        for (const draft of drafts()) {
          if (!draft.dirty()) continue;
          try {
            await draft.save();
          } catch (failure) {
            setError(failureText(failure));
            return false;
          }
        }
        return true;
      } finally {
        setSaving(false);
      }
    },
    reset() {
      setError(null);
      for (const draft of drafts()) if (draft.dirty()) draft.reset();
    },
  };
}

/** The save bar registry of the settings surface around a form. */
export const SettingsDraftsContext = createContext<SettingsDrafts | null>(null);

/**
 * Registers a text form with the save bar of the surface around it, for as long as the form is on
 * screen. Returns the registry, so Enter in a field can save, or null outside a surface with a bar.
 */
export function useSettingsDraft(draft: SettingsDraft): SettingsDrafts | null {
  const drafts = useContext(SettingsDraftsContext);
  // After the mount: the list is a signal, and the component body is no place to write one.
  if (drafts) onSettled(() => drafts.register(draft));
  return drafts;
}

/** Enter in a one-line field of a surface with a save bar saves, as a form's submit does. */
export function saveOnEnter(drafts: SettingsDrafts | null): (event: KeyboardEvent) => void {
  return (event) => {
    if (!drafts || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void drafts.save();
  };
}
