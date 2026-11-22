// Checks that a typed-login save keeps the login of another subdomain (upstream #8685). Runs the real
// VaultService and VaultStore on a temporary file. Before, a new password for billing.example.com
// replaced the password of the status.example.com login with the same username.
// `bun scripts/vault-subdomain-login-e2e.ts`. Writes .openbot-build/vault-subdomain-login-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { VaultService } from "../src/main/vault-service";
import { VaultStore } from "../src/main/vault-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/vault-subdomain-login-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-vault-subdomain-"));
const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8").reverse(),
  decrypt: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
};
const report: { steps: { step: string; detail: unknown }[]; passed: boolean; error?: string } = {
  steps: [],
  passed: false,
};
let run = 0;
const vault = async () => {
  run += 1;
  const service = new VaultService({
    store: new VaultStore(join(root, `vault-${run}.json`), cipher),
    canPersist: () => true,
  });
  await Effect.runPromise(service.load());
  return service;
};
const typed = (origin: string, password: string) => ({ origin, username: "ada", password });
const passwords = (service: VaultService) =>
  Effect.runPromise(service.logins.loginsFor("https://example.com")).then(async (logins) =>
    Promise.all(
      (logins ?? []).map(async (login) => ({
        title: login.title,
        password: await Effect.runPromise(service.logins.secretFor(login.id, "https://example.com", "password")),
      })),
    ),
  );

try {
  const other = await vault();
  await Effect.runPromise(other.items.saveLogin(typed("https://status.example.com", "status-secret"), undefined));
  const added = await Effect.runPromise(
    other.items.saveLogin(typed("https://billing.example.com", "billing-secret"), undefined),
  );
  const both = await passwords(other);
  report.steps.push({ step: "another subdomain", detail: { added, both } });
  assert.equal(added.created, true, "a new login is added for the other subdomain");
  assert.deepEqual(both.map((login) => login.password).sort(), ["billing-secret", "status-secret"]);

  const same = await vault();
  await Effect.runPromise(same.items.saveLogin(typed("https://www.example.com", "old-secret"), undefined));
  const changed = await Effect.runPromise(same.items.saveLogin(typed("https://example.com", "new-secret"), undefined));
  const one = await passwords(same);
  report.steps.push({ step: "same host, www. ignored", detail: { changed, one } });
  assert.equal(changed.created, false);
  assert.deepEqual(
    one.map((login) => login.password),
    ["new-secret"],
  );

  const known = await vault();
  await Effect.runPromise(known.items.saveLogin(typed("https://status.example.com", "same-secret"), undefined));
  const kept = await Effect.runPromise(
    known.items.saveLogin(typed("https://billing.example.com", "same-secret"), undefined),
  );
  report.steps.push({ step: "another subdomain with this password", detail: kept });
  assert.equal(kept.created, false);
  assert.equal(kept.changed, false);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
}
