import { randomUUID } from "node:crypto";
import {
  LOOP_LIMITS,
  type Loop,
  type LoopDecision,
  type LoopDefinition,
  type LoopExperiment,
  type LoopGateKind,
  type LoopItem,
  type LoopStage,
  type LoopValue,
  type LoopVariant,
  loopCheckKey,
  loopNextStages,
  type WorkspaceLoopAction,
  type WorkspaceLoopActionResult,
  type WorkspaceLoops,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { type LoopEventInput, LoopStore } from "./loop-store";
import { LOOP_TEMPLATE_SUMMARIES, loopTemplate } from "./loop-templates";

const logger = createOpenBotLogger("loops");

/** Who changes a loop: a person (the owner or an admin) or an agent through its tools. */
export type LoopActor = { kind: "person"; id?: string } | { kind: "agent"; agentId: string };

/** A refusal the caller can show or hand back to an agent as it is. */
export class LoopRejected extends Error {}

export interface LoopTicketRequest {
  spaceId: string;
  project: string;
  title: string;
  body: string;
  /** The agent the ticket is for, by id; Motion assigns it by its name. */
  assigneeAgentId?: string;
  /** The agent that acts in Motion: the mover, or the stage owner when a person moved the item. */
  actorAgentId?: string;
  dueDate?: string;
}

export interface LoopServiceHooks {
  /** Every agent of the host, with its space. */
  agents(): readonly { id: string; name: string }[];
  agentSpace(agentId: string): string;
  spaceExists(spaceId: string): boolean;
  /** Sends a note from Atelier that wakes the agent. Failures are the hook's to log. */
  notifyAgent(agentId: string, text: string): void;
  /** Runs a routine of an agent once. */
  runRoutine(agentId: string, routineId: string): Promise<void>;
  /** Creates a Motion ticket; answers its key or link, or null when Motion is not connected. */
  createTicket(request: LoopTicketRequest): Promise<{ key?: string; url?: string } | null>;
  /** An item reached an end stage: the agents that worked on it may learn from it. */
  itemFinished?(input: { agentIds: string[]; loop: string; item: string; outcome: string }): void;
}

function fill(text: string, item: LoopItem, stage: LoopStage, loop: Loop): string {
  return text.replaceAll("{item}", item.title).replaceAll("{stage}", stage.name).replaceAll("{loop}", loop.name);
}

function stageOf(loop: Loop, stageId: string): LoopStage {
  const stage = loop.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new LoopRejected(`The loop "${loop.name}" has no stage "${stageId}".`);
  return stage;
}

function numeric(value: LoopValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** The exit criteria of the item's stage that do not hold, in words. */
export function unmetExitCriteria(loop: Loop, item: LoopItem): string[] {
  const stage = loop.stages.find((candidate) => candidate.id === item.stageId);
  if (!stage) return [];
  const unmet: string[] = [];
  for (const [index, entry] of (stage.checklist ?? []).entries())
    if (!item.checks.includes(loopCheckKey(stage.id, index))) unmet.push(`Checklist: ${entry}`);
  for (const rule of stage.exitMetrics ?? []) {
    const value = numeric(item.values[rule.field]);
    const label = loop.fields.find((field) => field.key === rule.field)?.label ?? rule.field;
    const holds =
      value !== null &&
      (rule.op === ">="
        ? value >= rule.value
        : rule.op === "<="
          ? value <= rule.value
          : rule.op === ">"
            ? value > rule.value
            : value < rule.value);
    if (!holds) unmet.push(`${label} ${rule.op} ${rule.value} (now ${value ?? "empty"})`);
  }
  return unmet;
}

/**
 * The loops of every space: definitions, items moving through stages, experiments and the owner's
 * decisions. A gate never opens for an agent: an agent's move into a gated stage, and its experiment
 * with a budget, wait for the owner as a decision. An agent cannot remove or change a gate either.
 * Entering a stage runs its actions after the change is saved; a failed action is written to the
 * item's history and changes nothing else.
 */
export class LoopService {
  readonly #store: LoopStore;
  readonly #hooks: LoopServiceHooks;

  constructor(store: LoopStore, hooks: LoopServiceHooks) {
    this.#store = store;
    this.#hooks = hooks;
  }

  static create(database: ConstructorParameters<typeof LoopStore>[0], hooks: LoopServiceHooks): LoopService {
    return new LoopService(new LoopStore(database), hooks);
  }

  board(spaceId: string, options: { decisionsOnly?: boolean } = {}): WorkspaceLoops {
    const loops = this.#store.loops(spaceId);
    const ids = loops.map((loop) => loop.id);
    if (options.decisionsOnly)
      return {
        spaceId,
        loops,
        items: [],
        experiments: [],
        decisions: this.#store.decisions(spaceId).filter((decision) => decision.status === "pending"),
        events: [],
        templates: [],
      };
    return {
      spaceId,
      loops,
      items: this.#store.items(ids),
      experiments: this.#store.experiments(ids),
      decisions: this.#store.decisions(spaceId),
      events: this.#store.events(ids),
      templates: LOOP_TEMPLATE_SUMMARIES,
    };
  }

  /** The decisions that wait for the owner, in every space. */
  pendingDecisions(): LoopDecision[] {
    return this.#store.pendingDecisions();
  }

  agentSpace(agentId: string): string {
    return this.#hooks.agentSpace(agentId);
  }

  loopsForAgent(agentId: string): Loop[] {
    return this.#store.loops(this.#hooks.agentSpace(agentId));
  }

  itemsOf(loopId: string): LoopItem[] {
    return this.#store.items([loopId]);
  }

  itemHistory(itemId: string) {
    return this.#store.itemEvents(itemId, 30);
  }

  experimentsOf(itemId: string): LoopExperiment[] {
    const item = this.#store.item(itemId);
    return item ? this.#store.experiments([item.loopId]).filter((experiment) => experiment.itemId === itemId) : [];
  }

  /** Runs one action and answers the board of the space it changed. */
  apply(action: WorkspaceLoopAction, actor: LoopActor): WorkspaceLoopActionResult {
    const outcome = this.#apply(action, actor);
    return {
      ...this.board(outcome.spaceId),
      ...(outcome.createdId ? { createdId: outcome.createdId } : {}),
      ...(outcome.blocked?.length ? { blocked: outcome.blocked } : {}),
    };
  }

  /** The same as `apply`, without the board: for agent tools. */
  run(action: WorkspaceLoopAction, actor: LoopActor): { spaceId: string; createdId?: string; blocked?: string[] } {
    return this.#apply(action, actor);
  }

  #apply(action: WorkspaceLoopAction, actor: LoopActor): { spaceId: string; createdId?: string; blocked?: string[] } {
    switch (action.kind) {
      case "create-loop": {
        this.#requireSpace(action.spaceId, actor);
        if (this.#store.loops(action.spaceId).length >= LOOP_LIMITS.loopsPerSpace)
          throw new LoopRejected(`A space holds at most ${LOOP_LIMITS.loopsPerSpace} loops.`);
        const template = action.templateId ? loopTemplate(action.templateId) : undefined;
        if (action.templateId && !template) throw new LoopRejected(`There is no loop template "${action.templateId}".`);
        const definition = action.definition ?? template?.definition;
        if (!definition) throw new LoopRejected("A loop needs a template or a definition.");
        this.#checkOwners(action.spaceId, definition);
        const loop = this.#store.createLoop(action.spaceId, definition, template?.id);
        return { spaceId: loop.spaceId, createdId: loop.id };
      }
      case "update-loop": {
        const loop = this.#loop(action.loopId, actor);
        this.#checkOwners(loop.spaceId, action.definition);
        if (actor.kind === "agent") keepGates(loop, action.definition);
        const kept = new Set(action.definition.stages.map((stage) => stage.id));
        const stranded = this.#store.items([loop.id]).filter((item) => !kept.has(item.stageId));
        if (stranded.length > 0)
          throw new LoopRejected(
            `Move the items out of the stages you remove first: ${[...new Set(stranded.map((item) => item.stageId))].join(", ")}.`,
          );
        this.#store.updateLoop(loop.id, action.definition);
        return { spaceId: loop.spaceId };
      }
      case "delete-loop": {
        if (actor.kind === "agent") throw new LoopRejected("Only the owner deletes a loop.");
        const loop = this.#loop(action.loopId, actor);
        this.#store.deleteLoop(loop.id);
        return { spaceId: loop.spaceId };
      }
      case "save-item":
        return this.#saveItem(action, actor);
      case "remove-item": {
        const { loop, item } = this.#item(action.itemId, actor);
        if (actor.kind === "agent")
          throw new LoopRejected("Only the owner removes an item; move it to an end stage instead.");
        this.#store.removeItem(item.id);
        return { spaceId: loop.spaceId };
      }
      case "check": {
        const { loop, item } = this.#item(action.itemId, actor);
        const checks = new Set(item.checks);
        if (action.done) checks.add(action.check);
        else checks.delete(action.check);
        this.#store.transaction(() => {
          this.#store.writeItem({ ...item, checks: [...checks], updatedAt: Date.now() });
          this.#event(actor, {
            loopId: loop.id,
            itemId: item.id,
            kind: "updated",
            text: `${action.done ? "Done" : "Not done"}: ${checkLabel(loop, action.check)}`,
          });
        });
        return { spaceId: loop.spaceId };
      }
      case "move-item":
        return this.#move(action.itemId, action.toStageId, actor, action.note, action.force === true);
      case "decide":
        return this.#decide(action.decisionId, action.approve, actor, action.note);
      case "update-experiment":
        return this.#updateExperiment(action, actor);
    }
  }

  /** An agent proposes an experiment. With a budget it waits for the owner's approval. */
  proposeExperiment(
    agentId: string,
    input: {
      itemId: string;
      title: string;
      hypothesis: string;
      variants: LoopVariant[];
      metric: string;
      budgetUsd: number;
      durationDays: number;
    },
  ): { experiment: LoopExperiment; decisionId?: string } {
    const actor: LoopActor = { kind: "agent", agentId };
    const { loop, item } = this.#item(input.itemId, actor);
    const now = Date.now();
    const experiment: LoopExperiment = {
      id: randomUUID(),
      loopId: loop.id,
      itemId: item.id,
      title: input.title,
      hypothesis: input.hypothesis,
      variants: input.variants,
      metric: input.metric,
      budgetUsd: input.budgetUsd,
      durationDays: input.durationDays,
      status: input.budgetUsd > 0 ? "proposed" : "approved",
      proposedBy: agentId,
      createdAt: now,
      updatedAt: now,
    };
    let decisionId: string | undefined;
    this.#store.transaction(() => {
      if (input.budgetUsd > 0) {
        const decision = this.#newDecision(loop, item, agentId, {
          kind: "money",
          subject: "experiment",
          title: `Experiment budget: ${input.title} (${item.title})`,
          detail: `${input.hypothesis}\nVariants: ${input.variants.map((variant) => variant.name).join(", ")}. Metric: ${input.metric}. ${input.durationDays} days.`,
          amountUsd: input.budgetUsd,
          experimentId: experiment.id,
        });
        decisionId = decision.id;
        experiment.decisionId = decision.id;
      }
      this.#store.writeExperiment(experiment);
      this.#event(actor, {
        loopId: loop.id,
        itemId: item.id,
        kind: "experiment",
        text: `Proposed experiment "${input.title}"${input.budgetUsd > 0 ? `, budget ${input.budgetUsd} USD (waits for the owner)` : ""}.`,
      });
    });
    return { experiment, ...(decisionId ? { decisionId } : {}) };
  }

  /** An agent asks the owner a question about an item; it shows in Needs you. */
  escalate(agentId: string, itemId: string, question: string): LoopDecision {
    const actor: LoopActor = { kind: "agent", agentId };
    const { loop, item } = this.#item(itemId, actor);
    return this.#store.transaction(() => {
      const decision = this.#newDecision(loop, item, agentId, {
        kind: "decision",
        subject: "question",
        title: `${item.title}: ${question.split("\n")[0]?.slice(0, 200) ?? ""}`,
        detail: question,
      });
      this.#event(actor, { loopId: loop.id, itemId: item.id, kind: "decision", text: `Asked the owner: ${question}` });
      return decision;
    });
  }

  #saveItem(
    action: Extract<WorkspaceLoopAction, { kind: "save-item" }> & { externalId?: string; note?: string },
    actor: LoopActor,
  ): { spaceId: string; createdId?: string } {
    const loop = this.#loop(action.loopId, actor);
    if (action.ownerAgentId) this.#requireAgentInSpace(loop.spaceId, action.ownerAgentId);
    const now = Date.now();
    const existing = action.itemId
      ? this.#store.item(action.itemId)
      : action.externalId
        ? this.#store.itemByExternalId(loop.id, action.externalId)
        : null;
    if (action.itemId && (!existing || existing.loopId !== loop.id))
      throw new LoopRejected("That item is not in this loop.");
    const merged = (base: Record<string, LoopValue>) => {
      const next = { ...base };
      for (const [key, value] of Object.entries(action.values ?? {})) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      return next;
    };
    if (!existing) {
      if (!action.title) throw new LoopRejected("A new item needs a title.");
      if (this.#store.itemCount(loop.id) >= LOOP_LIMITS.items)
        throw new LoopRejected(`A loop holds at most ${LOOP_LIMITS.items} items. Remove finished ones first.`);
      const first = loop.stages.find((stage) => !stage.outcome);
      const stage = action.stageId ? stageOf(loop, action.stageId) : first;
      if (!stage) throw new LoopRejected("The loop has no stage to start in.");
      if (stage.gate && actor.kind === "agent")
        throw new LoopRejected(`"${stage.name}" has a gate: add the item to an earlier stage and move it.`);
      const item: LoopItem = {
        id: randomUUID(),
        loopId: loop.id,
        title: action.title,
        stageId: stage.id,
        ...(action.ownerAgentId ? { ownerAgentId: action.ownerAgentId } : {}),
        values: merged({}),
        checks: [],
        ...(action.externalId ? { externalId: action.externalId } : {}),
        enteredAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.#store.transaction(() => {
        this.#store.insertItem(item);
        this.#event(actor, { loopId: loop.id, itemId: item.id, kind: "created", to: stage.id, text: action.note });
      });
      this.#enter(loop, item, stage, actor);
      return { spaceId: loop.spaceId, createdId: item.id };
    }
    const changed: LoopItem = {
      ...existing,
      ...(action.title ? { title: action.title } : {}),
      values: merged(existing.values),
      updatedAt: now,
    };
    if (action.ownerAgentId === null) delete changed.ownerAgentId;
    else if (action.ownerAgentId) changed.ownerAgentId = action.ownerAgentId;
    const keys = Object.keys(action.values ?? {});
    this.#store.transaction(() => {
      this.#store.writeItem(changed);
      this.#event(actor, {
        loopId: loop.id,
        itemId: existing.id,
        kind: action.note && keys.length === 0 ? "note" : "updated",
        text:
          [keys.length ? `Updated ${keys.join(", ")}` : "", action.note ?? ""].filter(Boolean).join(". ") || "Updated",
      });
    });
    return { spaceId: loop.spaceId, createdId: existing.id };
  }

  /** Saves an item for an agent tool, with an external key and a note. */
  saveItemForAgent(
    agentId: string,
    input: Extract<WorkspaceLoopAction, { kind: "save-item" }> & { externalId?: string; note?: string },
  ): { itemId: string } {
    const result = this.#saveItem(input, { kind: "agent", agentId });
    if (!result.createdId) throw new LoopRejected("The item was not saved.");
    return { itemId: result.createdId };
  }

  #move(
    itemId: string,
    toStageId: string,
    actor: LoopActor,
    note: string | undefined,
    force: boolean,
  ): { spaceId: string; createdId?: string; blocked?: string[] } {
    const { loop, item } = this.#item(itemId, actor);
    const from = stageOf(loop, item.stageId);
    const to = stageOf(loop, toStageId);
    if (from.id === to.id) return { spaceId: loop.spaceId, blocked: [`The item is already in "${to.name}".`] };
    if (item.pendingDecisionId) {
      const pending = this.#store.decision(item.pendingDecisionId);
      if (pending?.status === "pending")
        return { spaceId: loop.spaceId, blocked: [`The item waits for the owner's decision: ${pending.title}`] };
    }
    const fromIndex = loop.stages.indexOf(from);
    const backward = loop.stages.indexOf(to) < fromIndex && !to.outcome;
    if (actor.kind === "agent" && !backward && !loopNextStages(loop, from).includes(to))
      return {
        spaceId: loop.spaceId,
        blocked: [
          `From "${from.name}" an item goes to: ${
            loopNextStages(loop, from)
              .map((stage) => `${stage.name} (${stage.id})`)
              .join(", ") || "nowhere"
          }.`,
        ],
      };
    if (!backward && !to.outcome) {
      const unmet = unmetExitCriteria(loop, item);
      if (unmet.length > 0 && !force) return { spaceId: loop.spaceId, blocked: unmet };
      if (unmet.length > 0 && actor.kind === "agent" && !note)
        return { spaceId: loop.spaceId, blocked: ["A forced move needs a note that says why.", ...unmet] };
    }
    if (to.gate && actor.kind === "agent") {
      const amount = to.gate.amountField ? numeric(item.values[to.gate.amountField]) : null;
      const decision = this.#store.transaction(() => {
        const created = this.#newDecision(loop, item, actor.agentId, {
          kind: to.gate?.kind ?? "decision",
          subject: "move",
          title: `${item.title}: move to ${to.name}`,
          detail: [to.gate?.note, note].filter(Boolean).join("\n"),
          ...(amount !== null && amount > 0 ? { amountUsd: amount } : {}),
          toStageId: to.id,
        });
        this.#store.writeItem({ ...item, pendingDecisionId: created.id, updatedAt: Date.now() });
        this.#event(actor, {
          loopId: loop.id,
          itemId: item.id,
          kind: "decision",
          from: from.id,
          to: to.id,
          text: `Asked the owner to approve the move to ${to.name}${note ? `: ${note}` : ""}`,
        });
        return created;
      });
      return { spaceId: loop.spaceId, createdId: decision.id };
    }
    this.#commitMove(loop, item, from, to, actor, note, force);
    return { spaceId: loop.spaceId };
  }

  #commitMove(
    loop: Loop,
    item: LoopItem,
    from: LoopStage,
    to: LoopStage,
    actor: LoopActor,
    note: string | undefined,
    force: boolean,
    requesterAgentId?: string,
  ): void {
    const moved: LoopItem = { ...item, stageId: to.id, enteredAt: Date.now(), updatedAt: Date.now() };
    delete moved.pendingDecisionId;
    this.#store.transaction(() => {
      this.#store.writeItem(moved);
      this.#event(actor, {
        loopId: loop.id,
        itemId: item.id,
        kind: "moved",
        from: from.id,
        to: to.id,
        text: [force ? "Forced past the exit criteria" : "", note ?? ""].filter(Boolean).join(". ") || undefined,
      });
    });
    this.#enter(loop, moved, to, actor, requesterAgentId);
    if (to.outcome) {
      const agentIds = [
        item.ownerAgentId,
        from.ownerAgentId,
        actor.kind === "agent" ? actor.agentId : undefined,
        requesterAgentId,
      ].filter((id): id is string => typeof id === "string");
      if (agentIds.length > 0)
        this.#hooks.itemFinished?.({ agentIds, loop: loop.name, item: item.title, outcome: to.name });
    }
  }

  #decide(decisionId: string, approve: boolean, actor: LoopActor, note: string | undefined): { spaceId: string } {
    if (actor.kind === "agent") throw new LoopRejected("Only the owner decides.");
    const decision = this.#store.decision(decisionId);
    if (!decision) throw new LoopRejected("That decision does not exist.");
    if (decision.status !== "pending") return { spaceId: decision.spaceId };
    const loop = this.#store.loop(decision.loopId);
    const item = this.#store.item(decision.itemId);
    const decided: LoopDecision = {
      ...decision,
      status: approve ? "approved" : "rejected",
      decidedAt: Date.now(),
      ...(note ? { note } : {}),
    };
    this.#store.transaction(() => {
      this.#store.writeDecision(decided);
      if (loop && item)
        this.#event(actor, {
          loopId: loop.id,
          itemId: item.id,
          kind: "decision",
          text: `${decision.subject === "question" ? "Answered" : approve ? "Approved" : "Rejected"}: ${decision.title}${decision.amountUsd !== undefined ? ` (${decision.amountUsd} USD)` : ""}${note ? `. ${note}` : ""}`,
        });
      if (decision.subject === "experiment" && decision.experimentId) {
        const experiment = this.#store.experiment(decision.experimentId);
        if (experiment)
          this.#store.writeExperiment({
            ...experiment,
            status: approve ? "approved" : "rejected",
            updatedAt: Date.now(),
          });
      }
      if (decision.subject === "move" && item && item.pendingDecisionId === decision.id && !approve) {
        const cleared = { ...item, updatedAt: Date.now() };
        delete cleared.pendingDecisionId;
        this.#store.writeItem(cleared);
      }
    });
    if (decision.subject === "move" && approve && loop && item && decision.toStageId) {
      const from = loop.stages.find((stage) => stage.id === item.stageId);
      const to = loop.stages.find((stage) => stage.id === decision.toStageId);
      if (from && to) this.#commitMove(loop, item, from, to, actor, note, false, decision.requestedBy);
    }
    if (decision.requestedBy && this.#agentExists(decision.requestedBy)) {
      const verdict =
        decision.subject === "question" ? `The owner answered` : approve ? "The owner approved" : "The owner rejected";
      this.#notify(
        decision.requestedBy,
        `${verdict}: ${decision.title}${decision.amountUsd !== undefined ? ` (${decision.amountUsd} USD)` : ""}.${note ? ` Note: ${note}` : ""} Loop "${loop?.name ?? ""}", item id ${decision.itemId}.${
          approve && decision.subject === "experiment"
            ? " Run the experiment within the budget, then record the result with openbot.update_experiment."
            : ""
        }`,
      );
    }
    return { spaceId: decision.spaceId };
  }

  #updateExperiment(
    action: Extract<WorkspaceLoopAction, { kind: "update-experiment" }>,
    actor: LoopActor,
  ): { spaceId: string } {
    const experiment = this.#store.experiment(action.experimentId);
    if (!experiment) throw new LoopRejected("That experiment does not exist.");
    const { loop, item } = this.#item(experiment.itemId, actor);
    if (action.status === "approved" || action.status === "rejected") {
      if (actor.kind === "agent") throw new LoopRejected("Only the owner approves or rejects an experiment.");
    }
    if (action.status === "running" && experiment.status !== "approved" && experiment.status !== "running")
      throw new LoopRejected(
        experiment.status === "proposed"
          ? "The experiment waits for the owner's approval of its budget."
          : `The experiment is ${experiment.status}.`,
      );
    if (action.status === "done" && !action.result && !experiment.result)
      throw new LoopRejected("A finished experiment needs a result.");
    const now = Date.now();
    const next: LoopExperiment = {
      ...experiment,
      ...(action.status ? { status: action.status } : {}),
      ...(action.winner ? { winner: action.winner } : {}),
      ...(action.result ? { result: action.result } : {}),
      ...(action.status === "running" && !experiment.startedAt ? { startedAt: now } : {}),
      ...(action.status === "done" || action.status === "cancelled" ? { endedAt: now } : {}),
      updatedAt: now,
    };
    this.#store.transaction(() => {
      this.#store.writeExperiment(next);
      this.#event(actor, {
        loopId: loop.id,
        itemId: item.id,
        kind: "experiment",
        text: `Experiment "${experiment.title}": ${next.status}${next.winner ? `, winner ${next.winner}` : ""}${action.result ? `. ${action.result}` : ""}`,
      });
    });
    return { spaceId: loop.spaceId };
  }

  #newDecision(
    loop: Loop,
    item: LoopItem,
    agentId: string,
    input: {
      kind: LoopGateKind;
      subject: LoopDecision["subject"];
      title: string;
      detail?: string;
      amountUsd?: number;
      toStageId?: string;
      experimentId?: string;
    },
  ): LoopDecision {
    if (this.#store.pendingCount(loop.spaceId) >= LOOP_LIMITS.decisions)
      throw new LoopRejected("Too many decisions wait for the owner. Wait for answers first.");
    const decision: LoopDecision = {
      id: randomUUID(),
      spaceId: loop.spaceId,
      loopId: loop.id,
      itemId: item.id,
      kind: input.kind,
      subject: input.subject,
      title: input.title.slice(0, 300),
      ...(input.detail ? { detail: input.detail.slice(0, LOOP_LIMITS.text) } : {}),
      ...(input.amountUsd !== undefined ? { amountUsd: input.amountUsd } : {}),
      requestedBy: agentId,
      ...(input.toStageId ? { toStageId: input.toStageId } : {}),
      ...(input.experimentId ? { experimentId: input.experimentId } : {}),
      status: "pending",
      createdAt: Date.now(),
    };
    this.#store.writeDecision(decision);
    return decision;
  }

  /** The actions of a stage that an item entered. Each runs on its own; a failure is noted in the history. */
  #enter(loop: Loop, item: LoopItem, stage: LoopStage, actor: LoopActor, requesterAgentId?: string): void {
    const actions = stage.onEnter;
    if (!actions) return;
    const owner = stage.ownerAgentId ?? item.ownerAgentId;
    const moverAgent = actor.kind === "agent" ? actor.agentId : requesterAgentId;
    const note = (text: string) =>
      this.#store.addEvent({ loopId: loop.id, itemId: item.id, kind: "action", actorKind: "host", text });
    if (actions.notifyOwner && owner && owner !== moverAgent && this.#agentExists(owner)) {
      const criteria = [
        ...(stage.checklist ?? []).map((entry) => `[ ] ${entry}`),
        ...(stage.exitMetrics ?? []).map((rule) => `${rule.field} ${rule.op} ${rule.value}`),
      ];
      this.#notify(
        owner,
        [
          `Loop "${loop.name}": "${item.title}" entered "${stage.name}" and you own this stage.`,
          stage.description ? `Goal: ${stage.description}` : "",
          criteria.length ? `Exit criteria: ${criteria.join("; ")}.` : "",
          stage.slaDays ? `Due in ${stage.slaDays} days.` : "",
          `Item id ${item.id}. Update it with openbot.save_loop_item and move it on with openbot.move_loop_item.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      note(`Woke the stage owner ${this.#agentName(owner)}.`);
    }
    if (actions.ticket && loop.motionProject) {
      const due = stage.slaDays
        ? new Date(Date.now() + stage.slaDays * 86_400_000).toISOString().slice(0, 10)
        : undefined;
      const request: LoopTicketRequest = {
        spaceId: loop.spaceId,
        project: loop.motionProject,
        title: fill(actions.ticket.title, item, stage, loop).slice(0, 200),
        body: `${fill(actions.ticket.body ?? "", item, stage, loop)}\n\nLoop: ${loop.name}. Stage: ${stage.name}. Item id: ${item.id}.`,
        ...(owner ? { assigneeAgentId: owner } : {}),
        ...((moverAgent ?? owner) ? { actorAgentId: moverAgent ?? owner } : {}),
        ...(due ? { dueDate: due } : {}),
      };
      void this.#hooks
        .createTicket(request)
        .then((ticket) => {
          if (ticket) note(`Motion ticket ${ticket.key ?? ""} ${ticket.url ?? ""}`.trim());
          else
            note(
              "No Motion ticket: Motion is not connected (an MCP server named motion and the shared key MOTION_TOKEN).",
            );
        })
        .catch((error: unknown) => {
          logger.warn("Loop ticket failed.", { loopId: loop.id, error: error instanceof Error ? error.message : "" });
          note("The Motion ticket failed.");
        });
    }
    if (actions.routine) {
      const { agentId, routineId } = actions.routine;
      if (this.#hooks.agentSpace(agentId) === loop.spaceId)
        void this.#hooks
          .runRoutine(agentId, routineId)
          .then(() => note("Started the stage routine."))
          .catch(() => note("The stage routine did not start."));
    }
  }

  #notify(agentId: string, text: string): void {
    try {
      this.#hooks.notifyAgent(agentId, text);
    } catch (error) {
      logger.warn("Loop note failed.", { agentId, error: error instanceof Error ? error.message : "" });
    }
  }

  #event(actor: LoopActor, input: Omit<LoopEventInput, "actorKind" | "actorId">): void {
    this.#store.addEvent({
      ...input,
      actorKind: actor.kind,
      ...(actor.kind === "agent" ? { actorId: actor.agentId } : actor.id ? { actorId: actor.id } : {}),
    });
  }

  #agentExists(agentId: string): boolean {
    return this.#hooks.agents().some((agent) => agent.id === agentId);
  }

  #agentName(agentId: string): string {
    return this.#hooks.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
  }

  #requireSpace(spaceId: string, actor: LoopActor): void {
    if (!this.#hooks.spaceExists(spaceId)) throw new LoopRejected("That space does not exist.");
    if (actor.kind === "agent" && this.#hooks.agentSpace(actor.agentId) !== spaceId)
      throw new LoopRejected("You can work only with the loops of your own space.");
  }

  #requireAgentInSpace(spaceId: string, agentId: string): void {
    if (!this.#agentExists(agentId) || this.#hooks.agentSpace(agentId) !== spaceId)
      throw new LoopRejected(`The agent ${agentId} is not in the loop's space.`);
  }

  #checkOwners(spaceId: string, definition: LoopDefinition): void {
    for (const stage of definition.stages) {
      if (stage.ownerAgentId) this.#requireAgentInSpace(spaceId, stage.ownerAgentId);
      if (stage.onEnter?.routine) this.#requireAgentInSpace(spaceId, stage.onEnter.routine.agentId);
    }
  }

  #loop(loopId: string, actor: LoopActor): Loop {
    const loop = this.#store.loop(loopId);
    if (!loop) throw new LoopRejected("That loop does not exist.");
    this.#requireSpace(loop.spaceId, actor);
    return loop;
  }

  #item(itemId: string, actor: LoopActor): { loop: Loop; item: LoopItem } {
    const item = this.#store.item(itemId);
    if (!item) throw new LoopRejected("That item does not exist.");
    return { loop: this.#loop(item.loopId, actor), item };
  }
}

function checkLabel(loop: Loop, check: string): string {
  const [stageId, index] = check.split(":");
  const stage = loop.stages.find((candidate) => candidate.id === stageId);
  return stage?.checklist?.[Number(index)] ?? check;
}

/** An agent's change keeps every gate: each gated stage stays, with the same kind of gate. */
function keepGates(loop: Loop, definition: LoopDefinition): void {
  for (const stage of loop.stages) {
    if (!stage.gate) continue;
    const kept = definition.stages.find((candidate) => candidate.id === stage.id);
    if (kept?.gate?.kind !== stage.gate.kind)
      throw new LoopRejected(`Only the owner removes or changes the ${stage.gate.kind} gate of "${stage.name}".`);
  }
}
