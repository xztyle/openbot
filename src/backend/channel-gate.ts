import {
  CHANNEL_GATE_ANSWER_LIMIT,
  CHANNEL_GATE_REASON_LIMIT,
  type ChannelAnswerMode,
  type ChannelGateDecision,
  type ChannelGateFallback,
  type ChannelMessage,
} from "@openbot/contracts/ipc";
import { Effect, Fiber, Option, Result, Schema, type Scope } from "effect";
import { extractJsonObject } from "./structured-output";

/** The messages before the new one that the gate reads, and the characters of each and of all. */
const GATE_RECENT_MESSAGES = 20;
const GATE_MESSAGE_CHARACTERS = 600;
const GATE_RECENT_CHARACTERS = 8_000;
const GATE_NEW_MESSAGE_CHARACTERS = 4_000;
const GATE_PROFILE_CHARACTERS = 600;

/** One `always` member that the gate asks about. */
export interface ChannelGateAgent {
  agentId: string;
  name: string;
  title: string;
  description: string;
  focus?: string;
  /** What the agent does now, one short line each: a running turn, its open tasks. */
  activity: readonly string[];
}

/** Another member agent of the channel, so the gate knows who else could answer. */
export interface ChannelGateMember {
  agentId: string;
  name: string;
  title: string;
  focus?: string;
  answerMode: ChannelAnswerMode;
}

export interface ChannelGateRequest {
  channel: { name: string; title: string; topic?: string; description?: string };
  /** The new message of a person. */
  message: ChannelMessage;
  /** The root of its thread, when it is a thread reply. */
  threadRoot: ChannelMessage | null;
  /** The messages before it in the channel, or in the thread, oldest first. */
  recent: readonly ChannelMessage[];
  /** The gated members, in channel order. */
  agents: readonly ChannelGateAgent[];
  /** Every member agent of the channel, the gated ones included. */
  members: readonly ChannelGateMember[];
}

/** The cheap model: one toolless generation for each prompt. */
export interface ChannelGateModel {
  /** `provider/model`, for the decision log. */
  label: string;
  timeoutMs: number;
  generate(agentId: string, prompt: string): Effect.Effect<string, unknown>;
}

const GateAnswer = Schema.Struct({
  answer: Schema.Boolean,
  reason: Schema.String,
  priority: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
const decodeGateAnswer = Schema.decodeUnknownResult(GateAnswer, { onExcessProperty: "error" });

/**
 * Decides, with a cheap model, which `always` members of a channel answer one message of a person.
 * It owns the prompt, the strict decoding of each answer, the time budget and the answer limit. It
 * reads no store and starts no turn: `ChannelService` gives it the context and creates the tasks.
 *
 * A generation that is still running at the deadline is not stopped. It ends in `scope`, so the warm
 * client that runs it stays warm for the next message; its late answer is dropped.
 */
export class ChannelGate {
  decide(
    request: ChannelGateRequest,
    model: ChannelGateModel,
    scope: Scope.Scope,
  ): Effect.Effect<ChannelGateDecision[]> {
    return Effect.gen(function* () {
      const started = Date.now();
      const deadline = started + model.timeoutMs;
      const fibers = yield* Effect.forEach(request.agents, (agent) =>
        Effect.forkIn(model.generate(agent.agentId, gatePrompt(request, agent)), scope).pipe(
          Effect.map((fiber) => ({ agent, fiber })),
        ),
      );
      return yield* Effect.forEach(
        fibers,
        ({ agent, fiber }) =>
          Effect.gen(function* () {
            const outcome = yield* Effect.result(Fiber.join(fiber)).pipe(
              Effect.timeoutOption(Math.max(0, deadline - Date.now())),
            );
            const ms = Date.now() - started;
            const fallback = (reason: ChannelGateFallback) => gateFallback(agent.agentId, reason, model.label, ms);
            if (Option.isNone(outcome)) return fallback("timeout");
            if (Result.isFailure(outcome.value)) return fallback("error");
            const answer = parseGateAnswer(outcome.value.success);
            return answer ? { agentId: agent.agentId, ...answer, model: model.label, ms } : fallback("invalid");
          }),
        { concurrency: "unbounded" },
      );
    });
  }
}

/** The decision for a member that the gate could not ask: it does not answer, as a `mention` member. */
export function gateFallback(agentId: string, fallback: ChannelGateFallback, model = "", ms = 0): ChannelGateDecision {
  return { agentId, answer: false, reason: "", priority: 0, model, ms, fallback };
}

/** The decoded answer of the model, or null when it is not exactly the requested object. */
export function parseGateAnswer(text: string): { answer: boolean; reason: string; priority: number } | null {
  let value: unknown;
  try {
    value = extractJsonObject(text);
  } catch {
    return null;
  }
  const decoded = decodeGateAnswer(value);
  if (Result.isFailure(decoded)) return null;
  return {
    answer: decoded.success.answer,
    reason: decoded.success.reason.replace(/\s+/gu, " ").trim().slice(0, CHANNEL_GATE_REASON_LIMIT),
    priority: decoded.success.priority,
  };
}

/**
 * The agents that answer, from the decisions in channel order: at most `CHANNEL_GATE_ANSWER_LIMIT`,
 * the highest priority first, and on a tie the earlier member. Each decision that wanted to answer
 * and lost its place gets `limited`.
 */
export function gateWinners(decisions: readonly ChannelGateDecision[]): {
  agentIds: string[];
  decisions: ChannelGateDecision[];
} {
  const wanted = decisions
    .map((decision, order) => ({ decision, order }))
    .filter(({ decision }) => decision.answer && decision.fallback === undefined)
    .sort((left, right) => right.decision.priority - left.decision.priority || left.order - right.order)
    .slice(0, CHANNEL_GATE_ANSWER_LIMIT)
    .map(({ decision }) => decision.agentId);
  const chosen = new Set(wanted);
  return {
    agentIds: decisions.filter((decision) => chosen.has(decision.agentId)).map((decision) => decision.agentId),
    decisions: decisions.map((decision) =>
      decision.answer && decision.fallback === undefined && !chosen.has(decision.agentId)
        ? { ...decision, limited: true }
        : decision,
    ),
  };
}

function clip(text: string, characters: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > characters ? `${flat.slice(0, characters - 1)}…` : flat;
}

function line(message: ChannelMessage, characters: number): string {
  const kind = message.author.kind === "agent" ? "agent" : "person";
  const attachments = message.message.attachments?.length
    ? ` [${message.message.attachments.length} attachment(s)]`
    : "";
  return `${message.author.name} (${kind}): ${clip(message.message.text, characters)}${attachments}`;
}

/** The newest messages that fit the budget, oldest first. */
function transcript(messages: readonly ChannelMessage[]): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse().slice(0, GATE_RECENT_MESSAGES)) {
    const text = line(message, GATE_MESSAGE_CHARACTERS);
    if (used + text.length > GATE_RECENT_CHARACTERS) break;
    used += text.length;
    lines.unshift(text);
  }
  return lines;
}

