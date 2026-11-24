// @vitest-environment node
//
// The trust boundary of docs/approvals.md, "Deletions": which deletions run at once, which go to the
// asking agent's manager, and which wait for the owner.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { impactOf } from "../guardrails/injection-guard";
import { TrustAuditLog } from "./trust-audit-log";
import {
  classifyCommand,
  classifyMcpTool,
  classifyOpenBotTool,
  deletionTier,
  type TrustClassification,
} from "./trust-classifier";
import { TrustService } from "./trust-service";

const AGENTS = [
  { id: "lead", name: "Lead", reportsToAgentId: null },
  { id: "dev", name: "Dev", reportsToAgentId: "lead" },
];

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trust-deletions-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function trust() {
  return new TrustService({
    file: join(root, "policy.json"),
    audit: new TrustAuditLog(join(root, "audit")),
    directory: { agents: () => AGENTS, spaceOf: () => "space" },
  });
}

/** How the default policy treats the call: `run` at once, or `ask` the manager or the owner. */
function route(action: TrustClassification | null): "run" | "manager" | "owner" {
  if (!action) return "run";
  const service = trust();
  if (service.evaluate({ agentId: "dev" }, action).kind === "allow") return "run";
  return service.approverFor(action);
}

describe("deletions at the trust boundary", () => {
  it("deleting a ticket is automatic", () => {
    expect(route(classifyMcpTool("mcp__linear__delete_issue", { id: "ENG-12" }))).toBe("run");
    expect(route(classifyMcpTool("mcp__jira__delete_ticket", { key: "OPS-4" }))).toBe("run");
    expect(route(classifyMcpTool("mcp__motion__delete_ticket", { id: "MAS-3" }))).toBe("run");
    expect(route({ action: "delete", label: "motion", summary: "a ticket", platform: "motion" })).toBe("run");
    expect(route(classifyMcpTool("mcp__notion__delete_page", { id: "p1" }))).toBe("run");
    expect(route(classifyMcpTool("mcp__slack__delete_message", { ts: "1" }))).toBe("run");
  });

  it("deleting a file in a workspace is automatic", () => {
    expect(route(classifyCommand("rm -rf ./build && rm notes/old.md"))).toBe("run");
    expect(route(classifyMcpTool("mcp__filesystem__delete_file", { path: "/work/a.txt" }))).toBe("run");
    expect(route(classifyCommand("git push origin --delete cambio/hero"))).toBe("run");
    expect(route(classifyMcpTool("mcp__neon__delete_branch", { branch: "preview" }))).toBe("run");
  });

  it("deleting a channel asks the owner", () => {
    const tool = classifyOpenBotTool("delete_channel", { channelId: "c1", userAsked: true });
    expect(route(tool)).toBe("owner");
    expect(tool && impactOf("openbot.delete_channel", {}, tool)?.kind).toBe("delete");
    expect(route(classifyMcpTool("mcp__slack__delete_channel", { id: "C1" }))).toBe("owner");
    // Without userAsked the tool refuses the call itself, so no card shows.
    expect(classifyOpenBotTool("delete_channel", { channelId: "c1" })).toBeNull();
  });

  it("deleting an agent asks the owner", () => {
    expect(route(classifyMcpTool("mcp__team__delete_agent", { agentId: "a1" }))).toBe("owner");
    expect(deletionTier("", "delete_agents")).toBe("owner");
    expect(deletionTier("", "delete_space")).toBe("owner");
  });

  it("deleting a live site, app, database or credential asks the owner", () => {
    expect(route(classifyCommand("python3 /opt/appctl/appctl delete shop"))).toBe("owner");
    expect(route(classifyCommand("python3 /opt/appctl/appctl db drop shop"))).toBe("owner");
    expect(route(classifyCommand('R=/x/render-sites.mjs; node "$R" delete promo'))).toBe("owner");
    expect(route(classifyCommand('R=/x/render-sites.mjs; node "$R" delete promo-preview'))).toBe("run");
    expect(route(classifyMcpTool("mcp__supabase__delete_rows", { table: "orders" }))).toBe("owner");
    expect(route(classifyMcpTool("mcp__vercel__delete_project", { id: "p" }))).toBe("owner");
    expect(route(classifyMcpTool("mcp__google__revoke_connection", {}))).toBe("owner");
    expect(route(classifyOpenBotTool("remove_api_key", { name: "STRIPE" }))).toBe("owner");
    expect(route(classifyCommand("git push --force origin main"))).toBe("owner");
    expect(route(classifyCommand("git push origin +HEAD:production"))).toBe("owner");
  });

  it("deleting a routine goes to the manager", () => {
    const routine = classifyOpenBotTool("delete_routine", { routineId: "r1" });
    expect(route(routine)).toBe("manager");
    expect(route(classifyOpenBotTool("uninstall_skill", { skillId: "s1" }))).toBe("manager");
    expect(route(classifyOpenBotTool("delete_table", { name: "leads" }))).toBe("manager");
    expect(route(classifyOpenBotTool("execute_data", { sql: "DROP TABLE leads" }))).toBe("manager");
    expect(classifyOpenBotTool("execute_data", { sql: "DELETE FROM leads WHERE id = 1" })).toBeNull();
    expect(route(classifyMcpTool("mcp__cron__delete_schedule", { id: "s" }))).toBe("manager");
  });
});
