import {
  addedLines,
  type ForgetConversationResult,
  removedLines,
  type SettingsCheckpoint,
  type SettingsField,
  type SettingsFieldChange,
} from "@openbot/contracts/agent-learning";
import type { AppTextKey } from "@openbot/i18n";
import { Button, ConfirmDialog, SettingsGroup, SettingsRow, SettingsSection } from "@openbot/ui";
import { SettingsLinkRow } from "@openbot/ui/components/SettingsPanel";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
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

/** A note or a failure under the row it belongs to. */
function RowNote(props: { note: string | null; error: string | null }): JSX.Element {
  return (
    <>
      <Show when={props.error}>
        {(message) => (
          <span class="agent-settings-save-error" role="alert">
            {message()}
          </span>
        )}
      </Show>
      <Show when={props.note}>{(message) => <span role="status">{message()}</span>}</Show>
    </>
  );
}

/**
 * The Memory section of an agent's settings: what it remembers (a link to its memories), a memory
 * cleanup on demand, and the forget of what it learned in its current chat, which asks first. The
 * cleanup and the forget need the host's learning routes, which an owner or admin has.
 */
export function AgentMemorySection(props: {
  agentId: string;
  calls?: EfficiencyCalls | undefined;
  /** The memories link, where the host has memories. */
  memories?: { count: number; open: () => void } | undefined;
}) {
  const { t, errorMessage } = useText();
  const [busy, setBusy] = createSignal(false);
  const [dreaming, setDreaming] = createSignal(false);
  const [note, setNote] = createSignal<{ row: "dream" | "forget"; text: string } | null>(null);
  const [error, setError] = createSignal<{ row: "dream" | "forget"; text: string } | null>(null);
  const [forget, setForget] = createSignal<ForgetConversationResult | null>(null);

  createEffect(
    () => props.agentId,
    () => {
      setForget(null);
      setNote(null);
      setError(null);
    },
  );

  /**
   * Runs one action for the agent that shows now. Its note, error and found items belong to that
   * agent: when the panel moved to another agent meanwhile, they are dropped, so a forget never
   * lists one agent's memories over the confirm button of another.
   */
  async function run(
    row: "dream" | "forget",
    work: (agentId: string, calls: EfficiencyCalls) => Promise<string | null>,
    fallback: string,
  ): Promise<void> {
    const calls = props.calls;
    if (!calls) return;
    const agentId = props.agentId;
    const current = () => props.agentId === agentId;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const done = await work(agentId, calls);
      if (current() && done) setNote({ row, text: done });
    } catch (failure) {
      if (current()) setError({ row, text: errorMessage(failure, fallback) });
    } finally {
      setBusy(false);
    }
  }

  const rowNote = (row: "dream" | "forget") => (
    <RowNote
      note={note()?.row === row ? (note()?.text ?? null) : null}
      error={error()?.row === row ? (error()?.text ?? null) : null}
    />
  );
  const found = () => {
    const result = forget();
    return result ? [...result.memories.map((item) => item.text), ...result.facts.map((item) => item.text)] : [];
  };

  return (
    <Show when={props.memories || props.calls}>
      <SettingsSection title={t("agentSettings.group.memory")} description={t("agentSettings.group.memoryDescription")}>
        <SettingsGroup label={t("agentSettings.group.memory")}>
          <Show when={props.memories}>
            {(memories) => (
              <SettingsLinkRow
                label={t("agentSettings.links.memories")}
                value={t("agentSettings.links.memoriesCount", { count: memories().count })}
                onClick={() => memories().open()}
              />
            )}
          </Show>
          <Show when={props.calls}>
            <SettingsRow
              label={t("agentSettings.memory.tidy")}
              description={t("agentSettings.memory.tidyDescription")}
              help={rowNote("dream")}
            >
              <Button
                variant="outline"
                size="sm"
                disabled={busy()}
                loading={dreaming()}
                onClick={() =>
                  void run(
                    "dream",
                    async (agentId, calls) => {
                      setDreaming(true);
                      try {
                        const items = await calls.dream(agentId);
                        return t("efficiency.learning.dreamDone", { count: items.length });
                      } finally {
                        setDreaming(false);
                      }
                    },
                    t("efficiency.learning.dreamFailed"),
                  )
                }
              >
                {dreaming() ? t("efficiency.learning.dreamRunning") : t("agentSettings.memory.tidyButton")}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t("agentSettings.memory.forget")}
              description={t("efficiency.learning.forgetHint")}
              help={rowNote("forget")}
            >
              <Button
                variant="outline"
                size="sm"
                class="agent-settings-danger-button"
                disabled={busy()}
                aria-haspopup="dialog"
                onClick={() =>
                  void run(
                    "forget",
                    async (agentId, calls) => {
                      const preview = await calls.forgetConversation(agentId, false);
                      if (preview.memories.length + preview.facts.length === 0)
                        return t("efficiency.learning.forgetNothing");
                      if (props.agentId === agentId) setForget(preview);
                      return null;
                    },
                    t("efficiency.learning.forgetFailed"),
                  )
                }
              >
                {t("agentSettings.memory.forgetButton")}
              </Button>
            </SettingsRow>
          </Show>
        </SettingsGroup>
        <ConfirmDialog
          open={forget() !== null}
          tone="destructive"
          initialFocus="cancel"
          title={t("agentSettings.memory.forgetTitle")}
          description={t("agentSettings.memory.forgetConsequence")}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("efficiency.learning.forgetConfirm", { count: found().length })}
          error={forget() && error()?.row === "forget" ? error()?.text : undefined}
          onCancel={() => setForget(null)}
          onConfirm={() =>
            run(
              "forget",
              async (agentId, calls) => {
                const done = await calls.forgetConversation(agentId, true);
                setForget(null);
                return t("efficiency.learning.forgotten", { count: done.forgotten });
              },
              t("efficiency.learning.forgetFailed"),
            )
          }
        >
          <ul class="efficiency-changes">
            <For each={found()}>{(text) => <li>{text}</li>}</For>
          </ul>
        </ConfirmDialog>
      </SettingsSection>
    </Show>
  );
}