export function gatePrompt(request: ChannelGateRequest, agent: ChannelGateAgent): string {
  const others = request.members.filter((member) => member.agentId !== agent.agentId);
  const recent = transcript(request.recent);
  const channel = request.channel;
  return [
    `You decide if the AI agent "${agent.name}" answers the newest message in a team chat channel.`,
    "People and AI agents work together in this channel. Several agents can read the same message;",
    "only the ones that should answer do. Unnecessary answers are noise.",
    "",
    "Answer true when one of these is true:",
    "- The message addresses this agent, by name or by its role.",
    "- The message is about this agent's remit, its focus in this channel, or the work it does now.",
    "- The message asks a question or asks for work, and no other member is better placed to answer it.",
    "Answer false when one of these is true:",
    "- People talk to each other and nobody asks for help.",
    "- The message is aimed at another person or another agent.",
    "- The message is only an acknowledgement, thanks, a greeting or a reaction.",
    "- Another member clearly owns the subject.",
    "",
    "Reply with one JSON object only, no other text:",
    '{"answer": true or false, "reason": "why, at most 120 characters", "priority": number from 0 to 1}',
    "priority: how clearly answering is this agent's job (1 = certainly, 0 = not at all).",
    "",
    `Channel: #${channel.name}${channel.title && channel.title !== channel.name ? ` (${clip(channel.title, 120)})` : ""}`,
    ...(channel.topic ? [`Topic: ${clip(channel.topic, 250)}`] : []),
    ...(channel.description ? [`Description: ${clip(channel.description, GATE_PROFILE_CHARACTERS)}`] : []),
    "",
    `The agent: ${agent.name}${agent.title ? ` - ${clip(agent.title, 120)}` : ""}`,
    ...(agent.description ? [`Description: ${clip(agent.description, GATE_PROFILE_CHARACTERS)}`] : []),
    `Focus in this channel: ${agent.focus ? clip(agent.focus, GATE_PROFILE_CHARACTERS) : "(none given)"}`,
    `Doing now: ${agent.activity.length ? agent.activity.map((item) => clip(item, 200)).join("; ") : "nothing"}`,
    "",
    "Other agents in the channel:",
    ...(others.length
      ? others.map(
          (member) =>
            `- ${member.name}${member.title ? ` - ${clip(member.title, 120)}` : ""}${
              member.focus ? `; focus: ${clip(member.focus, 300)}` : ""
            }${member.answerMode === "mention" ? "; answers when mentioned" : ""}`,
        )
      : ["(none)"]),
    "",
    ...(request.threadRoot
      ? ["The message is a reply in a thread. Thread start:", line(request.threadRoot, GATE_MESSAGE_CHARACTERS), ""]
      : []),
    request.threadRoot ? "Earlier replies in the thread, oldest first:" : "Earlier messages, oldest first:",
    ...(recent.length ? recent : ["(none)"]),
    "",
    "The newest message, which you decide about:",
    line(request.message, GATE_NEW_MESSAGE_CHARACTERS),
  ].join("\n");
}
