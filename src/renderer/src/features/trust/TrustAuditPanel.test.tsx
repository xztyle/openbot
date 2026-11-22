import type { TrustAuditCategory, TrustAuditEntry, TrustAuditQuery } from "@openbot/contracts/trust-control";
import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { TrustAuditPanel } from "./WorkspaceTrustView";

// Failure mode: the audit trail shows the rows of another filter than the one picked: the read
// asked with the filter before, or an older read answered last.

const entry = (summary: string, category: TrustAuditCategory): TrustAuditEntry => ({
  id: summary,
  at: "2026-11-22T10:00:00.000Z",
  actor: { kind: "person", name: "Owner" },
  category,
  action: "test",
  summary,
  outcome: "allowed",
});

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  flush();
};

describe("Trust audit filters", () => {
  it("reads the picked filter and shows the newest filter's rows", async () => {
    const reads: { query: TrustAuditQuery; resolve: (rows: TrustAuditEntry[]) => void }[] = [];
    const calls = {
      audit: (query: TrustAuditQuery) => new Promise<TrustAuditEntry[]>((resolve) => reads.push({ query, resolve })),
    };
    const view = render(() => (
      <TrustAuditPanel calls={() => calls} agents={[]} agentName={(id) => id} onOpenAgent={() => undefined} />
    ));
    await settle();
    reads[0]?.resolve([entry("first-row", "spend")]);
    await settle();

    const category = view.container.querySelector("select");
    if (!category) throw new Error("no category filter");
    fireEvent.change(category, { target: { value: "publish" } });
    expect(reads.at(-1)?.query.category).toBe("publish");
    fireEvent.change(category, { target: { value: "send" } });
    expect(reads.at(-1)?.query.category).toBe("send");
    // The "send" read answers before the "publish" one.
    reads[2]?.resolve([entry("sent-row", "send")]);
    reads[1]?.resolve([entry("published-row", "publish")]);
    await settle();
    expect(view.container.textContent).toContain("sent-row");
    expect(view.container.textContent).not.toContain("published-row");
  });
});
