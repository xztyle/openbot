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

export { activeSpaces, setActiveSpaces };
