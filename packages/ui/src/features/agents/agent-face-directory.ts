import { createSignal } from "solid-js";

/** What an agent's face needs besides its seed: the name (its role words pick the hat) and the agent's own choice. */
export interface AgentFaceEntry {
  name: string;
  title?: string | undefined;
  faceStyle?: string | undefined;
  faceSeed?: string | undefined;
  faceSkin?: string | undefined;
}

interface DirectoryAgent extends AgentFaceEntry {
  avatarSeed: string;
}

const [directory, setDirectory] = createSignal<ReadonlyMap<string, AgentFaceEntry>>(new Map());

function sameEntry(left: AgentFaceEntry | undefined, right: AgentFaceEntry): boolean {
  return (
    left !== undefined &&
    left.name === right.name &&
    left.title === right.title &&
    left.faceStyle === right.faceStyle &&
    left.faceSeed === right.faceSeed &&
    left.faceSkin === right.faceSkin
  );
}

/**
 * Tells every face which agent wears it, by the agent's avatar seed. A surface that knows only the
 * seed of an agent, such as a member row or a mention, then draws the same person with the same hat
 * and the agent's own face choice as its chat. The app calls it with each new agent list.
 */
export function registerAgentFaces(agents: readonly DirectoryAgent[]): void {
  const current = directory();
  let changed = false;
  const next = new Map(current);
  for (const agent of agents) {
    const entry: AgentFaceEntry = {
      name: agent.name,
      title: agent.title,
      faceStyle: agent.faceStyle,
      faceSeed: agent.faceSeed,
      faceSkin: agent.faceSkin,
    };
    if (sameEntry(current.get(agent.avatarSeed), entry)) continue;
    next.set(agent.avatarSeed, entry);
    changed = true;
  }
  if (changed) setDirectory(next);
}

/** The agent that wears the face of this seed, when the app registered one. */
export function agentFaceEntry(seed: string): AgentFaceEntry | undefined {
  return directory().get(seed);
}
