// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModelOption } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanoutCandidates, reviewJudgeCandidates } from "./background-models";
import { handleOrderTool, looksLikeOrder, needsPlan, OrderPlans, planApprover } from "./order-tools";
import { WideResearch, wideResearchCsv, wideResearchPrompt, wideResearchRow } from "./wide-research";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "order-tools-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const agents = [
  { id: "lead", name: "Lead" },
  { id: "dev", name: "Dev", reportsToAgentId: "lead" },
  { id: "solo", name: "Solo" },
];

const model = (provider: "claude" | "codex", id: string): AgentModelOption => ({
  provider,
  id,
  name: id,
  description: "",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium"],
});
const listed = [
  model("claude", "claude-haiku-5-5"),
  model("claude", "claude-sonnet-5-5"),
  model("claude", "claude-opus-5-5"),
  model("codex", "gpt-5.5"),
];
const gate = { provider: "claude", model: "claude-haiku-5-5" };

describe("orders", () => {
  it("tells an order from a status note", () => {
    expect(looksLikeOrder("Can you write the FAQ for the course page by Friday?")).toBe(true);
    expect(looksLikeOrder("Necesito que prepares el informe semanal de ventas para el lunes.")).toBe(true);
    expect(looksLikeOrder("FYI the build is green now and the deploy finished.")).toBe(false);
    expect(looksLikeOrder("fix it")).toBe(false);
    expect(looksLikeOrder("Status: done. Result: I updated the landing page copy as asked.")).toBe(false);
    expect(looksLikeOrder("New ticket for you.\nWrite the FAQ for the course page, ten questions.")).toBe(true);
  });

  it("starts a big order with a plan that its manager approves", () => {
    expect(needsPlan({ estimateHours: 2 })).toBe(false);
    expect(needsPlan({ estimateHours: 6 })).toBe(true);
    expect(needsPlan({ budgetUsd: 50 })).toBe(true);
    expect(needsPlan({ planFirst: true })).toBe(true);
    expect(planApprover(agents, "dev", "solo")).toBe("lead");
    expect(planApprover(agents, "solo", "lead")).toBe("lead");
    expect(planApprover(agents, "solo", null)).toBeNull();
  });

  it("sends the plan to the approver, and the verdict back", async () => {
    const plans = new OrderPlans(root);
    const expected = plans.expect({ assigneeAgentId: "dev", approverAgentId: "lead", cardKey: "UO-9", title: "Shop" });
    const sent: { from: string; to: string; text: string }[] = [];
    const context = {
      plans,
      agents: () => agents,
      notify: (input: { from: string; to: string; text: string; key: string }) => Effect.sync(() => sent.push(input)),
    };
    const submitted = await Effect.runPromise(
      handleOrderTool("submit_plan", { card: "uo-9", plan: "1. Build the page\n2. Buy ads for $40" }, "dev", context),
    );
    expect(JSON.stringify(submitted)).toContain(expected.id);
    expect(sent[0]).toMatchObject({ from: "dev", to: "lead" });
    expect(sent[0]?.text).toContain("> 2. Buy ads for $40");
    const refused = await Effect.runPromise(
      handleOrderTool("review_plan", { planId: expected.id, approve: true }, "dev", context),
    );
    expect(JSON.stringify(refused)).toContain("No plan with that id waits for you");
    const noNotes = await Effect.runPromise(
      handleOrderTool("review_plan", { planId: expected.id, approve: false }, "lead", context),
    );
    expect(JSON.stringify(noNotes)).toContain("Say what to change");
    await Effect.runPromise(handleOrderTool("review_plan", { planId: expected.id, approve: true }, "lead", context));
    expect(sent[1]).toMatchObject({ from: "lead", to: "dev" });
    expect(sent[1]?.text).toContain("approved");
    await vi.waitFor(() => expect(new OrderPlans(root).list()[0]?.status).toBe("approved"));
    expect(await Effect.runPromise(handleOrderTool("send_message", {}, "dev", context))).toBeNull();
  });
});

