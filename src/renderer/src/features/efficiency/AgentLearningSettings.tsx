import {
  addedLines,
  type ForgetConversationResult,
  removedLines,
  type SettingsCheckpoint,
  type SettingsField,
  type SettingsFieldChange,
} from "@openbot/contracts/agent-learning";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Text } from "@openbot/ui";
import { SettingsField as Field } from "@openbot/ui/components/SettingsPanel";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { EfficiencyCalls } from "./efficiency-port";
import "./efficiency.css";

const FIELD_TEXT = {
  name: "efficiency.history.field.name",
  title: "efficiency.history.field.title",
  instructions: "efficiency.history.field.instructions",
  provider: "efficiency.history.field.provider",
  model: "efficiency.history.field.model",
  reasoningEffort: "efficiency.history.field.reasoningEffort",
  modelPolicy: "efficiency.history.field.modelPolicy",
  playbookRole: "efficiency.history.field.playbookRole",
  access: "efficiency.history.field.access",
  computerUse: "efficiency.history.field.computerUse",
  backupModels: "efficiency.history.field.backupModels",
} as const satisfies Record<Exclude<SettingsField, "skill" | "playbook">, AppTextKey>;

/** Long texts show as their added and removed lines; short values as before → after. */
const TEXT_FIELDS = new Set<SettingsField>(["instructions", "skill", "playbook"]);

/**
 * What an agent learned and how its settings changed: the checkpoints of its settings with their
 * author and a one-tap rollback, a memory cleanup on demand, and the forget of what it learned in its
 * current chat. It needs the host's learning routes, which an owner or admin has.
 */
export function AgentLearningSettings(props: {
  agentId: string;
  calls: EfficiencyCalls;
  agentName(agentId: string): string;
}) {
  const { t, format, errorMessage } = useText();
  const [checkpoints, setCheckpoints] = createSignal<SettingsCheckpoint[] | null>(null);
  const [open, setOpen] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Only the cleanup says it is running; a rollback or a forget keeps its label.
  const [dreaming, setDreaming] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [forget, setForget] = createSignal<ForgetConversationResult | null>(null);
  let generation = 0;
  onCleanup(() => {
    generation += 1;
  });

  function reload(agentId: string): void {
    const current = ++generation;
    props.calls.settingsHistory(agentId).then(
      (list) => {
        if (generation === current) setCheckpoints(list);
      },
      () => {
        if (generation === current) setCheckpoints([]);
      },
    );
  }

  createEffect(
    () => props.agentId,
    (agentId) => {
      setCheckpoints(null);
      setForget(null);
      setNote(null);
      setError(null);
      reload(agentId);
    },
  );

  async function run(work: () => Promise<string | null>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(await work());
    } catch (failure) {
      setError(errorMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  const author = (checkpoint: SettingsCheckpoint) =>
    checkpoint.rollbackOf
      ? t("efficiency.history.rollbackOf")
      : checkpoint.author.kind === "agent"
        ? t("efficiency.history.by.agent", { agent: props.agentName(checkpoint.author.agentId ?? "") })
        : checkpoint.author.kind === "improver"
          ? t("efficiency.history.by.improver")
          : t("efficiency.history.by.owner");
  const fieldName = (change: SettingsFieldChange) =>
    change.field === "skill"
      ? t("efficiency.history.field.skill", { name: change.label ?? "" })
      : change.field === "playbook"
        ? t("efficiency.history.field.playbook", { name: change.label ?? "" })
        : t(FIELD_TEXT[change.field]);
  const diff = (change: SettingsFieldChange) =>
    TEXT_FIELDS.has(change.field)
      ? [
          ...removedLines(change.before, change.after).map((line) => `- ${line}`),
          ...addedLines(change.before, change.after).map((line) => `+ ${line}`),
        ].join("\n")
      : `${change.before ?? t("efficiency.history.unset")} → ${change.after ?? t("efficiency.history.unset")}`;

  return (
    <>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <Show when={note()}>{(message) => <Text tone="muted">{message()}</Text>}</Show>
      <Field label={t("efficiency.history.title")}>
        <Show when={checkpoints()}>
          {(list) => (
            <Show when={list().length > 0} fallback={<Text tone="muted">{t("efficiency.history.empty")}</Text>}>
              <For each={list().slice(0, 10)} keyed={(checkpoint) => checkpoint.id}>
                {(checkpoint) => (
                  <div class="efficiency-review">
                    <div class="efficiency-review-head">
                      <strong>{checkpoint().changes.map(fieldName).join(", ")}</strong>
                      <Text tone="muted">{author(checkpoint())}</Text>
                      <Text tone="muted">
                        {format.date(Date.parse(checkpoint().at), { dateStyle: "medium", timeStyle: "short" })}
                      </Text>
                    </div>
                    <Show when={open() === checkpoint().id}>
                      <For each={checkpoint().changes}>
                        {(change) => (
                          <>
                            <Text tone="muted">{fieldName(change)}</Text>
                            <pre class="efficiency-diff">{diff(change)}</pre>
                          </>
                        )}
                      </For>
                    </Show>
                    <div class="efficiency-actions">
                      <Button
                        variant="ghost"
                        onClick={() => setOpen((current) => (current === checkpoint().id ? null : checkpoint().id))}
                      >
                        {t("efficiency.history.show")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy()}
                        onClick={() =>
                          void run(async () => {
                            await props.calls.rollback(checkpoint().id);
                            reload(props.agentId);
                            return t("efficiency.history.rolledBack");
                          }, t("efficiency.history.rollbackFailed"))
                        }
                      >
                        {t("efficiency.history.rollback")}
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          )}
        </Show>
      </Field>
      <div class="efficiency-actions">
        <Button
          variant="ghost"
          disabled={busy()}
          onClick={() =>
            void run(async () => {
              setDreaming(true);
              try {
                const items = await props.calls.dream(props.agentId);
                return t("efficiency.learning.dreamDone", { count: items.length });
              } finally {
                setDreaming(false);
              }
            }, t("efficiency.learning.dreamFailed"))
          }
        >
          {dreaming() ? t("efficiency.learning.dreamRunning") : t("efficiency.learning.dream")}
        </Button>
        <Show
          when={forget()}
          fallback={
            <Button
              variant="ghost"
              disabled={busy()}
              onClick={() =>
                void run(async () => {
                  const found = await props.calls.forgetConversation(props.agentId, false);
                  if (found.memories.length + found.facts.length === 0) return t("efficiency.learning.forgetNothing");
                  setForget(found);
                  return null;
                }, t("efficiency.learning.forgetFailed"))
              }
            >
              {t("efficiency.learning.forget")}
            </Button>
          }
        >
          {(found) => (
            <Button
              variant="destructive"
              disabled={busy()}
              onClick={() =>
                void run(async () => {
                  const done = await props.calls.forgetConversation(props.agentId, true);
                  setForget(null);
                  return t("efficiency.learning.forgotten", { count: done.forgotten });
                }, t("efficiency.learning.forgetFailed"))
              }
            >
              {t("efficiency.learning.forgetConfirm", { count: found().memories.length + found().facts.length })}
            </Button>
          )}
        </Show>
      </div>
      <Show when={forget()}>
        {(found) => (
          <ul class="efficiency-changes">
            <For each={[...found().memories.map((item) => item.text), ...found().facts.map((item) => item.text)]}>
              {(text) => (
                <li>
                  <Text>{text}</Text>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <Text tone="muted">{t("efficiency.learning.forgetHint")}</Text>
    </>
  );
}
