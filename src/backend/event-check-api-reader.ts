import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type { EventCheck, EventCheckInput } from "@openbot/contracts/event-checks";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { EventCheckEnvironment } from "./event-check-environment";
import { runEventCheckProgram } from "./event-check-program";
import type { EventCheckReadSession } from "./event-check-reader";
import { type McpOperationError, mcpSync } from "./mcp-effects";
import { isPathInside } from "./path-containment";

/** Shared API programs, separate check instances and credentials. No model calls at this boundary. */
export class EventCheckApiReader {
  constructor(
    readonly environment: EventCheckEnvironment,
    readonly programsRoot: string,
    readonly current: (check: EventCheck) => boolean,
    readonly nodeExecutable = "/usr/bin/node",
  ) {}
  #program(input: EventCheckInput): { path: string; digest: string } {
    const name = input.source.toolName;
    if (isAbsolute(name) || ![".mjs", ".js", ".py", ".sh"].includes(extname(name)))
      throw new Error(sourceText("error.backend.eventCheckProgram"));
    const root = realpathSync(this.programsRoot),
      path = realpathSync(join(root, name));
    if (!isPathInside(root, path) || !statSync(path).isFile() || statSync(path).size > 1_048_576)
      throw new Error(sourceText("error.backend.eventCheckProgram"));
    return { path, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
  }
  definition(input: EventCheckInput): EventCheckInput {
    if (input.source.kind !== "api") throw new Error("Invalid program source.");
    const program = this.#program(input);
    return { ...input, source: { ...input.source, programDigest: program.digest } };
  }
  read<A>(check: EventCheck, use: (session: EventCheckReadSession) => Effect.Effect<A, McpOperationError>) {
    return Effect.gen({ self: this }, function* () {
      const program = yield* mcpSync(() => {
        const program = this.#program(check);
        if (check.source.kind !== "api" || !this.current(check) || check.source.programDigest !== program.digest)
          throw new Error("Stale program.");
        return program;
      });
      const values = yield* mcpSync(() => this.environment.values(check));
      if (check.source.kind !== "api" || check.source.variables.some((name) => !values[name]))
        return yield* mcpSync(() => {
          throw new Error(sourceText("error.backend.eventCheckMissingVariable"));
        });
      const source = check.source;
      const valid = () => {
        try {
          return this.current(check) && this.#program(check).digest === source.programDigest;
        } catch {
          return false;
        }
      };
      const session: EventCheckReadSession = {
        tools: [],
        dataKind: "api",
        valid,
        call: (_operation, args) =>
          runEventCheckProgram(
            program.path,
            this.programsRoot,
            values,
            { ...Object.fromEntries(source.configuration.map((field) => [field.name, field.value])), ...args },
            valid,
            this.nodeExecutable,
          ),
      };
      return yield* use(session);
    });
  }
}
