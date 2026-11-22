import type { ChatCard, ChatCardAnswer } from "@openbot/contracts/portfolio";
import { ChatCardBlock } from "@openbot/ui/features/conversation/ui-blocks/ChatCardBlock";
import { useText } from "@openbot/ui/text";
import { createSignal, onSettled, Show } from "solid-js";
import { useWorkspace } from "../workspace/workspace-context";
import type { PortfolioCalls } from "./portfolio-port";

/**
 * The reads of the cards that the open transcript shows, by host: the ids that rows ask for in one
 * task go to the host in one call.
 */
const pending = new WeakMap<PortfolioCalls, { ids: Set<string>; answer: Promise<Map<string, ChatCard>> }>();

function readCard(calls: PortfolioCalls, cardId: string): Promise<ChatCard | null> {
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
  const { t, errorMessage } = useText();
  const [card, setCard] = createSignal<ChatCard | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const calls = () => ws.env.portfolio?.();

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
