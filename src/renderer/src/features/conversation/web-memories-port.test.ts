import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { describe, expect, it } from "vitest";
import { webMemoriesPort } from "./web-memories-port";

const memory = {
  id: "m1",
  agentId: "chief",
  text: "Likes tea",
  origin: "manual",
  sourceTurnId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function port(answer: unknown) {
  const calls: Array<{ method: string; path: string }> = [];
  const request: TeamApiRequest = async (method, path, decode) => {
    calls.push({ method, path });
    return decode(answer);
  };
  return { calls, port: webMemoriesPort("chief", "Chief", request) };
}

describe("web memories port", () => {
  it("lists, saves and removes memories through the host routes", async () => {
    const reads = port([memory]);
    await expect(reads.port.list()).resolves.toEqual([memory]);
    expect(reads.calls).toEqual([{ method: "GET", path: "/v1/agents/chief/memories" }]);

    const writes = port(memory);
    await writes.port.create("Likes tea");
    await writes.port.update("m1", "Likes tea");
    await writes.port.remove("m1");
    await writes.port.clear();
    expect(writes.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/agents/chief/memories",
      "PATCH /v1/agents/chief/memories/m1",
      "DELETE /v1/agents/chief/memories/m1",
      "DELETE /v1/agents/chief/memories",
    ]);
  });

  it("refuses a memory of another agent and a text over the desktop limit", async () => {
    await expect(port([{ ...memory, agentId: "other" }]).port.list()).rejects.toThrow();
    const writes = port(memory);
    await expect(writes.port.create("x".repeat(INPUT_LIMITS.agentMemoryText + 1))).rejects.toThrow();
    expect(writes.calls).toEqual([]);
  });
});
