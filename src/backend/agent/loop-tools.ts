import {
  LOOP_LIMITS,
  type Loop,
  type LoopItem,
  loopItemLate,
  loopNextStages,
  parseLoopDefinition,
  parseLoopValues,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import { LoopRejected, type LoopService, unmetExitCriteria } from "../loops/loop-service";
import { LOOP_TEMPLATE_SUMMARIES } from "../loops/loop-templates";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";
import { toolStep } from "./tool-operation";

const id = z.string().trim().min(1).max(128);
const stageId = z.string().trim().min(1).max(LOOP_LIMITS.stageId);
const values = z
  .object({})
  .catchall(z.union([z.string().max(LOOP_LIMITS.value), z.number(), z.null()]))
  .describe('Field values by field key, such as { "spend_usd": 12.5 }. A null removes a value.');

const listShape = {
  loopId: id.optional().describe("One loop: answers its stages and items. Omitted: every loop of your space."),
  stageId: stageId.optional().describe("With loopId: only the items in this stage."),
  itemId: id.optional().describe("One item with its history, experiments and unmet exit criteria."),
};
const saveLoopShape = {
  loopId: id.optional().describe("The loop to change. Omitted: a new loop."),
  templateId: z.string().trim().min(1).max(64).optional().describe("Start a new loop from a template."),
  definition: z
    .object({})
    .catchall(z.unknown())
    .optional()
    .describe(
      "The whole loop: { name, description?, motionProject?, fields: [{ key, label, type: text|number|money|percent|url|date, card? }], stages: [{ id, name, description?, ownerAgentId?, ownerRole?, outcome?: done|won|lost|killed, next?: [stageId], checklist?: [text], exitMetrics?: [{ field, op: >=|<=|>|<, value }], gate?: { kind: money|publish|decision, note?, amountField? }, slaDays?, onEnter?: { notifyOwner?, ticket?: { title, body? }, routine?: { agentId, routineId } } }] }. Read the loop first and send it back whole with your change.",
    ),
};
const saveItemShape = {
  loopId: id,
  itemId: id.optional().describe("The item to change. Omitted: a new item, or the item with this externalId."),
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("A key from outside, such as a product id or a mail thread id, so saving again updates the same item."),
  title: z.string().trim().min(1).max(200).optional(),
  stageId: stageId.optional().describe("Only for a new item: the stage it starts in. Default: the first stage."),
  ownerAgentId: id.nullable().optional(),
  values: values.optional(),
  check: z
    .strictObject({ index: z.number().int().min(0).max(LOOP_LIMITS.checklist), done: z.boolean() })
    .optional()
    .describe("Ticks one checklist entry of the item's current stage, by its index."),
  note: z.string().trim().min(1).max(LOOP_LIMITS.note).optional().describe("A line for the item's history."),
};
const moveShape = {
  itemId: id,
  toStageId: stageId,
  note: z
    .string()
    .trim()
    .min(1)
    .max(LOOP_LIMITS.note)
    .optional()
    .describe("Why, in one or two sentences. Required with force."),
  force: z.boolean().optional().describe("Move although the exit criteria do not hold. Never opens a gate."),
};
const experimentShape = {
  itemId: id,
  title: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().min(1).max(LOOP_LIMITS.text),
  variants: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(LOOP_LIMITS.label),
        detail: z.string().trim().max(LOOP_LIMITS.text).optional(),
      }),
    )
    .min(1)
    .max(LOOP_LIMITS.variants)
    .describe("Such as two ad angles or two landing headlines."),
  metric: z
    .string()
    .trim()
    .min(1)
    .max(LOOP_LIMITS.label)
    .describe("The metric that picks the winner, such as cost per sale."),
  budgetUsd: z
    .number()
    .min(0)
    .max(1_000_000)
    .describe("The most it may spend. More than 0 waits for the owner's approval."),
  durationDays: z.number().int().min(1).max(365),
};
const updateExperimentShape = {
  experimentId: id,
  status: z.enum(["running", "done", "cancelled"]).optional(),
  winner: z.string().trim().min(1).max(LOOP_LIMITS.label).optional(),
  result: z
    .string()
    .trim()
    .min(1)
    .max(LOOP_LIMITS.text)
    .optional()
    .describe("The numbers and what you learned. Required when done."),
};
const escalateShape = {
  itemId: id,
  question: z
    .string()
    .trim()
    .min(1)
    .max(LOOP_LIMITS.text)
    .describe("What the owner must answer or decide, with the facts they need."),
};

