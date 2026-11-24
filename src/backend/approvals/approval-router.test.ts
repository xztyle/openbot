// @vitest-environment node
//
// The trust boundary of docs/approvals.md: which tier each request falls in, who answers it, the
// manager's approve / decline / escalate, the climb after 2 hours, the loop guard against
// self-approval, and money that stays the owner's.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_CLIMB_MS, approverCandidates, ownerOnlyClassOf } from "@openbot/contracts/agent-approvals";
import { DEFAULT_TRUST_POLICY, normalizeTrustPolicy } from "@openbot/contracts/trust-control";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustAuditLog } from "../trust/trust-audit-log";
import type { TrustClassification } from "../trust/trust-classifier";
import { TrustService } from "../trust/trust-service";
import { type ApprovalAgent, type ApprovalHandler, ApprovalRouter, type ToOwnerReason } from "./approval-router";

// Ceo leads the space; Lead reports to Ceo; Dev and Qa report to Lead. Solo is a top-level agent alone.
const AGENTS: ApprovalAgent[] = [
  { id: "ceo", name: "Ceo", reportsToAgentId: null },
  { id: "lead", name: "Lead", reportsToAgentId: "ceo" },
  { id: "dev", name: "Dev", reportsToAgentId: "lead" },
  { id: "qa", name: "Qa", reportsToAgentId: "lead" },
  { id: "solo", name: "Solo", reportsToAgentId: null },
];

let root = "";
let now = Date.parse("2026-11-24T10:00:00Z");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "approvals-"));
  now = Date.parse("2026-11-24T10:00:00Z");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(agents: ApprovalAgent[] = AGENTS) {
  const audit = new TrustAuditLog(join(root, "audit"), () => new Date(now));
  const trust = new TrustService({
    file: join(root, "policy.json"),
    audit,
    directory: { agents: () => agents, spaceOf: () => "space" },
    now: () => now,
  });
  const wakes: { agentId: string; text: string }[] = [];
  const router = new ApprovalRouter({
    agents: () => agents,
    spaceOf: () => "space",
    wake: async (input) => {
      wakes.push(input);
    },
    record: (entry) => trust.record(entry),
    stateFile: join(root, "approvals.json"),
    log: () => undefined,
    now: () => now,
  });
  trust.attachApprovals(router);
  return { trust, router, wakes, audit };
}

function recorder() {
  const settled: { verdict: string; note: string; by: string; option?: number | undefined }[] = [];
  const owner: ToOwnerReason[] = [];
  const handler: ApprovalHandler = {
    settle: (_request, answer) => {
      settled.push({ verdict: answer.verdict, note: answer.note, by: answer.byName, option: answer.option });
    },
    toOwner: (_request, why) => {
      owner.push(why);
    },
  };
  return { handler, settled, owner };
}

const request = (id: string, askerId: string) => ({
  id,
  source: "ticket" as const,
  askerId,
  title: `MAS-12 · Plan de campaña ${id}`,
  reason: "Accept the plan as is or send it back",
  evidence: "The grader sent it back three times.",
  reviewEscalated: true,
});

const action = (kind: TrustClassification["action"]): TrustClassification => ({
  action: kind,
  label: `test ${kind}`,
  summary: `a ${kind} action`,
});

