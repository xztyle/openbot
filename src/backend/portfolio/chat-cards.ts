import { randomUUID } from "node:crypto";
import {
  type ChatCard,
  type ChatCardSpec,
  chatCardAnswerText,
  chatCardMarker,
  parseChatCardAnswer,
  parseChatCardSpec,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";

export const CHAT_CARDS_FILE = "portfolio-cards-v1.json";
/** Open cards are always kept; answered ones are kept up to this, newest first. */
const ANSWERED_KEPT = 1_000;
/** A card nobody answered closes after this. */
const OPEN_DAYS = 30;

/** A refusal that the route answers as 409 with its text. */
export class CardRefused extends Error {}

interface StoredCards {
  version: 1;
  cards: ChatCard[];
}

const EMPTY: StoredCards = { version: 1, cards: [] };

function decodeCard(value: unknown): ChatCard | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.agentId) ||
    !isString(value.createdAt) ||
    !isOneOf(["open", "answered", "closed"] as const, value.status)
  )
    return null;
  let spec: ChatCardSpec;
  try {
    spec = parseChatCardSpec(value.spec);
  } catch {
    return null;
  }
  const answeredBy =
    isDynamicRecord(value.answeredBy) && isString(value.answeredBy.id) && isString(value.answeredBy.name)
      ? { id: value.answeredBy.id, name: value.answeredBy.name }
      : undefined;
  let answer: ChatCard["answer"];
  if (value.answer !== undefined)
    try {
      answer = parseChatCardAnswer(spec, value.answer);
    } catch {
      answer = undefined;
    }
  return {
    id: value.id,
    agentId: value.agentId,
    channelId: isString(value.channelId) ? value.channelId : null,
    spec,
    status: value.status,
    ...(answer ? { answer } : {}),
    ...(answeredBy ? { answeredBy } : {}),
    ...(isString(value.answeredAt) ? { answeredAt: value.answeredAt } : {}),
    createdAt: value.createdAt,
  };
}

function decodeStored(value: unknown): StoredCards | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  return { version: 1, cards: Array.isArray(value.cards) ? value.cards.flatMap((card) => decodeCard(card) ?? []) : [] };
}

/** The text of a chat message that carries a card: a short readable line for any client, then the marker. */
export function cardMessageText(spec: ChatCardSpec, cardId: string): string {
  const lines = [spec.title];
  if (spec.type === "choice") lines.push(spec.options.map((option) => `• ${option.label}`).join("\n"));
  if (spec.type === "table") lines.push(spec.rows.map((row) => `• ${row.cells.join(" · ")}`).join("\n"));
  return `${lines.filter(Boolean).join("\n")}\n${chatCardMarker(cardId)}`;
}

export interface ChatCardsHooks {
  path: string;
  /** Gives the agent the answer as a message from the person who answered, which starts its turn. */
  deliver(card: ChatCard, text: string, person: { id: string; name: string }): Effect.Effect<void, unknown>;
  changed?(card: ChatCard): void;
}

/**
 * The interactive cards that agents post with `post_card`: a choice, an approve or reject, a short
 * form, or a table of options with a decision per row. The agent does not wait: the card stays open
 * in the chat, and the person's taps go back to the agent as a message, which wakes it.
 */
export class ChatCards {
  readonly #hooks: ChatCardsHooks;
  readonly #store: JsonStore<StoredCards>;
  readonly #answering = new Set<string>();

  constructor(hooks: ChatCardsHooks) {
    this.#hooks = hooks;
    this.#store = new JsonStore(hooks.path, EMPTY, decodeStored);
  }

  readonly create = Effect.fn("ChatCards.create")(function* (
    this: ChatCards,
    agentId: string,
    spec: ChatCardSpec,
    channelId: string | null,
  ) {
    const card: ChatCard = {
      id: randomUUID(),
      agentId,
      channelId,
      spec,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    yield* this.#save(card);
    return card;
  });

  /** Points a card at the channel that shows it, once the message is posted. */
  readonly place = Effect.fn("ChatCards.place")(function* (this: ChatCards, cardId: string, channelId: string | null) {
    yield* this.#store.update((stored) => ({
      ...stored,
      cards: stored.cards.map((card) => (card.id === cardId ? { ...card, channelId } : card)),
    }));
  });

  readonly get = Effect.fn("ChatCards.get")(function* (this: ChatCards, cardIds: readonly string[]) {
    const stored = yield* this.#store.load();
    const now = Date.now();
    return cardIds.flatMap((cardId) => {
      const card = stored.cards.find((entry) => entry.id === cardId);
      if (!card) return [];
      // An old open card shows as closed; the next write keeps it so.
      return card.status === "open" && now - Date.parse(card.createdAt) > OPEN_DAYS * 86_400_000
        ? [{ ...card, status: "closed" as const }]
        : [card];
    });
  });

  /** The agent closes its own card, such as one that is no longer needed. */
  readonly close = Effect.fn("ChatCards.close")(function* (this: ChatCards, agentId: string, cardId: string) {
    const stored = yield* this.#store.load();
    const card = stored.cards.find((entry) => entry.id === cardId && entry.agentId === agentId);
    if (card?.status !== "open") return false;
    const closed: ChatCard = { ...card, status: "closed" };
    yield* this.#save(closed);
    this.#hooks.changed?.(closed);
    return true;
  });

  readonly answer = Effect.fn("ChatCards.answer")(function* (
    this: ChatCards,
    cardId: string,
    value: unknown,
    person: { id: string; name: string },
  ) {
    const [card] = yield* this.get([cardId]);
    if (!card) return yield* Effect.fail(new CardRefused("The card does not exist any more."));
    if (card.status !== "open") return yield* Effect.fail(new CardRefused("The card was already answered or closed."));
    const answer = yield* Effect.try({
      try: () => parseChatCardAnswer(card.spec, value),
      catch: () => new CardRefused("The answer does not fit the card."),
    });
    if (this.#answering.has(cardId)) return yield* Effect.fail(new CardRefused("The card is being answered."));
    this.#answering.add(cardId);
    const answered: ChatCard = {
      ...card,
      status: "answered",
      answer,
      answeredBy: person,
      answeredAt: new Date().toISOString(),
    };
    const text = `Card answer from ${person.name} — "${card.spec.title}" (card ${card.id}): ${chatCardAnswerText(card.spec, answer)}`;
    // The card freezes only once the agent has the answer, so a failed delivery leaves it open for a retry.
    yield* this.#hooks.deliver(answered, text, person).pipe(
      Effect.mapError(
        (cause) => new CardRefused(cause instanceof Error ? cause.message : "The agent could not get the answer."),
      ),
      Effect.ensuring(Effect.sync(() => this.#answering.delete(cardId))),
    );
    yield* this.#save(answered);
    this.#hooks.changed?.(answered);
    return answered;
  });

  readonly #save = Effect.fn("ChatCards.save")(function* (this: ChatCards, card: ChatCard) {
    yield* this.#store.update((stored) => {
      const others = stored.cards.filter((entry) => entry.id !== card.id);
      const open = [card, ...others].filter((entry) => entry.status === "open");
      const done = [card, ...others].filter((entry) => entry.status !== "open").slice(0, ANSWERED_KEPT);
      return { ...stored, cards: [...open, ...done] };
    });
  });

  readonly forgetAgent = Effect.fn("ChatCards.forgetAgent")(function* (this: ChatCards, agentId: string) {
    yield* this.#store.update((stored) => ({
      ...stored,
      cards: stored.cards.filter((card) => card.agentId !== agentId),
    }));
  });
}
