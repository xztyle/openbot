// @vitest-environment node
// Failure mode: one tool whose schema the Claude SDK cannot convert makes the whole `openbot` tool
// server fail to list, so Claude agents lose every `openbot.*` tool. A record schema did exactly this
// when the SDK and the app loaded separate copies of zod.
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { expect, it } from "vitest";
import { BROWSER_TOOL_DEFINITIONS } from "./browser-tools";
import { OPENBOT_TOOL_DEFINITIONS } from "./openbot-tools";

const UNSAFE = new Set(["record", "map", "set", "lazy", "promise", "custom", "pipe", "transform"]);
function collectUnsafe(schema: unknown, found: Set<string>, depth = 0): void {
  if (depth > 12 || !isDynamicRecord(schema) || !isDynamicRecord(schema._zod) || !isDynamicRecord(schema._zod.def))
    return;
  const def = schema._zod.def;
  if (typeof def.type === "string" && UNSAFE.has(def.type)) found.add(def.type);
  const inner: unknown[] = [def.innerType, def.element];
  if (Array.isArray(def.options)) inner.push(...def.options);
  if (isDynamicRecord(def.shape)) inner.push(...Object.values(def.shape));
  for (const entry of inner) collectUnsafe(entry, found, depth + 1);
}
it("keeps agent tool schemas to constructs that convert under any zod copy", () => {
  const offenders: string[] = [];
  for (const definition of [...OPENBOT_TOOL_DEFINITIONS, ...BROWSER_TOOL_DEFINITIONS])
    for (const [name, schema] of Object.entries(definition.shape)) {
      const found = new Set<string>();
      collectUnsafe(schema, found);
      for (const type of found) offenders.push(`${definition.name}.${name}: ${type}`);
    }
  expect(offenders).toEqual([]);
});