describe("the tiers at the trust boundary", () => {
  it("tier 0: reversible work runs at once and asks nobody", () => {
    const { trust } = setup();
    for (const kind of ["publish", "email", "create_agent"] as const)
      expect(trust.evaluate({ agentId: "dev" }, action(kind)).kind).toBe("allow");
    expect(trust.evaluate({ agentId: "dev" }, { ...action("delete"), platform: "motion" }).kind).toBe("allow");
  });

  it("tier 1: a rule that asks goes to the manager for publish, email and new agents", () => {
    const { trust } = setup();
    for (const kind of ["publish", "email", "create_agent"] as const)
      expect(trust.approverFor(action(kind))).toBe("manager");
    expect(approverCandidates(AGENTS, "dev")).toEqual(["lead", "ceo"]);
  });

  it("tier 2: money and deletions ask the owner, whatever a stored policy says", () => {
    const { trust } = setup();
    expect(trust.evaluate({ agentId: "dev" }, action("pay")).kind).toBe("ask");
    expect(trust.evaluate({ agentId: "dev" }, action("launch_ads")).kind).toBe("ask");
    expect(trust.evaluate({ agentId: "dev" }, action("delete")).kind).toBe("ask");
    for (const kind of ["pay", "launch_ads", "delete"] as const) expect(trust.approverFor(action(kind))).toBe("owner");
    const stored = normalizeTrustPolicy({
      ...DEFAULT_TRUST_POLICY,
      approvers: { pay: "manager", launch_ads: "manager", delete: "manager", publish: "owner" },
    });
    expect(stored?.approvers).toMatchObject({ pay: "owner", launch_ads: "owner", delete: "owner", publish: "owner" });
    expect(ownerOnlyClassOf("Pay 40 USD for the Black Friday ad set")).toBe("money");
    expect(ownerOnlyClassOf("Subir el presupuesto diario a 20 USD")).toBe("money");
    // Ads, Meta, a price or a budget named in the text is no spend.
    expect(
      ownerOnlyClassOf("Accept the Meta ad copy drafts; the plan proposes a 70 USD budget and a price of 19"),
    ).toBeNull();
    expect(ownerOnlyClassOf("Textos de anuncios para Meta con presupuesto propuesto de 70 USD")).toBeNull();
    expect(ownerOnlyClassOf("Pagar la suscripción anual")).toBe("money");
    expect(ownerOnlyClassOf("Eliminar la base de datos de producción")).toBe("deletion");
    expect(ownerOnlyClassOf("Necesito la contraseña de Hotmart")).toBe("credentials");
    expect(ownerOnlyClassOf("Accept the plan for the Christmas campaign")).toBeNull();
  });

  it("money stays owner-only: a gated payment never reaches a manager", async () => {
    const { trust, router } = setup();
    let ownerAsked = 0;
    const result = await Effect.runPromise(
      trust.gate({ agentId: "dev" }, { ...action("pay"), amount: 40, currency: "USD", platform: "meta" }, () =>
        Effect.sync(() => {
          ownerAsked += 1;
          return "accept" as const;
        }),
      ),
    );
    expect(result).toEqual({ allowed: true });
    expect(ownerAsked).toBe(1);
    expect(router.pending()).toEqual([]);
  });

  it("a gated publish that asks is answered by the manager and recorded as such", async () => {
    const { trust, router, audit } = setup();
    await Effect.runPromise(
      trust.savePolicy({ ...DEFAULT_TRUST_POLICY, agents: { dev: { publish: "ask" } } }, { name: "Owner" }),
    );
    const gate = Effect.runPromise(
      trust.gate({ agentId: "dev" }, action("publish"), (reason) =>
        router
          .awaitAnswer({ id: "gate:dev:1", source: "gate", askerId: "dev", title: "Publish", reason })
          .pipe(
            Effect.map((outcome) =>
              outcome.answer === "owner"
                ? ("cancel" as const)
                : { answer: outcome.answer, byName: outcome.byName, byKind: "agent" as const, note: outcome.note },
            ),
          ),
      ),
    );
    await expect.poll(() => router.pending().length).toBe(1);
    expect(router.pending()[0]?.approverId).toBe("lead");
    expect((await router.answer("lead", { requestId: "gate:dev:1", verdict: "approve" })).ok).toBe(true);
    expect(await gate).toEqual({ allowed: true });
    const rows = audit.query({ category: "publish" });
    expect(rows[0]).toMatchObject({ outcome: "approved", answeredBy: "Lead", answeredByKind: "agent" });
  });
});

