import { CHAT_CARD_MARKER, type ChatCard, type ChatCardAnswer } from "@openbot/contracts/portfolio";
import { ChatCardBlock } from "@openbot/ui/features/conversation/ui-blocks/ChatCardBlock";
import { useText } from "@openbot/ui/text";
import { createSignal, onSettled, Show } from "solid-js";
import { useWorkspace } from "../workspace/workspace-context";
import type { PortfolioCalls } from "./portfolio-port";

/**
 * The reads of the cards that the open transcript shows, by host: the ids that rows ask for in one
 * task go to the host in one call.
 */
const pending = new WeakMap<ChatCardCalls, { ids: Set<string>; answer: Promise<Map<string, ChatCard>> }>();

/** What a card needs of its host: read the cards and answer one. */
export type ChatCardCalls = Pick<PortfolioCalls, "cards" | "answerCard">;

/** The cards of a server through the desktop's main process: the local host or a joined server. */
export function desktopChatCardCalls(serverId: () => string): ChatCardCalls {
  return {
    cards: (cardIds) => window.openbot.chatCards.get({ cardIds: [...cardIds] }, serverId()),
    answerCard: (cardId, answer) => window.openbot.chatCards.answer({ cardId, answer }, serverId()),
  };
}

/** The card's id in a message's text, and the text without the marker, which the card replaces. */
export function chatCardOf(text: string): { cardId: string; text: string } | null {
  const match = CHAT_CARD_MARKER.exec(text);
  return match?.[1] ? { cardId: match[1], text: text.replace(CHAT_CARD_MARKER, "").trimEnd() } : null;
}

function readCard(calls: ChatCardCalls, cardId: string): Promise<ChatCard | null> {
  let batch = pending.get(calls);
  if (!batch) {
    const ids = new Set<string>();
    const answer = Promise.resolve().then(async () => {
      pending.delete(calls);
      const cards = await calls.cards([...ids]);
      return new Map(cards.map((card) => [card.id, card]));
    });
    batch = { ids, answer };
    pending.set(calls, batch);
  }
  batch.ids.add(cardId);
  return batch.answer.then((cards) => cards.get(cardId) ?? null);
}

/**
 * The card of a chat message (`[card:<id>]` in its text): the host's stored card, which the owner
 * answers with taps. The answer goes to the agent as a message. A reader without the portfolio calls
 * (a member, an older host) sees only the message's text.
 */
export function WorkspaceChatCard(props: { cardId: string }) {
  const ws = useWorkspace();
  return <HostChatCard cardId={props.cardId} calls={ws.env.chatCards?.() ?? ws.env.portfolio?.()} />;
}

/** The card of a chat message from the calls of its host, in a channel or an agent's own chat. */
export function HostChatCard(props: { cardId: string; calls: ChatCardCalls | undefined }) {
  const { t, errorMessage } = useText();
  const [card, setCard] = createSignal<ChatCard | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const calls = () => props.calls;

  onSettled(() => {
    const api = calls();
    if (!api) return;
    void readCard(api, props.cardId).then(setCard, () => setCard(null));
  });

  async function answer(value: ChatCardAnswer): Promise<void> {
    const api = calls();
    if (!api || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      setCard(await api.answerCard(props.cardId, value));
    } catch (failure) {
      setError(errorMessage(failure, t("portfolio.card.answerFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={card()}>
      {(current) => (
        <ChatCardBlock card={current()} busy={busy()} error={error()} onAnswer={(value) => void answer(value)} />
      )}
    </Show>
  );
}
