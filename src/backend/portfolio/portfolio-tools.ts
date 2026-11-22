import { parseChatCardSpec } from "@openbot/contracts/portfolio";
import { Effect } from "effect";
import type { z } from "zod";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { postCardToolSchema, reportValidationToolSchema } from "../openbot-tools";
import { cardMessageText } from "./chat-cards";
import type { PortfolioService } from "./portfolio-service";

/** Where a card of an agent's turn shows. */
export interface CardPlacement {
  /** The channel that the turn works for, or the agent's DM with its owner; null for its own chat. */
  channelFor(agentId: string, turnId: string): string | null;
  /** Posts the agent's line in a channel. False when the channel is gone. */
  postInChannel(agentId: string, channelId: string, text: string): boolean;
  /** Adds the agent's line to its own chat. */
  postInOwnChat(agentId: string, text: string): void;
}

/** `post_card`: posts a card where the turn works, or reads or closes one of the agent's cards. */
export function postCardTool(
  portfolio: PortfolioService,
  placement: CardPlacement,
  agentId: string,
  turnId: string,
  input: z.infer<typeof postCardToolSchema>,
): Effect.Effect<OpenBotToolResponse> {
  return Effect.gen(function* () {
    const action = input.action ?? "post";
    if (action !== "post") {
      if (!input.cardId) return openBotToolFailure(`${action} needs the cardId that post gave.`);
      if (action === "close") {
        const closed = yield* portfolio.cards.close(agentId, input.cardId);
        return closed
          ? openBotToolResult({ status: "closed" })
          : openBotToolFailure("You have no open card with that id.");
      }
      const [card] = yield* portfolio.cards.get([input.cardId]);
      if (!card || card.agentId !== agentId) return openBotToolFailure("You have no card with that id.");
      return openBotToolResult({ status: card.status, ...(card.answer ? { answer: card.answer } : {}) });
    }
    if (!input.card) return openBotToolFailure("post needs a card.");
    let spec: ReturnType<typeof parseChatCardSpec>;
    try {
      spec = parseChatCardSpec(input.card);
    } catch (error) {
      return openBotToolFailure(
        `${error instanceof Error ? error.message : "Invalid card."} Check that the ids are unique, a choice has 2 or more options, a form has fields, and each table row has one cell per column, then retry.`,
      );
    }
    const channelId = placement.channelFor(agentId, turnId);
    const card = yield* portfolio.cards.create(agentId, spec, channelId);
    const text = cardMessageText(spec, card.id);
    const posted = channelId ? placement.postInChannel(agentId, channelId, text) : false;
    if (!posted) {
      if (channelId) yield* portfolio.cards.place(card.id, null);
      placement.postInOwnChat(agentId, text);
    }
    return openBotToolResult({
      status: "posted",
      cardId: card.id,
      note: "End your turn now. The answer comes back to you as a message.",
    });
  });
}

/** `report_validation`: the research agent's score of the new space that waits for it. */
export function reportValidationTool(
  portfolio: PortfolioService,
  agentId: string,
  input: z.infer<typeof reportValidationToolSchema>,
): Effect.Effect<OpenBotToolResponse> {
  return portfolio.templates.report(agentId, input).pipe(
    Effect.map((record) =>
      record
        ? openBotToolResult({ status: "reported", note: "The owner decides now whether the team starts building." })
        : openBotToolFailure("No new business waits for your validation."),
    ),
    Effect.orElseSucceed(() => openBotToolFailure("The validation could not be saved. Retry once.")),
  );
}
