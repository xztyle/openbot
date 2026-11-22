// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutinePrechecks, runRoutinePrecheck, withPrecheckOutput } from "./routine-prechecks";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "openbot-precheck-"));
  roots.push(path);
  return path;
}

// Failure mode: 80% of scheduled routine runs found nothing, and each one still started a session of
// the agent's model that read ~54,000 tokens before it looked.
describe("routine pre-checks", () => {
  it("reads exit 1 as nothing to do, exit 0 as work with its output, and anything else as unknown", async () => {
    const cwd = root();
    expect(await runRoutinePrecheck("exit 1", cwd)).toEqual({ kind: "quiet" });
    expect(await runRoutinePrecheck("echo 3 new rows", cwd)).toEqual({ kind: "work", output: "3 new rows" });
    expect((await runRoutinePrecheck("exit 7", cwd)).kind).toBe("unknown");
    expect((await runRoutinePrecheck("sleep 5", cwd, 50)).kind).toBe("unknown");
  });

  it("gives the check no host variables", async () => {
    process.env.OPENBOT_PRECHECK_TEST_SECRET = "hidden";
    try {
      expect(await runRoutinePrecheck('printf "%s" "${OPENBOT_PRECHECK_TEST_SECRET:-none}"', root())).toEqual({
        kind: "work",
        output: "none",
      });
    } finally {
      delete process.env.OPENBOT_PRECHECK_TEST_SECRET;
    }
  });

  it("keeps the checks of live routines across a restart", async () => {
    const file = join(root(), "prechecks.json");
    const first = new RoutinePrechecks(file);
    await first.set("routine-a", "exit 1", new Set(["routine-a"]));
    await first.set("routine-b", "true", new Set(["routine-b"]));
    const second = new RoutinePrechecks(file);
    expect(second.get("routine-a")).toBeUndefined();
    expect(second.get("routine-b")).toBe("true");
    expect(withPrecheckOutput("Check the catalogue.", "2 new")).toBe(
      "Check the catalogue.\n\n--- pre-check output ---\n2 new",
    );
  });
});
