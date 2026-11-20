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

/**
 * The skin tones of the faces, light to deep. A workspace gives every agent one of them (or `varied`,
 * a tone from each agent's seed), and an agent can choose its own (`faceSkin`).
 */
export const AGENT_FACE_SKINS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
export type AgentFaceSkin = (typeof AGENT_FACE_SKINS)[number];

export function isAgentFaceSkin(value: unknown): value is AgentFaceSkin {
  return isOneOf(AGENT_FACE_SKINS, value);
}

/** The longest seed of a re-rolled face. */
export const AGENT_FACE_SEED_LIMIT = 64;

/** A re-rolled face: any text of 1 to 64 characters. The agent's id gives its face without one. */
export function isAgentFaceSeed(value: unknown): value is string {
  return isBoundedString(value, AGENT_FACE_SEED_LIMIT) && value.trim().length > 0;
}
