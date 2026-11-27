// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@openbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import { SecretLedger } from "./secret-ledger";

// The keys store's log, export and send paths: the history file, the ledger, the encrypted bundle and
// the log redaction. No value may be readable on any of them.
const OWNER = { kind: "owner" as const, name: "Owner" };
const FIRST = "first-value-for-redaction-3c9e1a";
const SECOND = "second-value-for-redaction-7b2d4f";
const roots: string[] = [];

function ledger(): { root: string; store: SecretLedger } {
  const root = mkdtempSync(join(tmpdir(), "secret-ledger-redaction-"));
  roots.push(root);
  const store = new SecretLedger(root);
  store.setDirectory(() => [{ id: "agent-a", name: "A", spaceId: null }]);
  return { root, store };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("secret ledger redaction", () => {
  it("masks a saved value and an earlier version in log text", () => {
    const { root, store } = ledger();
    store.save("shared", "API_TOKEN", FIRST, OWNER);
    store.save("shared", "API_TOKEN", SECOND, OWNER);
    expect(redactText(`Bearer ${SECOND}`)).not.toContain(SECOND);
    // A fresh process registers every version it holds, the earlier ones too.
    const again = new SecretLedger(root);
    again.registerForRedaction();
    expect(redactText(`old ${FIRST}`)).not.toContain(FIRST);
  });

  it("keeps values out of the history, the ledger and the projection list", () => {
    const { root, store } = ledger();
    store.save("shared", "API_TOKEN", FIRST, OWNER);
    store.save("shared", "API_TOKEN", SECOND, OWNER);
    store.reveal("shared", "API_TOKEN", OWNER, "show");
    store.reveal("shared", "API_TOKEN", OWNER, "copy", 1);
    store.rollback("shared", "API_TOKEN", 1, OWNER);
    for (const file of readdirSync(join(root, "_vault")).filter((name) => name !== "key")) {
      const text = readFileSync(join(root, "_vault", file), "utf8");
      expect(text).not.toContain(FIRST);
      expect(text).not.toContain(SECOND);
    }
    const detail = JSON.stringify(store.detail("shared", "API_TOKEN"));
    expect(detail).not.toContain(FIRST);
    expect(detail).not.toContain(SECOND);
  });

  it("exports a bundle with no readable value that opens only with its passphrase", () => {
    const { store } = ledger();
    store.save("shared", "API_TOKEN", FIRST, OWNER);
    const { bundle } = store.exportBundle("a long passphrase", OWNER);
    expect(bundle).not.toContain(FIRST);
    expect(Buffer.from(bundle, "base64").toString("utf8")).not.toContain(FIRST);
    const target = ledger().store;
    expect(() => target.importBundle(bundle, "the wrong passphrase", OWNER)).toThrow();
    expect(target.importBundle(bundle, "a long passphrase", OWNER).added).toBe(1);
  });
});
