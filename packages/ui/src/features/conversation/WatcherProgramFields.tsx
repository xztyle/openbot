import type { EventCheckApiSource } from "@openbot/contracts/event-checks";
import { Field, Input, Text, Textarea } from "@openbot/ui";
import { For, Show, snapshot } from "solid-js";
import { useText } from "../../text";
import { EventCheckSettingField } from "./EventCheckSettingField";
import type { PickerBinding } from "./event-check-picker";

/** What the template of a check says about one of its settings, by name. */
export interface WatcherSettingKind {
  type: "text" | "boolean";
  required: boolean;
}

export function WatcherProgramFields(props: {
  source: EventCheckApiSource;
  change(source: EventCheckApiSource): void;
  /** The settings that the template declares as pickers, by name. Any other setting is a text box. */
  pickers?: Record<string, PickerBinding> | undefined;
  /** The kind of each setting that the template declares, by name. Any other setting is a text box. */
  fields?: Record<string, WatcherSettingKind> | undefined;
  /** What is wrong with the program name, said under its field. */
  programError?: string | undefined;
  /** The program field lost focus: the owner may now say that it is empty. */
  onProgramBlur?(): void;
}) {
  const { t } = useText();
  const update = (fields: Partial<EventCheckApiSource>) => props.change({ ...snapshot(props.source), ...fields });
  return (
    <>
      <Field
        class="settings-field event-check-field"
        label={t("agentSettings.eventCheck.program")}
        description={t("agentSettings.eventCheck.programHelp")}
        required
        error={props.programError}
      >
        <Input
          class="event-check-code"
          value={props.source.toolName}
          placeholder={t("agentSettings.eventCheck.programPlaceholder")}
          onInput={(e) => update({ toolName: e.currentTarget.value })}
          onBlur={() => props.onProgramBlur?.()}
        />
      </Field>
      <label class="settings-field">
        <span>{t("agentSettings.eventCheck.accountLabel")}</span>
        <Input value={props.source.connectionId} onInput={(e) => update({ connectionId: e.currentTarget.value })} />
      </label>
      <label class="settings-field">
        <span>{t("agentSettings.eventCheck.variableNames")}</span>
        <Textarea
          class="event-check-code"
          value={props.source.variables.join("\n")}
          onInput={(e) =>
            update({
              variables: e.currentTarget.value
                .split("\n")
                .map((name) => name.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <Show when={props.source.configuration.length}>
        <div class="event-check-card">
          <h4>{t("agentSettings.eventCheck.configuration")}</h4>
          <Text as="p" variant="caption" tone="muted" class="event-check-help">
            {t("agentSettings.eventCheck.configurationHelp")}
          </Text>
          {/* Keyed by name: a change builds new entries, and a row that remounted would drop its list. */}
          <For each={props.source.configuration} keyed={(field) => field.name}>
            {(field) => (
              <EventCheckSettingField
                layout="panel"
                name={field().name}
                label={field().label}
                description={field().description}
                type={props.fields?.[field().name]?.type}
                required={props.fields?.[field().name]?.required}
                picker={props.pickers?.[field().name]}
                value={field().value}
                onChange={(value) =>
                  props.change({
                    ...snapshot(props.source),
                    configuration: props.source.configuration.map((entry) =>
                      entry.name === field().name ? { ...snapshot(entry), value } : snapshot(entry),
                    ),
                  })
                }
              />
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
