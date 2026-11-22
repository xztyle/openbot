import { Effect } from "effect";
import type { z } from "zod";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { spaceMemoryToolSchema } from "../openbot-tools";
import type { SpaceKnowledgeStore } from "./space-knowledge";

type SpaceMemoryInput = z.infer<typeof spaceMemoryToolSchema>;

/** `space_memory`: the agent's space is the only one it reads or writes. */
export function spaceMemoryTool(
  store: SpaceKnowledgeStore,
  spaceId: string,
  agentId: string,
  turnId: string,
  input: SpaceMemoryInput,
): Effect.Effect<OpenBotToolResponse> {
  return Effect.gen(function* () {
    switch (input.action) {
      case "remember": {
        if (!input.type || !input.name || !input.fact) return openBotToolFailure("remember needs type, name and fact.");
        const entity = yield* store.remember(spaceId, agentId, {
          type: input.type,
          name: input.name,
          fact: input.fact,
          sourceTurnId: turnId,
        });
        if (!entity)
          return openBotToolFailure("The space memory is full. Forget an entity that no longer matters, then retry.");
        return openBotToolResult({ status: "remembered", entityId: entity.id, facts: entity.facts.length });
      }
      case "recall": {
        if (!input.query) return openBotToolFailure("recall needs a query.");
        const found = yield* store.recall(spaceId, input.query);
        return openBotToolResult({
          entities: found.entities.map((entity) => ({
            entityId: entity.id,
            type: entity.type,
            name: entity.name,
            facts: entity.facts.map((fact) => ({ factId: fact.id, text: fact.text, at: fact.at.slice(0, 10) })),
          })),
          decisions: found.decisions.map(decisionView),
        });
      }
      case "forget": {
        if (!input.entityId) return openBotToolFailure("forget needs the entityId that recall gives.");
        const removed = yield* store.remove(
          input.factId
            ? { spaceId, kind: "fact", id: input.factId, entityId: input.entityId }
            : { spaceId, kind: "entity", id: input.entityId },
        );
        return removed
          ? openBotToolResult({ status: "forgotten" })
          : openBotToolFailure("The space has no such record.");
      }
      case "decisions": {
        const decisions = input.query
          ? (yield* store.recall(spaceId, input.query, 20)).decisions
          : yield* store.recentDecisions(spaceId);
        return openBotToolResult({ decisions: decisions.map(decisionView) });
      }
      case "outcome": {
        if (!input.decisionId || !input.outcome) return openBotToolFailure("outcome needs decisionId and outcome.");
        const decision = yield* store.setOutcome(spaceId, input.decisionId, input.outcome);
        return decision
          ? openBotToolResult({ status: "recorded" })
          : openBotToolFailure("Your space has no decision with that id.");
      }
    }
  });
}

function decisionView(decision: {
  id: string;
  decision: string;
  why: string;
  alternatives?: string;
  outcome?: string;
  createdAt: string;
}) {
  return {
    decisionId: decision.id,
    decision: decision.decision,
    why: decision.why,
    ...(decision.alternatives ? { alternatives: decision.alternatives } : {}),
    ...(decision.outcome ? { outcome: decision.outcome } : {}),
    at: decision.createdAt.slice(0, 10),
  };
}