export const LOOP_TOOL_DEFINITIONS = [
  {
    name: "list_loops",
    description:
      "Read the loops (pipelines) of your space: products, leads, videos or questions that move through stages with owners, exit criteria and owner approval gates. Without arguments: each loop with its stages and item counts, and the loop templates.",
    shape: listShape,
  },
  {
    name: "save_loop",
    description:
      "Create a loop in your space from a template or a definition, or change one. You cannot remove or change a gate; only the owner can.",
    shape: saveLoopShape,
  },
  {
    name: "save_loop_item",
    description:
      "Add an item to a loop or change one: title, owner agent, field values (metrics), a checklist tick or a history note.",
    shape: saveItemShape,
  },
  {
    name: "move_loop_item",
    description:
      "Move an item to another stage. It answers moved, blocked (the unmet exit criteria) or waiting (the stage has a gate, so the owner decides in Needs you; do not ask again). Entering a stage wakes its owner agent and can create a Motion ticket.",
    shape: moveShape,
  },
  {
    name: "propose_experiment",
    description:
      "Propose an experiment for a loop item: hypothesis, variants, metric, budget and duration. With a budget it waits for the owner's approval; never spend before it is approved.",
    shape: experimentShape,
  },
  {
    name: "update_experiment",
    description: "Mark an approved experiment running, or finish it with its result and winner, or cancel it.",
    shape: updateExperimentShape,
  },
  {
    name: "escalate_loop_item",
    description:
      "Ask the owner about a loop item, such as a buyer question you cannot answer from the facts. It shows in Needs you, and the answer comes back to you as a note. Do not wait for it.",
    shape: escalateShape,
  },
];

const NAMES = new Set(LOOP_TOOL_DEFINITIONS.map((definition) => definition.name));

function stageSummary(loop: Loop, items: readonly LoopItem[]) {
  return loop.stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    ...(stage.ownerAgentId ? { ownerAgentId: stage.ownerAgentId } : {}),
    ...(stage.ownerRole ? { ownerRole: stage.ownerRole } : {}),
    ...(stage.outcome ? { outcome: stage.outcome } : {}),
    ...(stage.gate ? { gate: stage.gate.kind } : {}),
    items: items.filter((item) => item.stageId === stage.id).length,
  }));
}

function itemSummary(loop: Loop, item: LoopItem, now: number) {
  const stage = loop.stages.find((candidate) => candidate.id === item.stageId);
  return {
    id: item.id,
    title: item.title,
    stage: item.stageId,
    ...(item.ownerAgentId ? { ownerAgentId: item.ownerAgentId } : {}),
    values: item.values,
    ...(item.externalId ? { externalId: item.externalId } : {}),
    ...(item.pendingDecisionId ? { waitsForOwner: true } : {}),
    ...(loopItemLate(stage, item, now) ? { late: true } : {}),
  };
}

/**
 * Answers the loop tools, and null for any other tool. A refusal is a tool result the model can act on.
 */
export const handleLoopTool = Effect.fn("LoopTools.handle")(function* (
  tool: string,
  args: unknown,
  agentId: string,
  loops: LoopService | null,
) {
  if (!NAMES.has(tool)) return null;
  if (!loops) return openBotToolFailure("Loops are unavailable on this server.");
  return yield* toolStep(() => {
    try {
      return run(tool, args, agentId, loops);
    } catch (error) {
      if (error instanceof LoopRejected) return openBotToolFailure(error.message);
      if (error instanceof z.ZodError)
        return openBotToolFailure(`${z.prettifyError(error)}\nCorrect the arguments and retry.`);
      if (error instanceof Error && error.message.startsWith("Invalid loop"))
        return openBotToolFailure(`${error.message} Correct the arguments and retry.`);
      throw error;
    }
  });
});

