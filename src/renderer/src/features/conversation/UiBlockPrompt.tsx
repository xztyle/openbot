import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  type ConversationUiBlock,
  isDecisionCardBlock,
  isOwnerDecisionBlock,
  normalizeConversationUiBlock,
  pastDecisionRequestId,
  type UiBlockResponse,
  type UiBlockState,
  uiBlockAnswersFromResponse,
  uiBlockFallbackQuestions,
  uiBlockOutcomeText,
} from "@openbot/contracts/ui-blocks";
import type { AgentProfile } from "@openbot/ui/data";
import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { UiBlockingBlock } from "@openbot/ui/features/conversation/ui-blocks/UiBlockingBlock";
import { UiDecisionBlock } from "@openbot/ui/features/conversation/ui-blocks/UiDecisionBlock";
import { useText } from "@openbot/ui/text";
import { createSignal, Match, onCleanup, Switch } from "solid-js";
import type { PromptAnswerOptions } from "./conversation-types";

export interface UiBlockPromptProps {
  /** A block the person answers through the prompt it sits beside. */
  block: ConversationUiBlock;
  agents: AgentProfile[];
  onSelectAgent: (agentId: string) => void;
  onOpenLink: (url: string) => void;
  /**
   * Sends the answers to the block's fallback questions through the prompt route. Absent for a block
   * in the history, which only shows its stored state.
   */
  onAnswer?: ((answers: Record<string, string[]>, options?: PromptAnswerOptions) => Promise<boolean>) | undefined;
  /**
   * Answers a prompt of the history by its request id. An owner decision card whose call ended takes
   * its answer through it (`pastDecisionRequestId`): the host gives the answer to the agent as a message.
   */
  onAnswerPast?:
    | ((requestId: string, answers: Record<string, string[]>, options?: PromptAnswerOptions) => Promise<boolean>)
    | undefined;
  /**
   * Sends the owner's answer to the asking agent as a message of theirs. A decision card from before
   * the lasting ids has no other way to take an answer once its call ended.
   */
  onAnswerAsMessage?: ((text: string) => Promise<boolean>) | undefined;
  /** The agent of the chat, for a card that does not say who asks. */
  askerName?: string | undefined;
  /** The answer went through and the card shows it. */
  onAnswered?: (() => void) | undefined;
  /** Gets the card's element, and undefined once the card is gone. */
  elementRef?: ((element: HTMLElement | undefined) => void) | undefined;
}

/**
 * The answers given to decision cards from before the lasting ids, by block id. The host keeps no
 * state for them (the answer went as a message), so this device remembers which it answered: the
 * card then stays answered across a page load and a redraw of the chat, and takes no second answer.
 */
const LATE_ANSWERS_STORAGE_KEY = "openbot:legacy-decision-answers";
const LATE_ANSWERS_LIMIT = 100;
const lateAnswers = new Map<string, unknown>();
let lateAnswersLoaded = false;

function loadLateAnswers(): void {
  if (lateAnswersLoaded) return;
  lateAnswersLoaded = true;
  try {
    const saved = JSON.parse(window.localStorage.getItem(LATE_ANSWERS_STORAGE_KEY) ?? "{}");
    if (isDynamicRecord(saved)) for (const [blockId, state] of Object.entries(saved)) lateAnswers.set(blockId, state);
  } catch {
    // Blocked storage: the answers of this page only.
  }
}

/** The answer this device gave to a legacy card, read back through the block's own contract. */
function rememberedLateAnswer(block: ConversationUiBlock): UiBlockState | undefined {
  loadLateAnswers();
  const state = lateAnswers.get(block.blockId);
  return state === undefined ? undefined : normalizeConversationUiBlock({ ...block, state })?.state;
}

function rememberLateAnswer(blockId: string, state: UiBlockState): void {
  loadLateAnswers();
  lateAnswers.set(blockId, state);
  while (lateAnswers.size > LATE_ANSWERS_LIMIT) lateAnswers.delete(lateAnswers.keys().next().value ?? "");
  try {
    window.localStorage.setItem(LATE_ANSWERS_STORAGE_KEY, JSON.stringify(Object.fromEntries(lateAnswers)));
  } catch {
    // Blocked or full storage keeps it for this page only.
  }
}

/**
 * An agent's blocking block as a card. The card's response goes out as the answers to the block's
 * fallback questions, the same way a client that only knows the questions answers, so the host
 * reads both alike. A skip answers every question with nothing.
 */
