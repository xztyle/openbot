import type { EventCheckApiSource, EventCheckConfiguration } from "@openbot/contracts/event-checks";
import { Input, SettingsRow, Textarea } from "@openbot/ui";
import { For, Show, snapshot } from "solid-js";
import { useText } from "../../text";
import { EventCheckSettingField } from "./EventCheckSettingField";
import type { PickerBinding } from "./event-check-picker";

/** What the template of a check says about one of its settings, by name. */
export interface WatcherSettingKind {
  type: "text" | "boolean";
  required: boolean;
}

/**
 * The setting with a new value. A picker sends the names of its chosen options with the value; a
 * text box sends none, and the saved names stay (the host drops the ones whose ID left the value).
 */
function withValue(
  entry: EventCheckConfiguration,
  value: string,
  labels: Record<string, string> | undefined,
): EventCheckConfiguration {
  if (labels === undefined) return { ...entry, value };
  const { optionLabels: _names, ...rest } = entry;
  return Object.keys(labels).length > 0 ? { ...rest, value, optionLabels: labels } : { ...rest, value };
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
      <SettingsRow
        layout="stack"
        controlId="event-check-program"
        label={
          <>
            {t("agentSettings.eventCheck.program")}
            <span class="ui-field-required" aria-hidden="true">
              *
            </span>
          </>
        }
        description={t("agentSettings.eventCheck.programHelp")}
        help={props.programError ? <span class="event-check-field-error">{props.programError}</span> : undefined}
      >
        <Input
          id="event-check-program"
          class="event-check-code"
          aria-required="true"
          invalid={Boolean(props.programError)}
          value={props.source.toolName}
          placeholder={t("agentSettings.eventCheck.programPlaceholder")}
          onInput={(e) => update({ toolName: e.currentTarget.value })}
          onBlur={() => props.onProgramBlur?.()}
        />
      </SettingsRow>
      <SettingsRow
        layout="stack"
        controlId="event-check-api-account"
        label={t("agentSettings.eventCheck.accountLabel")}
      >
        <Input
          id="event-check-api-account"
          value={props.source.connectionId}
          onInput={(e) => update({ connectionId: e.currentTarget.value })}
        />
      </SettingsRow>
      <SettingsRow
        layout="stack"
        controlId="event-check-variable-names"
        label={t("agentSettings.eventCheck.variableNames")}
      >
        <Textarea
          id="event-check-variable-names"
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
      </SettingsRow>
      <Show when={props.source.configuration.length}>
        <SettingsRow
          label={t("agentSettings.eventCheck.configuration")}
          description={t("agentSettings.eventCheck.configurationHelp")}
        />
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
              labels={field().optionLabels}
              onChange={(value, labels) =>
                props.change({
                  ...snapshot(props.source),
                  configuration: props.source.configuration.map((entry) =>
                    entry.name === field().name ? withValue(snapshot(entry), value, labels) : snapshot(entry),
                  ),
                })
              }
            />
          )}
        </For>
      </Show>
    </>
  );
}
