// @vitest-environment node
import { describe, expect, it } from "vitest";
import { routineToolArguments } from "./routine-tools";

// Failure mode: update_routine with `id` got "Unexpected routine argument: id." and the agent had to
// describe the tool to find that the field is routineId.
describe("routineToolArguments", () => {
  it("lists the fields the tool takes and points id to routineId", () => {
    expect(() => routineToolArguments({ id: "r1" }, ["routineId", "name"])).toThrow(
      "Unexpected routine argument: id. This tool takes routineId, name; the routine's id goes in routineId.",
    );
    expect(routineToolArguments({ routineId: "r1" }, ["routineId", "name"])).toEqual({ routineId: "r1" });
  });
});
