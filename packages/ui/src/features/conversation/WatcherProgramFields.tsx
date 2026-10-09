import type { EventCheckApiSource } from "@openbot/contracts/event-checks";
import { Input, Textarea } from "@openbot/ui";
import { For, snapshot } from "solid-js";
import { useText } from "../../text";

export function WatcherProgramFields(props: {
  source: EventCheckApiSource;
  change(source: EventCheckApiSource): void;
}) {
  const { t } = useText();
  const update = (fields: Partial<EventCheckApiSource>) => props.change({ ...snapshot(props.source), ...fields });
  return (
    <section>
      <label>
        {t("agentSettings.eventCheck.program")}
        <Input
          value={props.source.toolName}
          placeholder={t("agentSettings.eventCheck.programPlaceholder")}
          onInput={(e) => update({ toolName: e.currentTarget.value })}
        />
      </label>
      <p>{t("agentSettings.eventCheck.programHelp")}</p>
      <label>
        {t("agentSettings.eventCheck.accountLabel")}
        <Input value={props.source.connectionId} onInput={(e) => update({ connectionId: e.currentTarget.value })} />
      </label>
      <label>
        {t("agentSettings.eventCheck.variableNames")}
        <Textarea
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
      <h3>{t("agentSettings.eventCheck.configuration")}</h3>
      <p>{t("agentSettings.eventCheck.configurationHelp")}</p>
      <For each={props.source.configuration}>
        {(field) => (
          <div>
            <label>
              {field.label}
              <Input
                value={field.value}
                maxlength={8192}
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
            <small>{field.description}</small>
          </div>
        )}
      </For>
    </section>
  );
}
