import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { describe, expect, it } from "vitest";
import { hostEfficiencyCalls } from "./efficiency-port";

/** A host that answers every route with `answer`, run through the route's own decoder. */
function host(answer: unknown): () => TeamApiRequest {
  const request: TeamApiRequest = async (_method, _path, decode) => decode(answer);
  return () => request;
}

describe("hostEfficiencyCalls", () => {
  it("reports a malformed answer in catalog text, which the screen shows in the reader's language", async () => {
    const calls = hostEfficiencyCalls(host({ unexpected: true }));
    await expect(calls.playbooks()).rejects.toThrow("The host returned invalid data.");
    await expect(calls.decisionQueue()).rejects.toThrow("The host returned invalid data.");
  });
});
