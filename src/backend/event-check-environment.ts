import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventCheck, EventCheckApiSource, EventCheckEnvironmentStatus } from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { writeFileAtomically } from "./atomic-json-file";
import { type EventCheckApproval, eventCheckDestination } from "./event-check-approval";
import { mcpFailure, mcpSync } from "./mcp-effects";

interface Cipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}
interface StoredEnvironment {
  account: string;
  values: Record<string, string>;
  approval?: EventCheckApproval;
}
/** `none`: no private value is held. `approved`: the program and destination match what the user approved. */
export type EventCheckApprovalState = "none" | "approved" | "changed";

function approvalOf(value: unknown): EventCheckApproval | undefined {
  if (
    isDynamicRecord(value) &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.destination === "string" &&
    /^[a-f0-9]{64}$/.test(value.destination)
  )
    return { digest: value.digest, destination: value.destination };
  return undefined;
}
function apiSource(check: EventCheck): EventCheckApiSource | null {
  return check.source.kind === "api" ? check.source : null;
}
/**
 * Encrypted, per-instance variables. Normal program/settings paths never return their values.
 *
 * The values are bound to the program that the user approved. The file stores the digest of that
 * program and a fingerprint of its destination settings, and `values` returns nothing for a program
 * or destination that differs. The approval changes only through `set` and `approve`, which no agent
 * tool reaches. A program the reviewed catalog ships counts as approved without a stored digest, but
 * never for another destination.
 */
export class EventCheckEnvironment {
  readonly #writes = Semaphore.makeUnsafe(1);
  constructor(
    readonly root: string,
    readonly cipher: Cipher,
    /** Whether the check's program is byte for byte the reviewed program of its linked template. */
    readonly reviewed: (check: EventCheck) => boolean = () => false,
  ) {}
  #path(check: EventCheck): string {
    if (!/^[a-f0-9-]{36}$/.test(check.id)) throw new Error("Invalid check identifier.");
    return join(this.root, check.id, ".env");
  }
  /** The stored file, or null when there is none or it belongs to another account label. */
  #stored(check: EventCheck): StoredEnvironment | null {
    const source = apiSource(check);
    if (!source) return null;
    let content: string;
    try {
      content = readFileSync(this.#path(check), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new Error("Cannot read private environment.");
    }
    const stored = JSON.parse(this.cipher.decrypt(content.trim()));
    if (!isDynamicRecord(stored) || stored.account !== source.connectionId || !isDynamicRecord(stored.values))
      return null;
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(stored.values))
      if (typeof value === "string" && value) {
        values[name] = value;
        for (const mask of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
          registerSecretValue(mask, { allowShort: true });
      }
    const approval = approvalOf(stored.approval);
    return { account: source.connectionId, values, ...(approval ? { approval } : {}) };
  }
  #matches(stored: StoredEnvironment, check: EventCheck): boolean {
    const source = apiSource(check);
    if (!source?.programDigest || !stored.approval) return false;
    return (
      (stored.approval.digest === source.programDigest || this.reviewed(check)) &&
      stored.approval.destination === eventCheckDestination(source)
    );
  }
  #held(stored: StoredEnvironment, source: EventCheckApiSource): boolean {
    return source.variables.some((name) => stored.values[name] !== undefined);
  }
  state(check: EventCheck): EventCheckApprovalState {
    const source = apiSource(check);
    const stored = source ? this.#stored(check) : null;
    if (!source || !stored || !this.#held(stored, source)) return "none";
    return this.#matches(stored, check) ? "approved" : "changed";
  }
  /** The private values of this program, or nothing when the program or destination is not approved. */
  values(check: EventCheck): Record<string, string> {
    const source = apiSource(check);
    const stored = source ? this.#stored(check) : null;
    if (!source || !stored || !this.#matches(stored, check)) return {};
    const values: Record<string, string> = {};
    for (const name of source.variables) if (stored.values[name] !== undefined) values[name] = stored.values[name];
    return values;
  }
  status(check: EventCheck): EventCheckEnvironmentStatus[] {
    const source = apiSource(check);
    if (!source) return [];
    const values = this.values(check);
    const reapprove = this.state(check) === "changed";
    return source.variables.map((name) => ({
      name,
      configured: values[name] !== undefined,
      ...(reapprove ? { reapprove: true } : {}),
    }));
  }
  #encode(check: EventCheck, values: Record<string, string>, approval: EventCheckApproval | undefined) {
    return this.cipher.encrypt(
      JSON.stringify({
        version: 2,
        account: apiSource(check)?.connectionId,
        values,
        ...(approval ? { approval } : {}),
      }),
    );
  }
  #current(check: EventCheck): EventCheckApproval {
    const source = apiSource(check);
    if (!source?.programDigest) throw new Error("Missing program digest.");
    return { digest: source.programDigest, destination: eventCheckDestination(source) };
  }
  #write(check: EventCheck, values: Record<string, string>, approval: EventCheckApproval | undefined) {
    return Effect.gen({ self: this }, function* () {
      const content = yield* mcpSync(() => this.#encode(check, values, approval));
      yield* writeFileAtomically(this.#path(check), `${content}\n`, { createDirectory: true }).pipe(
        Effect.mapError(mcpFailure),
      );
    });
  }
  /**
   * Sets or removes one variable. Setting one approves the program and destination of `check` as they
   * are now, so the caller must hold a check whose digest it has just read from the file. When the
   * approval was for another program, the other values do not stay: they were given to that program.
   */
  set(check: EventCheck, name: string, value: string | null) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const source = apiSource(check);
        if (!source?.variables.includes(name))
          return yield* mcpSync(() => {
            throw new Error("Undeclared private variable.");
          });
        const stored = yield* mcpSync(() => this.#stored(check));
        if (value === null) {
          const values = { ...stored?.values };
          delete values[name];
          return yield* this.#write(check, values, stored?.approval);
        }
        const kept = stored && this.#matches(stored, check) ? stored.values : {};
        registerSecretValue(value, { allowShort: true });
        yield* this.#write(check, { ...kept, [name]: value }, yield* mcpSync(() => this.#current(check)));
      }),
    );
  }
  /** Approves the program and destination of `check` as they are now, and keeps the values. */
  approve(check: EventCheck) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const stored = yield* mcpSync(() => this.#stored(check));
        if (!stored || !(yield* mcpSync(() => this.#held(stored, apiSourceOrThrow(check))))) return;
        yield* this.#write(check, stored.values, yield* mcpSync(() => this.#current(check)));
      }),
    );
  }
  /**
   * A file from before approvals has none. It takes the program that the check recorded, so the
   * values keep working. A program that has changed since then needs the user, like any other.
   */
  adoptLegacy(check: EventCheck) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const stored = yield* mcpSync(() => this.#stored(check));
        if (!stored || stored.approval || !apiSource(check)?.programDigest) return;
        yield* this.#write(check, stored.values, yield* mcpSync(() => this.#current(check)));
      }),
    );
  }
  remove(check: EventCheck) {
    return this.#writes.withPermit(mcpSync(() => rmSync(this.#path(check), { force: true })));
  }
}
function apiSourceOrThrow(check: EventCheck): EventCheckApiSource {
  const source = apiSource(check);
  if (!source) throw new Error("Invalid program source.");
  return source;
}
