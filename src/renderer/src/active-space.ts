import { createSignal } from "solid-js";

/**
 * The spaces of the open workspace, for the parts of the app outside it: a new agent that the reader
 * makes from any form starts in the space that shows, and agent settings move an agent. The
 * workspace controller sets it; it is null on a host without spaces.
 */
export interface ActiveSpaces {
  current: () => string;
  options: () => readonly { value: string; label: string }[];
  agentSpace: (agentId: string) => string;
  /** Present when the reader may move agents. */
  moveAgent?: ((agentId: string, spaceId: string) => void) | undefined;
}

const [activeSpaces, setActiveSpaces] = createSignal<ActiveSpaces | null>(null);

/** The space that a new agent starts in, or undefined on a host without spaces. */
export function activeSpace(): string | undefined {
  return activeSpaces()?.current();
}

/** The Space field of agent settings, or undefined on a host without spaces. */
export function agentSpaceSetting(agentId: string) {
  const spaces = activeSpaces();
  if (!spaces) return undefined;
  const move = spaces.moveAgent;
  return {
    value: spaces.agentSpace(agentId),
    options: spaces.options(),
    onChange: move ? (spaceId: string) => move(agentId, spaceId) : undefined,
  };
}

/**
 * The agent that shows when the open one is gone, as after a delete: the first of `agents` in the
 * space that shows, so the chat stays in that space, else the first of all.
 */
export function firstAgentOfActiveSpace<Agent extends { id: string }>(agents: readonly Agent[]): Agent | undefined {
  const spaces = activeSpaces();
  if (!spaces) return agents[0];
  const current = spaces.current();
  return agents.find((agent) => spaces.agentSpace(agent.id) === current) ?? agents[0];
}

export { activeSpaces, setActiveSpaces };