describe("the manager's answer", () => {
  it("wakes the asker's manager with the request, the reason and the evidence", async () => {
    const { router, wakes } = setup();
    const { handler } = recorder();
    expect(await router.route(request("ticket:1", "dev"), handler)).toEqual({ approver: "manager", agentId: "lead" });
    expect(wakes[0]?.agentId).toBe("lead");
    expect(wakes[0]?.text).toContain("ticket:1");
    expect(wakes[0]?.text).toContain("The grader sent it back three times.");
    expect(wakes[0]?.text).toContain("openbot.answer_approval");
  });

  it("approve settles it, and the trust log says approved by the manager", async () => {
    const { router, audit, trust } = setup();
    const { handler, settled } = recorder();
    await router.route(request("ticket:2", "dev"), handler);
    const answer = await router.answer("lead", { requestId: "ticket:2", verdict: "approve", note: "Good enough." });
    expect(answer.ok).toBe(true);
    expect(settled).toEqual([{ verdict: "approve", note: "Good enough.", by: "Lead", option: undefined }]);
    expect(router.pending()).toEqual([]);
    expect(router.decided()[0]).toMatchObject({ id: "ticket:2", verdict: "approve" });
    expect(audit.query({ category: "approval" })[0]).toMatchObject({
      outcome: "approved",
      answeredBy: "Lead",
      answeredByKind: "agent",
    });
    expect(trust.approvalsView().week).toMatchObject({ owner: 0, agents: 1 });
  });

  it("decline needs a note, and the note reaches the asker", async () => {
    const { router } = setup();
    const { handler, settled } = recorder();
    await router.route(request("ticket:3", "dev"), handler);
    expect((await router.answer("lead", { requestId: "ticket:3", verdict: "decline" })).ok).toBe(false);
    expect((await router.answer("lead", { requestId: "ticket:3", verdict: "decline", note: "Add §J." })).ok).toBe(true);
    expect(settled[0]).toMatchObject({ verdict: "decline", note: "Add §J." });
  });

  it("escalate needs a reason, and the owner's card shows who escalated it and why", async () => {
    const { router, audit, trust } = setup();
    const { handler, owner, settled } = recorder();
    await router.route(request("ticket:4", "dev"), handler);
    expect((await router.answer("lead", { requestId: "ticket:4", verdict: "escalate" })).ok).toBe(false);
    const answer = await router.answer("lead", {
      requestId: "ticket:4",
      verdict: "escalate",
      note: "It signs a contract in the owner's name.",
    });
    expect(answer.ok).toBe(true);
    expect(settled).toEqual([]);
    expect(owner).toEqual([
      { kind: "escalated", byId: "lead", byName: "Lead", reason: "It signs a contract in the owner's name." },
    ]);
    expect(audit.query({ category: "approval" })[0]).toMatchObject({ escalated: true, answeredByKind: "agent" });
    // An escalation is no decision of the agents.
    expect(trust.approvalsView().week).toMatchObject({ owner: 0, agents: 0 });
  });

  it("goes up one level after 2 hours without an answer, and to the owner after the top agent", async () => {
    const { router, wakes } = setup();
    const { handler, owner } = recorder();
    await router.route(request("ticket:5", "dev"), handler);
    now += APPROVAL_CLIMB_MS - 1;
    await router.tick();
    expect(router.pending()[0]?.approverId).toBe("lead");
    now += 1;
    await router.tick();
    expect(router.pending()[0]?.approverId).toBe("ceo");
    expect(wakes.at(-1)?.agentId).toBe("ceo");
    // The manager it left can no longer answer it.
    expect((await router.answer("lead", { requestId: "ticket:5", verdict: "approve" })).ok).toBe(false);
    now += APPROVAL_CLIMB_MS;
    await router.tick();
    expect(router.pending()).toEqual([]);
    expect(owner).toEqual([{ kind: "unanswered" }]);
  });
});

describe("the loop guard", () => {
  it("an agent never answers its own request", async () => {
    const { router } = setup();
    const { handler, settled } = recorder();
    await router.route(request("ticket:6", "dev"), handler);
    const answer = await router.answer("dev", { requestId: "ticket:6", verdict: "approve" });
    expect(answer.ok).toBe(false);
    expect(settled).toEqual([]);
  });

  it("an agent that asked never answers a request raised in the same chain", async () => {
    // Ceo has two reports and leads the space; Solo leads alone with one report.
    const agents: ApprovalAgent[] = [
      { id: "ceo", name: "Ceo", reportsToAgentId: null },
      { id: "a", name: "A", reportsToAgentId: "ceo" },
      { id: "b", name: "B", reportsToAgentId: "ceo" },
      { id: "solo", name: "Solo", reportsToAgentId: null },
      { id: "c", name: "C", reportsToAgentId: "solo" },
    ];
    const { router } = setup(agents);
    // Ceo has no manager: the space's other top agent, Solo, answers it.
    expect(await router.route(request("ticket:7", "ceo"), recorder().handler)).toEqual({
      approver: "manager",
      agentId: "solo",
    });
    // While Solo has Ceo's request, Solo's own request would go to the top agent, Ceo: it may not.
    expect(await router.route(request("ticket:8", "solo"), recorder().handler)).toEqual({ approver: "owner" });
  });

  it("a request with no agent above it goes to the owner at once", async () => {
    const { router } = setup([{ id: "only", name: "Only", reportsToAgentId: null }]);
    expect(await router.route(request("ticket:9", "only"), recorder().handler)).toEqual({ approver: "owner" });
  });
});
