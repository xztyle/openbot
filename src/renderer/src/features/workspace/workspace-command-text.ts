/*
 * The words of the command bar (`workspace-commands.tsx`): its verbs, and the agent that an "ask"
 * names. No DOM and no state.
 */
// Whole words: "Tell me the costs" is a sentence for the lead, and "assignment" is no verb.
const ASK = /^(?:(?:ask|assign|tell)\b|@)\s*/iu;
export const APPROVE = /^(?:approve|ok|decide|decisions?|waiting)\b/iu;
export const STOP = /^(?:stop|halt|pause)\b/iu;
export const GOAL = /^(?:goal|set (?:a )?goal|new goal)\b/iu;

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Whether the text starts with a verb of the command bar, so a "Create #approve" row is noise. */
export function isCommandText(text: string): boolean {
  const trimmed = text.trim();
  return [ASK, APPROVE, STOP, GOAL].some((verb) => verb.test(trimmed));
}

export type AskTarget<Agent extends { name: string }> =
  /** The agent that the text names, and what to send it; an empty message only picks the agent. */
  | { kind: "named"; agent: Agent; message: string }
  /** The agents whose name starts with what follows the verb. */
  | { kind: "pick"; agents: readonly Agent[] };

/**
 * What "ask Research: compare the prices" or "@research compare the prices" asks: the agent and the
 * message. The longest name wins ("Research Lead" over "Research"), and a name ends at a word end,
 * so "ask Researchers…" does not send "ers…" to Research. Null when the text asks no one: no verb,
 * or a sentence after the verb that names no agent, which goes to the lead instead.
 */
export function askTarget<Agent extends { name: string }>(
  text: string,
  agents: readonly Agent[],
): AskTarget<Agent> | null {
  if (!ASK.test(text)) return null;
  const rest = text.replace(ASK, "");
  const folded = fold(rest);
  const named = agents
    .filter((agent) => {
      const name = fold(agent.name);
      return name && folded.startsWith(name) && !/[\p{L}\p{N}]/u.test(folded.charAt(name.length));
    })
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (named)
    return {
      kind: "named",
      agent: named,
      message: rest
        .slice(named.name.length)
        .replace(/^[\s:,-]+/u, "")
        .trim(),
    };
  const words = rest.trim().split(/\s+/u).filter(Boolean);
  const partial = fold(words[0] ?? "");
  const picks = agents.filter((agent) => !partial || fold(agent.name).startsWith(partial)).slice(0, 5);
  if (picks.length === 0 && words.length >= 2) return null;
  return { kind: "pick", agents: picks };
}
