import {
  type ConversationMessage,
  type ConversationTraceStep,
  type ConversationTurnTrace,
  WORKSPACE_STEP_DETAIL_LIMIT,
  WORKSPACE_STEP_LABEL_LIMIT,
  WORKSPACE_STEP_LIMIT,
  type WorkspaceStep,
  type WorkspaceStepKind,
  type WorkspaceSteps,
} from "@openbot/contracts/ipc";

function cut(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** The first line of a thought, without Markdown heading and emphasis marks. */
export function thoughtTitle(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return cut(line.replace(/^#+\s*/u, "").replaceAll("**", ""), WORKSPACE_STEP_LABEL_LIMIT);
}

/**
 * The kind of a stored tool step. A step stored before the host kept its category is read from its
 * command and from the host's progress text, which is English source text.
 */
export function traceStepKind(step: ConversationTraceStep): WorkspaceStepKind {
  if (step.category) return step.category;
  if (step.command) return "shell";
  const text = step.text?.toLowerCase() ?? "";
  if (text.includes("skill")) return "skill";
  if (text.includes("searching") || text.includes("sources")) return "search";
  if (text.includes("changes") || text.includes("gathering")) return "file";
  return "tool";
}

/** What a stored tool step shows: its label, its command, or the host's progress text. */
export function traceStepLabel(step: ConversationTraceStep): string {
  const command = step.command?.trim().split("\n", 1)[0];
  return cut(step.label ?? command ?? step.text ?? "", WORKSPACE_STEP_LABEL_LIMIT);
}

export interface WorkspaceStepsSource {
  /** The trace of the turn: the live one of a running turn, or the stored one of a finished turn. */
  trace: ConversationTurnTrace | null;
  /** The messages of the turn, for the titles of its thoughts. */
  messages: readonly ConversationMessage[];
  startedAt: string;
  completedAt: string | null;
  running: boolean;
  costUsd?: number | null | undefined;
  now: number;
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The step trail of one turn: its thoughts and its tool steps, in start order. The answer itself is
 * not a step. A turn with no trace (one that ended before the host kept traces) shows its thoughts.
 * Only the last `WORKSPACE_STEP_LIMIT` steps are kept; `total` counts all of them.
 */
export function workspaceSteps(source: WorkspaceStepsSource): WorkspaceSteps {
  const thoughts = new Map<string, ConversationMessage>();
  for (const message of source.messages)
    if (message.author === "assistant" && message.itemType === "commentary") thoughts.set(message.id, message);
  const steps: WorkspaceStep[] = [];
  if (source.trace) {
    for (const step of source.trace.steps) {
      const at = time(step.startedAt);
      if (at === null || step.kind === "message") continue;
      const ended = time(step.endedAt);
      const status: WorkspaceStep["status"] = step.failed
        ? "failed"
        : ended === null && source.running
          ? "running"
          : "done";
      const durationMs = ended === null ? undefined : Math.max(0, ended - at);
      if (step.kind === "reasoning") {
        const label = thoughtTitle(thoughts.get(step.id)?.text ?? "");
        if (!label) continue;
        steps.push({
          id: step.id,
          kind: "think",
          label,
          status,
          at,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        continue;
      }
      const command = step.command?.trim();
      steps.push({
        id: step.id,
        kind: traceStepKind(step),
        label: traceStepLabel(step),
        ...(command?.includes("\n") ? { detail: command.slice(0, WORKSPACE_STEP_DETAIL_LIMIT) } : {}),
        status,
        at,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    }
  } else {
    for (const message of thoughts.values()) {
      const at = time(message.createdAt);
      const label = thoughtTitle(message.text);
      if (at === null || !label) continue;
      steps.push({
        id: message.id,
        kind: "think",
        label,
        status: message.status === "streaming" ? "running" : "done",
        at,
      });
    }
  }
  const startedAt = time(source.trace?.startedAt) ?? time(source.startedAt);
  const endedAt = source.running ? source.now : (time(source.trace?.endedAt) ?? time(source.completedAt) ?? source.now);
  const cost = source.costUsd;
  return {
    steps: steps.slice(-WORKSPACE_STEP_LIMIT),
    total: steps.length,
    durationMs: startedAt === null ? 0 : Math.max(0, endedAt - startedAt),
    streaming: source.running,
    ...(startedAt === null ? {} : { startedAt }),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
  };
}

/** The label of the last tool step of a running turn, for the fleet. */
export function lastToolStep(trace: ConversationTurnTrace | null): { label: string; kind: WorkspaceStepKind } | null {
  if (!trace) return null;
  for (let index = trace.steps.length - 1; index >= 0; index -= 1) {
    const step = trace.steps[index];
    if (step?.kind !== "tool") continue;
    const label = traceStepLabel(step);
    if (label) return { label, kind: traceStepKind(step) };
  }
  return null;
}
