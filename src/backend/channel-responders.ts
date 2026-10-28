import type { Channel, ChannelAnswerMode, ChannelGateDecision, ChannelMessage } from "@openbot/contracts/ipc";
import { Effect, type Scope } from "effect";
import {
  ChannelGate,
  type ChannelGateModel,
  type ChannelGateRequest,
  gateFallback,
  gateFirstRound,
  gateSecondRound,
} from "./channel-gate";

/** What `ChannelResponders.select` knows about a person's message besides the channel. */
export interface ChannelResponderInput {
  /** The member agents that can take new work: present, not hidden. */
  eligible: readonly string[];
  /** The message of a person, with its `mentions`. */
  message: ChannelMessage;
  /** The message it replies to, if any. */
  replyTo?: ChannelMessage | null;
  /** The root of its thread, with the thread summary, if it is a thread reply. */
  threadRoot?: ChannelMessage | null;
  /** An agent the sender chose for this message. It answers alone, as before the workspace. */
  recipientAgentId?: string | null;
}

/**
 * Which member agents answer one message of a person.
 *
 * - `agentIds` answer now: mentioned, replied to, taking part in the thread, or `always-no-gate`.
 * - `gated` are the `always` members that are not addressed, and on `@channel`, `@here` or
 *   `@everyone` the `mention` members too. `ChannelResponders.gate` decides for each of them after
 *   the message is stored, so the person sees it at once.
 * - `lead` is true when the channel routes the message with its lead as before the workspace: a
 *   member with no answer mode, or with `lead`, and no other member selected.
 */
export interface ChannelResponderSelection {
  agentIds: string[];
  gated: string[];
  lead: boolean;
}

/** A channel with no member answer mode routes every message through its lead, as before. */
export function usesAnswerModes(channel: Channel): boolean {
  return channel.members.some((member) => member.answerMode !== undefined);
}

export function memberAnswerMode(channel: Channel, agentId: string): ChannelAnswerMode {
  return channel.members.find((member) => member.agentId === agentId)?.answerMode ?? "lead";
}

/**
 * The gated members that answer, and the decision for each gated member, for the log. After a first
 * round, `followUp` holds the other members that wanted to answer, the highest priority first: they
 * wait for the first answer and are asked again once.
 */
export interface ChannelGateOutcome {
  agentIds: string[];
  decisions: ChannelGateDecision[];
  followUp?: string[];
}

/**
 * Selects the agents that answer a message of a person, in two steps: `select` at once, for the
 * addressed members and the `always-no-gate` ones, and `gate`, which asks the cheap model about each
 * gated member. In the first round only the member with the highest priority answers; after its
 * answer the gate asks the others that wanted to answer again, once, with that answer, so at most
 * `CHANNEL_GATE_ANSWER_LIMIT` gated members answer one message. It never selects for a
 * message of an agent: agents start each other only with an explicit mention (`ChannelService` limits
 * that chain).
 */
export class ChannelResponders {
  readonly #gate = new ChannelGate();

  /**
   * The gated members that answer. With no gate model, or for a member whose question fails or takes
   * longer than the budget, the member answers as a `mention` member would: not at all, because
   * `select` already took every addressed member.
   */
  gate(
    request: ChannelGateRequest,
    model: ChannelGateModel | null,
    scope: Scope.Scope,
  ): Effect.Effect<ChannelGateOutcome> {
    if (!request.agents.length) return Effect.succeed({ agentIds: [], decisions: [] });
    const decisions = model
      ? this.#gate.decide(request, model, scope)
      : Effect.succeed(request.agents.map((agent) => gateFallback(agent.agentId, "error")));
    return decisions.pipe(Effect.map(request.answers ? gateSecondRound : gateFirstRound));
  }

  select(channel: Channel, input: ChannelResponderInput): ChannelResponderSelection {
    const eligible = new Set(input.eligible);
    if (input.recipientAgentId)
      return { agentIds: eligible.has(input.recipientAgentId) ? [input.recipientAgentId] : [], gated: [], lead: false };
    const addressed = new Set<string>();
    for (const mention of input.message.mentions ?? [])
      if (mention.kind === "agent" && mention.id && eligible.has(mention.id)) addressed.add(mention.id);
    const broadcast = (input.message.mentions ?? []).some(
      (mention) => mention.kind === "channel" || mention.kind === "here",
    );
    const repliedAgent = input.replyTo?.author.kind === "agent" ? input.replyTo.author.id : null;
    if (repliedAgent && eligible.has(repliedAgent)) addressed.add(repliedAgent);
    const thread = input.threadRoot;
    if (thread?.author.kind === "agent" && eligible.has(thread.author.id)) addressed.add(thread.author.id);
    const agentIds: string[] = [];
    const gated: string[] = [];
    let leadMembers = 0;
    for (const member of channel.members) {
      if (!eligible.has(member.agentId)) continue;
      const mode = member.answerMode ?? "lead";
      const inThread = thread?.threadSummary?.participantIds.includes(member.agentId) ?? false;
      if (addressed.has(member.agentId) || (mode !== "lead" && inThread)) agentIds.push(member.agentId);
      else if (mode === "always-no-gate") agentIds.push(member.agentId);
      // A broadcast addresses every member, so the gate also asks the ones that answer only when
      // mentioned: without it, each of them would answer the same message.
      else if (mode === "always" || (mode === "mention" && broadcast)) gated.push(member.agentId);
      else if (mode === "lead") leadMembers += 1;
    }
    return { agentIds, gated, lead: agentIds.length === 0 && gated.length === 0 && leadMembers > 0 };
  }
}
