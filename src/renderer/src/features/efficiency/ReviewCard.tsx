import type { PerformanceGrade, PerformanceReview } from "@openbot/contracts/agent-efficiency";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Text, Textarea } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, Show } from "solid-js";
import type { EfficiencyCalls } from "./efficiency-port";
import "./efficiency.css";

const GRADE_TEXT = {
  great: "efficiency.review.grade.great",
  good: "efficiency.review.grade.good",
  watch: "efficiency.review.grade.watch",
  poor: "efficiency.review.grade.poor",
} as const satisfies Record<PerformanceGrade, AppTextKey>;

/**
 * One weekly review: the grade, the summary, the counts and, while it waits, the proposed instruction
 * with Add and Dismiss. The owner can edit the text before adding it. Nothing changes without them.
 */
export function ReviewCard(props: {
  review: PerformanceReview;
  calls: EfficiencyCalls;
  /** The agent's name, when the card shows outside the agent's settings. */
  agentName?: string | undefined;
  onDecided: (review: PerformanceReview) => void;
}) {
  const { t, format, errorMessage } = useText();
  const [text, setText] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const card = () => props.review.scorecard;
  const proposalText = () => text() ?? props.review.proposal?.text ?? "";

  async function decide(decision: "approve" | "dismiss"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const edited = proposalText().trim();
      const decided = await props.calls.decideReview({
        reviewId: props.review.id,
        decision,
        ...(decision === "approve" && edited && edited !== props.review.proposal?.text ? { text: edited } : {}),
      });
      props.onDecided(decided);
    } catch (failure) {
      setError(errorMessage(failure, t("efficiency.review.decideFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="efficiency-review" data-grade={props.review.grade}>
      <div class="efficiency-review-head">
        <Show when={props.agentName}>{(name) => <strong>{name()}</strong>}</Show>
        <span class="efficiency-grade">{t(GRADE_TEXT[props.review.grade])}</span>
        <Text tone="muted">{format.date(Date.parse(props.review.createdAt), { dateStyle: "medium" })}</Text>
      </div>
      <Text>{props.review.summary}</Text>
      <Text tone="muted">
        {t("efficiency.review.counts", {
          turns: format.number(card().turns),
          failed: format.number(card().failedTurns),
          praise: format.number(card().praise),
          complaints: format.number(card().complaints),
          cost: format.number(card().costUsd, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        })}
      </Text>
      <Show when={card().ticketsDone > 0 || card().ticketsReopened > 0}>
        <Text tone="muted">
          {t("efficiency.review.tickets", {
            done: String(card().ticketsDone),
            reopened: String(card().ticketsReopened),
          })}
        </Text>
      </Show>
      <Show when={card().smallModelShare}>
        {(share) => (
          <Text tone="muted">{t("efficiency.review.small", { share: String(Math.round(share() * 100)) })}</Text>
        )}
      </Show>
      <Show when={props.review.proposal}>
        {(proposal) => (
          <div class="efficiency-proposal" data-state={proposal().state}>
            <Text tone="muted">{t("efficiency.review.proposal")}</Text>
            <Show when={proposal().state === "pending"} fallback={<Text>{proposal().text}</Text>}>
              <Textarea value={proposalText()} rows={3} disabled={busy()} onValueChange={(value) => setText(value)} />
              <div class="efficiency-actions">
                <Button disabled={busy() || !proposalText().trim()} onClick={() => void decide("approve")}>
                  {t("efficiency.review.approve")}
                </Button>
                <Button variant="ghost" disabled={busy()} onClick={() => void decide("dismiss")}>
                  {t("efficiency.review.dismiss")}
                </Button>
              </div>
            </Show>
            <Show when={proposal().state !== "pending"}>
              <Text tone="muted">
                {proposal().state === "approved" ? t("efficiency.review.approved") : t("efficiency.review.dismissed")}
              </Text>
            </Show>
          </div>
        )}
      </Show>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
    </div>
  );
}
