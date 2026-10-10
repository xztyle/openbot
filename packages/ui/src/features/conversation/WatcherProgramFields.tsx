import type { EventCheckApiSource } from "@openbot/contracts/event-checks";
import { Input, Text, Textarea } from "@openbot/ui";
import { For, Show, snapshot } from "solid-js";
import { useText } from "../../text";
import { EventCheckPickerField } from "./EventCheckPickerField";
import type { PickerBinding } from "./event-check-picker";

export function WatcherProgramFields(props: {
  source: EventCheckApiSource;
  change(source: EventCheckApiSource): void;
  /** The settings that the template declares as pickers, by name. Any other setting is a text box. */
  pickers?: Record<string, PickerBinding> | undefined;
}) {
  const { t } = useText();
  const update = (fields: Partial<EventCheckApiSource>) => props.change({ ...snapshot(props.source), ...fields });
  return (
    <>
      <label class="settings-field">
        <span>{t("agentSettings.eventCheck.program")}</span>
        <Input
          class="event-check-code"
          value={props.source.toolName}
          placeholder={t("agentSettings.eventCheck.programPlaceholder")}
          onInput={(e) => update({ toolName: e.currentTarget.value })}
        />
      </label>
      <Text as="p" variant="caption" tone="muted" class="event-check-help">
        {t("agentSettings.eventCheck.programHelp")}
      </Text>
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
          <For each={props.source.configuration}>
            {(field) => (
              <Show
                when={props.pickers?.[field.name]}
                fallback={
                  <div class="event-check-config-field">
                    <label class="settings-field">
                      <span>{field.label}</span>
                      <Input
                        value={field.value}
                        maxlength={8192}
                        aria-describedby={field.description ? `event-check-config-${field.name}` : undefined}
                        onInput={(e) =>
                          update({
                            configuration: props.source.configuration.map((entry) =>
                              entry.name === field.name
                                ? { ...snapshot(entry), value: e.currentTarget.value }
                                : snapshot(entry),
                            ),
                          })
                        }
                      />
                    </label>
                    <Show when={field.description}>
                      <Text
                        as="small"
                        variant="caption"
                        tone="muted"
                        id={`event-check-config-${field.name}`}
                        class="event-check-field-help"
                      >
                        {field.description}
                      </Text>
                    </Show>
                  </div>
                }
              >
                {(binding) => (
                  <div class="event-check-config-field">
                    <EventCheckPickerField
                      label={field.label}
                      description={field.description}
                      picker={binding().picker}
                      value={field.value}
                      blocked={binding().blocked}
                      load={() => binding().load()}
                      onChange={(value) =>
                        props.change({
                          ...snapshot(props.source),
                          configuration: props.source.configuration.map((entry) =>
                            entry.name === field.name ? { ...snapshot(entry), value } : snapshot(entry),
                          ),
                        })
                      }
                    />
                  </div>
                )}
              </Show>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
