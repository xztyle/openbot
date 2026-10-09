import type { EventCheckAuthor } from "@openbot/contracts/event-checks";

/**
 * Who asks for a change that touches secrets or trust: the person at the app on this computer, a
 * signed-in team member of a host, or an agent that calls a tool. A caller always names itself.
 * There is no default, so a new call path cannot pass for the user by leaving this out.
 */
export type SecurityActor =
  | { kind: "user" }
  | { kind: "member"; memberId: string; name: string }
  | { kind: "agent"; agentId: string; name: string };

export const LOCAL_USER_ACTOR: SecurityActor = { kind: "user" };

/** Control characters and line breaks never reach a prompt or a log line from a name. */
export function plainName(value: string): string {
  return (
    Array.from(value)
      .map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character))
      .join("")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 80) || "unnamed"
  );
}

export function isAgentActor(actor: SecurityActor): boolean {
  return actor.kind === "agent";
}

export function authorOf(actor: SecurityActor): EventCheckAuthor {
  if (actor.kind === "user") return { kind: "user" };
  if (actor.kind === "member") return { kind: "member", name: plainName(actor.name) };
  return { kind: "agent", agentId: actor.agentId, name: plainName(actor.name) };
}

/** A signed-in team member of this host. The display name is a label only; the identifier is the identity. */
export function memberActor(member: { id: string; name: string | null; username: string }) {
  return { kind: "member", memberId: member.id, name: member.name || member.username } satisfies SecurityActor;
}