describe("background models", () => {
  it("grades an important ticket on the other vendor, and an ordinary one on the gate model", () => {
    const claude = { provider: "claude" as const, model: "claude-sonnet-5-5" };
    expect(reviewJudgeCandidates(claude, true, listed, gate).map((entry) => entry.id)).toEqual([
      "gpt-5.5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]);
    const codexOnly = listed.filter((entry) => entry.provider === "codex");
    expect(reviewJudgeCandidates({ provider: "codex", model: "gpt-5.5" }, true, codexOnly, gate)[0]?.id).toBe(
      "gpt-5.5",
    );
    expect(reviewJudgeCandidates(claude, false, listed, gate).map((entry) => entry.id)).toEqual(["claude-haiku-5-5"]);
    const codex = { provider: "codex" as const, model: "gpt-5.5" };
    expect(reviewJudgeCandidates(codex, true, listed, gate)[0]?.id).toBe("claude-sonnet-5-5");
    const noCodex = listed.filter((entry) => entry.provider === "claude");
    expect(reviewJudgeCandidates(claude, true, noCodex, gate)[0]?.id).toBe("claude-opus-5-5");
  });

  it("runs wide research on Haiku or Sonnet", () => {
    expect(fanoutCandidates("small", listed).map((entry) => entry.id)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "gpt-5.5",
    ]);
    expect(fanoutCandidates("medium", listed)[0]?.id).toBe("claude-sonnet-5-5");
  });
});

describe("wide research", () => {
  it("builds the item prompt and reads an answer as a row", () => {
    const prompt = wideResearchPrompt(
      { job: "Size the market for {item} in Spain.", columns: ["searches"] },
      "yoga mats",
      true,
    );
    expect(prompt).toContain("Size the market for yoga mats in Spain.");
    expect(prompt).toContain('"searches", "sources"');
    expect(
      wideResearchRow("a", ["searches"], 'Here: {"searches": 1200, "sources": ["https://x.test", "nope"]}'),
    ).toEqual({
      item: "a",
      status: "ok",
      values: { searches: "1200" },
      sources: ["https://x.test"],
    });
    expect(wideResearchRow("b", ["searches"], "no idea").status).toBe("failed");
    expect(wideResearchCsv(["x"], [{ item: "=SUM(A1)", status: "ok", values: { x: 'a, "b"' }, sources: [] }])).toBe(
      'item,x,sources,status\n\'=SUM(A1),"a, ""b""",,ok\n',
    );
  });

  it("maps the job over the items a few at a time, stops at the budget, and writes the table", async () => {
    let running = 0;
    let peak = 0;
    let spent = 0;
    const finished: string[] = [];
    const research = new WideResearch({
      generate: (input) =>
        Effect.promise(async () => {
          running += 1;
          peak = Math.max(peak, running);
          // Yields to the other items, so the ones that may run together do.
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          spent += 0.5;
          expect(input.sessionId).toMatch(/^[a-z0-9]+:\d+$/u);
          return `{"price": "${input.prompt.length}", "sources": []}`;
        }),
      cost: () => spent,
      directory: () => root,
      finished: (_agentId, text) => finished.push(text),
    });
    const answer = research.handleTool(
      "wide_research",
      {
        title: "Price scan",
        job: "Find the price of {item}.",
        items: ["a", "b", "c", "d", "e", "f"],
        columns: ["price"],
        concurrency: 2,
        maxCostUsd: 2,
      },
      "dev",
    );
    expect(JSON.stringify(answer)).toContain("started");
    expect(
      JSON.stringify(
        research.handleTool("wide_research", { title: "x", job: "y", items: ["a"], columns: ["c"] }, "dev"),
      ),
    ).toContain("already have");
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(peak).toBe(2);
    expect(finished[0]).toContain("Wide research “Price scan” is done");
    expect(finished[0]).toContain("skipped at the $2 budget");
    const table = /Table: (\S+\.csv)/u.exec(finished[0] ?? "")?.[1] ?? "";
    const csv = await readFile(table, "utf8");
    expect(csv.split("\n")[0]).toBe("item,price,sources,status");
    expect(csv).toContain("skipped: budget reached");
  });
});