/**
 * How the agent's settings changed: the checkpoints with their author, the changes on demand, and a
 * one-tap rollback. It needs the host's learning routes, which an owner or admin has.
 */
export function AgentSettingsHistorySection(props: {
  agentId: string;
  calls: EfficiencyCalls;
  agentName(agentId: string): string;
}) {
  const { t, format, errorMessage } = useText();
  const [checkpoints, setCheckpoints] = createSignal<SettingsCheckpoint[] | null>(null);
  const [open, setOpen] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
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
      setNote(null);
      setError(null);
      reload(agentId);
    },
  );

  async function rollback(checkpoint: SettingsCheckpoint): Promise<void> {
    const agentId = props.agentId;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await props.calls.rollback(checkpoint.id);
      if (props.agentId !== agentId) return;
      reload(agentId);
      setNote(t("efficiency.history.rolledBack"));
    } catch (failure) {
      if (props.agentId === agentId) setError(errorMessage(failure, t("efficiency.history.rollbackFailed")));
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
    <SettingsSection title={t("efficiency.history.title")} description={t("agentSettings.group.historyDescription")}>
      <SettingsGroup label={t("efficiency.history.title")}>
        <Show when={checkpoints()} fallback={<SettingsRow label={t("agentSettings.history.loading")} />}>
          {(list) => (
            <Show when={list().length > 0} fallback={<SettingsRow label={t("efficiency.history.empty")} />}>
              <For each={list().slice(0, 10)} keyed={(checkpoint) => checkpoint.id}>
                {(checkpoint) => (
                  <SettingsRow
                    layout="stack"
                    class="agent-settings-history-row"
                    label={checkpoint().changes.map(fieldName).join(", ")}
                    description={`${author(checkpoint())} · ${format.date(Date.parse(checkpoint().at), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}`}
                    help={
                      <Show when={open() === checkpoint().id}>
                        <For each={checkpoint().changes}>
                          {(change) => (
                            <span class="agent-settings-history-change">
                              <span>{fieldName(change)}</span>
                              <pre class="efficiency-diff">{diff(change)}</pre>
                            </span>
                          )}
                        </For>
                      </Show>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={open() === checkpoint().id ? "true" : "false"}
                      onClick={() => setOpen((current) => (current === checkpoint().id ? null : checkpoint().id))}
                    >
                      {t("efficiency.history.show")}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy()} onClick={() => void rollback(checkpoint())}>
                      {t("efficiency.history.rollback")}
                    </Button>
                  </SettingsRow>
                )}
              </For>
            </Show>
          )}
        </Show>
      </SettingsGroup>
      <Show when={error() ?? note()}>
        {(message) => (
          <span class="ui-settings-help" role={error() ? "alert" : "status"}>
            {message()}
          </span>
        )}
      </Show>
    </SettingsSection>
  );
}
