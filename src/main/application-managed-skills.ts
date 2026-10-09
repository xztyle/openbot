import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { ManagedSkillService } from "./managed-skill-service";

const SLUGS = ["openbot-site-hosting", "openbot-skill-creator", "openbot-data", "openbot-event-checks"];

/** Use the same protected skill installation for current agents and newly created agents. */
export function createApplicationManagedSkills(root: string) {
  const services = SLUGS.map(
    (slug) => new ManagedSkillService(join(root, slug, "SKILL.md"), undefined, undefined, slug),
  );
  return {
    syncAll: (agents: AgentSummary[]) =>
      Effect.forEach(services, (service) => service.syncAll(agents), { discard: true }),
    syncAgent: (agent: AgentSummary) =>
      Effect.forEach(services, (service) => service.syncAgent(agent), { discard: true }),
  };
}
