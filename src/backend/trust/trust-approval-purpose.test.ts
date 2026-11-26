// @vitest-environment node
//
// The trust boundary of a money call that only checks, and of the card that the owner reads: a
// meta-ads call with --validate or --dry-run runs with no card; the same call without it waits for
// the owner, and the card carries what the agent says it wants, the fixed action line and the amount.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrustApprovalCard } from "@openbot/contracts/agent-approvals";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { localizeSourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServerRequest } from "../protocol";
import { TrustAuditLog } from "./trust-audit-log";
import { classifyCommand } from "./trust-classifier";
import { TrustService } from "./trust-service";
import { type TrustAttention, type TrustClient, TrustToolGate } from "./trust-tool-gate";

const AGENTS = [{ id: "puo", name: "PUO – Operaciones de Marketing", reportsToAgentId: null }];
const META = 'M=/opt/skills/openbot-meta-ads/meta-ads.mjs; node "$M"';

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trust-purpose-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type ShownApproval = Parameters<TrustAttention["awaitToolApproval"]>[2];

/** A gate over a real policy and audit trail; the attention records each card and accepts it. */
function harness(options: { summarize?: (prompt: string) => Promise<string | null> } = {}) {
  const summarize = (prompt: string) => options.summarize?.(prompt) ?? Promise.resolve(null);
  const trust = new TrustService({
    file: join(root, "policy.json"),
    audit: new TrustAuditLog(join(root, "audit")),
    directory: { agents: () => AGENTS, spaceOf: () => "space" },
  });
  const cards: ShownApproval[] = [];
  const decisions: string[] = [];
  const attention: TrustAttention = {
    awaitToolApproval: (_client, _request, approval) => {
      cards.push(approval);
      return Effect.succeed("accept" as const);
    },
    surfaceUiBlock: () => undefined,
    cancelRequest: () => undefined,
  };
  const gate = new TrustToolGate({
    trust,
    attention,
    agentForThread: () => "puo",
    publicThreadId: (_agentId, threadId) => threadId,
    listTabs: () => [],
    messagingThread: () => false,
    agentWords: () => null,
    ...(options.summarize ? { summarizePurpose: (_agentId: string, prompt: string) => summarize(prompt) } : {}),
    ownerLanguage: () => "Spanish",
  });
  const client: TrustClient = {
    running: true,
    respond: (_id, result) => {
      decisions.push(isDynamicRecord(result) && typeof result.decision === "string" ? result.decision : "");
    },
  };
  /** The Claude hook's two phases for one Bash call: the check, and the approval after an `ask`. */
  const bash = async (command: string, description?: string) => {
    for (const phase of ["check", "approve"] as const) {
      const request: AppServerRequest = {
        method: "openbot/trust-check",
        id: `${phase}-${decisions.length}`,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          phase,
          toolName: "Bash",
          toolInput: { command, ...(description ? { description } : {}) },
        },
      };
      await Effect.runPromise(gate.handleTrustCheck(client, request));
      if (decisions.at(-1) !== "ask") return decisions.at(-1);
    }
    return decisions.at(-1);
  };
  return { cards, bash };
}

describe("a meta-ads call that only checks", () => {
  it("runs with no card when it validates or simulates", async () => {
    const { cards, bash } = harness();
    expect(
      await bash(`${META} create-campaign --name "Prueba" --objective OUTCOME_SALES --daily-budget 7 --validate`),
    ).toBe("allow");
    expect(await bash(`${META} set-budget 120330 --daily 20 --dry-run`)).toBe("allow");
    expect(await bash(`${META} insights --object 120330 --preset last_7d`)).toBe("allow");
    expect(await bash(`${META} campaigns --status ACTIVE`)).toBe("allow");
    expect(await bash(`${META} reach-estimate --adset 120330 --budgets 10,20,50`)).toBe("allow");
    expect(cards).toHaveLength(0);
  });

  it("still asks when the check flag is not the helper's own flag", () => {
    const gated = (command: string) => classifyCommand(command)?.action ?? null;
    // `--name` takes the next word, so the helper never reads --validate here and creates the campaign.
    expect(gated(`${META} create-campaign --objective OUTCOME_SALES --daily-budget 9 --name --validate`)).toBe(
      "launch_ads",
    );
    expect(gated(`${META} create-campaign --objective X --daily-budget 9 --name "x --validate"`)).toBe("launch_ads");
    expect(gated(`${META} create-campaign --objective X --daily-budget 9 --validate=1`)).toBe("launch_ads");
    expect(gated(`${META} set-budget 1 --daily 9 $EXTRA --validate`)).toBe("launch_ads");
    expect(gated(`${META} set-budget 1 --daily 9 & ${META} set-budget 1 --daily 9 --validate`)).toBe("launch_ads");
    // hotmart has no --validate: only --dry-run sends nothing.
    expect(gated("hotmart refund HP123 --approved --validate")).toBe("pay");
    expect(gated("hotmart refund HP123 --dry-run")).toBeNull();
  });
});

describe("the card of a gated meta-ads call", () => {
  it("waits for the owner and carries the agent's purpose, the action line and the amount", async () => {
    const { cards, bash } = harness();
    const purpose = "Quiero aprobación para revisar los topes de la campaña y modificarlos si superan los 7 USD.";
    expect(
      await bash(`${META} create-campaign --name "Prueba" --objective OUTCOME_SALES --daily-budget 7`, purpose),
    ).toBe("allow");
    expect(cards).toHaveLength(1);
    const card = parseTrustApprovalCard(cards[0]?.command);
    expect(card?.purpose).toBe(purpose);
    expect(card?.purposeBy).toBe("agent");
    expect(card?.action[0]).toContain("meta-ads create-campaign");
    expect(card?.amount).toBe("7 USD");
    expect(card?.details).toContain("--daily-budget 7");
    // Each line of the chrome is one source sentence, so the owner reads it in Spanish.
    for (const line of (cards[0]?.reason ?? "").split("\n")) expect(localizeSourceText(line, "es")).not.toBe(line);
  });

  it("marks Atelier's own summary when the agent gave no purpose", async () => {
    const prompts: string[] = [];
    const { cards, bash } = harness({
      summarize: async (prompt) => {
        prompts.push(prompt);
        return "Quiero crear una campaña nueva con 7 USD al día.";
      },
    });
    await bash(`${META} create-campaign --name "Prueba" --objective OUTCOME_SALES --daily-budget 7`);
    const card = parseTrustApprovalCard(cards[0]?.command);
    expect(card?.purpose).toBe("Quiero crear una campaña nueva con 7 USD al día.");
    expect(card?.purposeBy).toBe("atelier");
    expect(prompts[0]).toContain("Spanish");
  });
});
