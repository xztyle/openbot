import { isBoundedString } from "./ipc-bounded-values";
import { isOneOf } from "./runtime-values";

/**
 * The families of the Atelier agent faces. A workspace has a default family (or `mixed`, see
 * `WorkspaceAppearance`), and an agent can choose one of its own (`faceStyle`).
 */
export const AGENT_FACE_STYLES = ["portrait", "sketch", "flat", "clay", "character"] as const;
export type AgentFaceStyle = (typeof AGENT_FACE_STYLES)[number];

export function isAgentFaceStyle(value: unknown): value is AgentFaceStyle {
  return isOneOf(AGENT_FACE_STYLES, value);
}

/** The longest seed of a re-rolled face. */
export const AGENT_FACE_SEED_LIMIT = 64;

/** A re-rolled face: any text of 1 to 64 characters. The agent's id gives its face without one. */
export function isAgentFaceSeed(value: unknown): value is string {
  return isBoundedString(value, AGENT_FACE_SEED_LIMIT) && value.trim().length > 0;
}