export function UiBlockPrompt(props: UiBlockPromptProps) {
  const { t, format, errorMessage } = useText();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  // What this client sent, shown frozen until the host's stored state replaces it.
  const [sent, setSent] = createSignal<UiBlockState>();
  onCleanup(() => props.elementRef?.(undefined));
  const decision = () => isDecisionCardBlock(props.block);
  // A card from before the lasting ids: an expired one takes its answer as a message to the agent.
  const legacy = () => decision() && !isOwnerDecisionBlock(props.block);
  // An owner decision card waits for the owner after its call ended, until they answer or dismiss it.
  const lateAnswer = () =>
    decision() &&
    props.block.state.status === "expired" &&
    (legacy() ? props.onAnswerAsMessage !== undefined : props.onAnswerPast !== undefined);
  const answerable = () => props.block.state.status === "pending" || lateAnswer();
  // A legacy card this device answered as a message stays answered: the host does not store that.
  const [remembered, setRemembered] = createSignal<UiBlockState | undefined>(
    legacy() ? rememberedLateAnswer(props.block) : undefined,
  );
  const stored = (): UiBlockState => (answerable() ? (sent() ?? remembered() ?? props.block.state) : props.block.state);
  // The host stores the outcome with English list commas; draw it again in the reader's language.
  const state = (): UiBlockState => {
    const current = stored();
    if (current.status !== "answered" || !current.response) return current;
    const outcome = uiBlockOutcomeText(props.block.spec, current.response, format.list);
    return outcome.trim() ? { ...current, outcome } : current;
  };

  async function send(answers: Record<string, string[]>, frozen: UiBlockState): Promise<void> {
    const past = props.onAnswerPast;
    const asMessage = props.onAnswerAsMessage;
    const answer =
      props.block.state.status === "pending"
        ? props.onAnswer
        : lateAnswer() && legacy() && asMessage
          ? (given: Record<string, string[]>, options?: PromptAnswerOptions) =>
              asMessage(lateAnswerMessage(given)).catch((cause: unknown) => {
                options?.onError?.(cause);
                return false;
              })
          : lateAnswer() && past
            ? (given: Record<string, string[]>, options?: PromptAnswerOptions) =>
                past(pastDecisionRequestId(props.block.blockId), given, options)
            : undefined;
    if (!answer || busy() || sent() !== undefined) return;
    setBusy(true);
    setError(undefined);
    let failure: string | undefined;
    const fail = (cause: unknown) => {
      failure = errorMessage(cause, t("uiBlock.error.answerFailed"));
    };
    let completed = false;
    try {
      completed = await answer(answers, { onError: fail });
    } catch (cause) {
      fail(cause);
    }
    setBusy(false);
    if (!completed) {
      setError(failure ?? t("uiBlock.error.answerFailed"));
      return;
    }
    setSent(frozen);
    if (legacy() && props.block.state.status !== "pending") {
      rememberLateAnswer(props.block.blockId, frozen);
      setRemembered(frozen);
    }
    props.onAnswered?.();
  }

  function respond(response: UiBlockResponse): void {
    const spec = props.block.spec;
    const outcome = uiBlockOutcomeText(spec, response);
    void send(uiBlockAnswersFromResponse(spec, response), {
      status: "answered",
      response,
      ...(outcome.trim() ? { outcome } : {}),
    });
  }

  /** The owner's answer to a legacy card, as the message that reaches the agent: the question and the choice. */
  function lateAnswerMessage(answers: Record<string, string[]>): string {
    const chosen = Object.values(answers).flat().filter(Boolean).join(", ");
    return t("uiBlock.decision.lateMessage", { title: props.block.spec.title ?? "", answer: chosen });
  }

  function skip(): void {
    const answers = Object.fromEntries(uiBlockFallbackQuestions(props.block.spec).map((question) => [question.id, []]));
    void send(answers, { status: "closed" });
  }

  const renderPreview = (markdown: string) => (
    <div class="message-markdown">
      <MarkdownMessageText
        imagesAsLinks
        body={markdown}
        agents={props.agents}
        onSelectAgent={props.onSelectAgent}
        onOpenLink={props.onOpenLink}
      />
    </div>
  );
  const canAnswer = () => (props.block.state.status === "pending" ? props.onAnswer !== undefined : lateAnswer());

  return (
    <Switch>
      <Match when={decision() && props.block.spec.type === "confirm" && props.block.spec}>
        {(spec) => (
          <UiDecisionBlock
            spec={spec()}
            state={state()}
            busy={busy()}
            error={error()}
            disabled={!canAnswer()}
            lateAnswer={lateAnswer() && sent() === undefined}
            askerName={props.askerName}
            onRespond={respond}
            onSkip={canAnswer() && !legacy() ? skip : undefined}
            onOpenLink={props.onOpenLink}
            elementRef={(element) => props.elementRef?.(element)}
            renderPreview={renderPreview}
          />
        )}
      </Match>
      <Match when={true}>
        <UiBlockingBlock
          spec={props.block.spec}
          state={state()}
          busy={busy()}
          error={error()}
          disabled={!props.onAnswer}
          onRespond={respond}
          onSkip={props.onAnswer ? skip : undefined}
          elementRef={(element) => props.elementRef?.(element)}
          renderPreview={renderPreview}
        />
      </Match>
    </Switch>
  );
}
