// @vitest-environment node
// Failure modes: a member or a client without the capability reading the audit rows, and a value in a row.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { SecurityAuditLog } from "../backend/security-audit-log";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);
it("lets an owner read the newest audit rows and nobody else", async () => {
  const fixture = await createTeamApiFixture("security-audit", { configure: true });
  const directory = await mkdtemp(join(tmpdir(), "openbot-audit-route-"));
  const audit = new SecurityAuditLog(join(directory, "audit.jsonl"));
  for (const action of ["mcp-server.save", "approval.auto-approve", "event-check.set-variable"])
    audit.append({
      actor: { kind: "member", id: "m1", name: "Ana" },
      action,
      target: { kind: "agent", id: "chief" },
      names: ["TEST_API_TOKEN"],
    });
  const { base } = await fixture.start({ securityAudit: audit }),
    owner = await fixture.signIn();
  const invite = await runCauseEffect(fixture.store.createInvite("member"));
  const member = await runCauseEffect(fixture.store.acceptInvite(invite.token, "member", "member password"));
  const send = (body: unknown, token = owner, capability = "security-audit-v1") =>
    fetch(`${base}/v1/security-audit/list`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "3",
        "OpenBot-Capabilities": capability,
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await send({}, "invalid")).status).toBe(401);
    expect((await send({}, member.sessionToken)).status).toBe(403);
    expect((await send({}, owner, "")).status).toBe(400);
    const reply = await send({ limit: 2 });
    expect(reply.status).toBe(200);
    const body = await reply.json();
    expect(body.rows.map((row: { action: string }) => row.action)).toEqual([
      "event-check.set-variable",
      "approval.auto-approve",
    ]);
    expect(body.rows[0].names).toEqual(["TEST_API_TOKEN"]);
    expect((await send({ limit: "all" })).status).toBe(400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