function run(tool: string, args: unknown, agentId: string, loops: LoopService) {
  const actor = { kind: "agent", agentId } as const;
  const now = Date.now();
  switch (tool) {
    case "list_loops": {
      const input = z.strictObject(listShape).parse(args ?? {});
      const own = loops.loopsForAgent(agentId);
      if (input.itemId) {
        for (const loop of own) {
          const item = loops.itemsOf(loop.id).find((candidate) => candidate.id === input.itemId);
          if (!item) continue;
          const stage = loop.stages.find((candidate) => candidate.id === item.stageId);
          return openBotToolResult({
            loop: { id: loop.id, name: loop.name },
            item: itemSummary(loop, item, now),
            stage,
            unmetExitCriteria: unmetExitCriteria(loop, item),
            checklistDone: item.checks,
            nextStages: stage ? loopNextStages(loop, stage).map((next) => next.id) : [],
            experiments: loops.experimentsOf(item.id),
            history: loops.itemHistory(item.id),
          });
        }
        return openBotToolFailure("That item is not in a loop of your space.");
      }
      if (input.loopId) {
        const loop = own.find((candidate) => candidate.id === input.loopId);
        if (!loop) return openBotToolFailure("That loop is not in your space.");
        const items = loops.itemsOf(loop.id).filter((item) => !input.stageId || item.stageId === input.stageId);
        return openBotToolResult({
          loop: { ...loop, stages: loop.stages },
          items: items.slice(0, 200).map((item) => itemSummary(loop, item, now)),
          ...(items.length > 200 ? { more: items.length - 200 } : {}),
        });
      }
      return openBotToolResult({
        loops: own.map((loop) => ({
          id: loop.id,
          name: loop.name,
          stages: stageSummary(loop, loops.itemsOf(loop.id)),
        })),
        templates: LOOP_TEMPLATE_SUMMARIES.map((template) => ({
          id: template.id,
          name: template.name,
          stages: template.stageNames,
        })),
      });
    }
    case "save_loop": {
      const input = z.strictObject(saveLoopShape).parse(args ?? {});
      if (input.loopId) {
        if (!input.definition) return openBotToolFailure("Send the whole definition to change a loop.");
        loops.run(
          { kind: "update-loop", loopId: input.loopId, definition: parseLoopDefinition(input.definition) },
          actor,
        );
        return openBotToolResult({ status: "saved", loopId: input.loopId });
      }
      const result = loops.run(
        {
          kind: "create-loop",
          spaceId: loops.agentSpace(agentId),
          ...(input.templateId ? { templateId: input.templateId } : {}),
          ...(input.definition ? { definition: parseLoopDefinition(input.definition) } : {}),
        },
        actor,
      );
      return openBotToolResult({ status: "created", loopId: result.createdId });
    }
    case "save_loop_item": {
      const input = z.strictObject(saveItemShape).parse(args ?? {});
      const saved = loops.saveItemForAgent(agentId, {
        kind: "save-item",
        loopId: input.loopId,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.stageId ? { stageId: input.stageId } : {}),
        ...(input.ownerAgentId !== undefined ? { ownerAgentId: input.ownerAgentId } : {}),
        ...(input.values ? { values: parseLoopValues(input.values) } : {}),
        ...(input.note ? { note: input.note } : {}),
      });
      if (input.check) {
        const item = loops.itemsOf(input.loopId).find((candidate) => candidate.id === saved.itemId);
        if (item)
          loops.run(
            { kind: "check", itemId: item.id, check: `${item.stageId}:${input.check.index}`, done: input.check.done },
            actor,
          );
      }
      return openBotToolResult({ status: "saved", itemId: saved.itemId });
    }
    case "move_loop_item": {
      const input = z.strictObject(moveShape).parse(args ?? {});
      const result = loops.run(
        {
          kind: "move-item",
          itemId: input.itemId,
          toStageId: input.toStageId,
          ...(input.note ? { note: input.note } : {}),
          ...(input.force ? { force: true } : {}),
        },
        actor,
      );
      if (result.blocked?.length) return openBotToolResult({ status: "blocked", reasons: result.blocked });
      if (result.createdId)
        return openBotToolResult({
          status: "waiting",
          decisionId: result.createdId,
          note: "The stage has a gate. The owner decides in Needs you and you get a note with the answer. Tell the owner in one line; do not wait.",
        });
      return openBotToolResult({ status: "moved" });
    }
    case "propose_experiment": {
      const input = z.strictObject(experimentShape).parse(args ?? {});
      const { experiment, decisionId } = loops.proposeExperiment(agentId, {
        ...input,
        variants: input.variants.map((variant) => ({
          name: variant.name,
          ...(variant.detail ? { detail: variant.detail } : {}),
        })),
      });
      return openBotToolResult({
        status: experiment.status,
        experimentId: experiment.id,
        ...(decisionId
          ? { decisionId, note: "The budget waits for the owner. Spend nothing until you get the approval note." }
          : {}),
      });
    }
    case "update_experiment": {
      const input = z.strictObject(updateExperimentShape).parse(args ?? {});
      loops.run(
        {
          kind: "update-experiment",
          experimentId: input.experimentId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.winner ? { winner: input.winner } : {}),
          ...(input.result ? { result: input.result } : {}),
        },
        actor,
      );
      return openBotToolResult({ status: "saved" });
    }
    case "escalate_loop_item": {
      const input = z.strictObject(escalateShape).parse(args ?? {});
      const decision = loops.escalate(agentId, input.itemId, input.question);
      return openBotToolResult({ status: "escalated", decisionId: decision.id });
    }
    default:
      return null;
  }
}
