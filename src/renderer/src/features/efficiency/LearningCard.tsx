import type {
  LearningChange,
  LearningDecision,
  LearningReviewItem,
  LearningSource,
  LearningState,
} from "@openbot/contracts/agent-learning";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import type { EfficiencyCalls } from "./efficiency-port";
import "./efficiency.css";

const SOURCE_TEXT = {
  dreaming: "efficiency.learning.source.dreaming",
  task: "efficiency.learning.source.task",
  loop: "efficiency.learning.source.loop",
} as const satisfies Record<LearningSource, AppTextKey>;

const STATE_TEXT = {
  applied: "efficiency.learning.state.applied",
  "auto-applied": "efficiency.learning.state.autoApplied",
  dismissed: "efficiency.learning.state.dismissed",
  reverted: "efficiency.learning.state.reverted",
  stale: "efficiency.learning.state.stale",
} as const satisfies Record<Exclude<LearningState, "pending">, AppTextKey>;

function decidedText(state: LearningState): AppTextKey {
  return state === "pending" ? STATE_TEXT.applied : STATE_TEXT[state];
}

/**
 * One learning item: what it changes, line by line, why, and Apply and Dismiss while it waits, or
 * Undo for an applied memory change. Nothing applies without the owner, except a duplicate merge,
 * which shows here as applied by itself.
 */
export function LearningCard(props: {
  item: LearningReviewItem;
  calls: EfficiencyCalls;
  agentName?: string | undefined;
  onDecided: (item: LearningReviewItem) => void;
}) {
  const { t, format, errorMessage } = useText();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function line(change: LearningChange): string {
    switch (change.type) {
      case "memory-update":
        return t("efficiency.learning.change.memoryUpdate", { before: change.before, after: change.after });
      case "memory-forget":
        return t("efficiency.learning.change.memoryForget", { before: change.before });
      case "instructions-add":
        return t("efficiency.learning.change.instructions", { text: change.text });
      case "playbook-add":
        return t("efficiency.learning.change.playbook", { slug: change.slug, text: change.text });
      case "skill-add":
        return t("efficiency.learning.change.skill", { name: change.name, text: change.text });
      case "skill-copy":
        return t("efficiency.learning.change.skillCopy", { name: change.name });
    }
  }

  async function decide(decision: LearningDecision): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      props.onDecided(await props.calls.decideLearning(props.item.id, decision));
    } catch (failure) {
      setError(errorMessage(failure, t("efficiency.learning.decideFailed")));
    } finally {
      setBusy(false);
    }
  }

  const state = () => props.item.state;
  const undoable = () => props.item.kind === "memory" && (state() === "applied" || state() === "auto-applied");

  return (
    <div class="efficiency-review" data-learning-state={state()}>
      <div class="efficiency-review-head">
        <Show when={props.agentName}>{(name) => <strong>{name()}</strong>}</Show>
        <Text tone="muted">{t(SOURCE_TEXT[props.item.source])}</Text>
        <Show when={props.item.ref}>{(ref) => <Text tone="muted">{ref()}</Text>}</Show>
        <Text tone="muted">{format.date(Date.parse(props.item.createdAt), { dateStyle: "medium" })}</Text>
      </div>
      <Text>{props.item.title}</Text>
      <Show when={props.item.note}>{(note) => <Text tone="muted">{note()}</Text>}</Show>
      <ul class="efficiency-changes">
        <For each={props.item.changes}>
          {(change) => (
            <li>
              <Text>{line(change)}</Text>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <Show
        when={state() === "pending"}
        fallback={
          <div class="efficiency-actions">
            <Text tone="muted">{t(decidedText(state()))}</Text>
            <Show when={undoable()}>
              <Button variant="ghost" disabled={busy()} onClick={() => void decide("revert")}>
                {t("efficiency.learning.revert")}
              </Button>
            </Show>
          </div>
        }
      >
        <div class="efficiency-actions">
          <Button disabled={busy()} onClick={() => void decide("accept")}>
            {t("efficiency.learning.accept")}
          </Button>
          <Button variant="ghost" disabled={busy()} onClick={() => void decide("dismiss")}>
            {t("efficiency.learning.dismiss")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
