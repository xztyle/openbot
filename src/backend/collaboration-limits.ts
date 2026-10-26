import { AGENT_CREATION_WINDOW_HOURS } from "@openbot/contracts/ipc";

/**
 * Limits for the traffic between agents. They are named so a test, the docs and the code read one
 * value. Each one is generous: it stops a loop, not a team that works fast.
 */

/** How many messages one agent may send to one other agent inside `AGENT_MESSAGE_WINDOW_MS`. */
export const AGENT_MESSAGE_LIMIT = 20;
export const AGENT_MESSAGE_WINDOW_MS = 10 * 60_000;

/**
 * How long an answer waits for the other teammates that got the same request. After this time the
 * answer starts a turn, and the prompt names the teammates that are still outstanding.
 */
export const ANSWER_HOLD_LIMIT_MS = 20 * 60_000;

/**
 * The window of the user's optional cap on how many agents all agents together may create. The cap
 * itself is a setting (`AgentCreationLimitPreference`); there is none by default.
 */
export const AGENT_CREATION_WINDOW_MS = AGENT_CREATION_WINDOW_HOURS * 60 * 60_000;
