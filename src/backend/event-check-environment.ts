import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventCheck, EventCheckEnvironmentStatus } from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { writeFileAtomically } from "./atomic-json-file";
import { mcpFailure, mcpSync } from "./mcp-effects";

interface Cipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}
/** Encrypted, per-instance variables. Normal program/settings paths never return their values. */
export class EventCheckEnvironment {
  readonly #writes = Semaphore.makeUnsafe(1);
  constructor(
    readonly root: string,
    readonly cipher: Cipher,
  ) {}
  #path(check: EventCheck): string {
    if (!/^[a-f0-9-]{36}$/.test(check.id)) throw new Error("Invalid check identifier.");
    return join(this.root, check.id, ".env");
  }
  values(check: EventCheck): Record<string, string> {
    if (check.source.kind !== "api") return {};
    let content: string;
    try {
      content = readFileSync(this.#path(check), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw new Error("Cannot read private environment.");
    }
    const stored = JSON.parse(this.cipher.decrypt(content.trim()));
    if (!isDynamicRecord(stored) || stored.account !== check.source.connectionId || !isDynamicRecord(stored.values))
      return {};
    const values: Record<string, string> = {};
    for (const name of check.source.variables) {
      const value = stored.values[name];
      if (typeof value !== "string" || !value) continue;
      values[name] = value;
      for (const mask of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
        registerSecretValue(mask, { allowShort: true });
    }
    return values;
  }
  status(check: EventCheck): EventCheckEnvironmentStatus[] {
    if (check.source.kind !== "api") return [];
    const values = this.values(check);
    return check.source.variables.map((name) => ({ name, configured: values[name] !== undefined }));
  }
  set(check: EventCheck, name: string, value: string | null) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (check.source.kind !== "api" || !check.source.variables.includes(name))
          return yield* mcpSync(() => {
            throw new Error("Undeclared private variable.");
          });
        const values = yield* mcpSync(() => this.values(check));
        if (value === null) delete values[name];
        else {
          values[name] = value;
          registerSecretValue(value, { allowShort: true });
        }
        const content = yield* mcpSync(() =>
          this.cipher.encrypt(JSON.stringify({ version: 1, account: check.source.connectionId, values })),
        );
        yield* writeFileAtomically(this.#path(check), `${content}\n`, { createDirectory: true }).pipe(
          Effect.mapError(mcpFailure),
        );
      }),
    );
  }
  remove(check: EventCheck) {
    return this.#writes.withPermit(mcpSync(() => rmSync(this.#path(check), { force: true })));
  }
}
