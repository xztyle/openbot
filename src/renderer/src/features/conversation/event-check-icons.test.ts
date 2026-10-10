import { describe, expect, it, vi } from "vitest";
import {
  createEventCheckIconLoader,
  type EventCheckIconCheck,
  type EventCheckIconTemplate,
  eventCheckIconAddress,
  eventCheckIconUrl,
} from "./event-check-icons";

function apiCheck(id: string, slug: string | undefined): EventCheckIconCheck {
  return {
    id,
    source: {
      kind: "api",
      connectionId: "slack-work",
      toolName: "program.mjs",
      argumentsJson: "{}",
      cursorArgument: "",
      nextCursorPointer: "",
      variables: [],
      configuration: [],
      ...(slug ? { template: { slug, version: "1.0.0" } } : {}),
    },
  };
}

function mcpCheck(id: string): EventCheckIconCheck {
  return {
    id,
    source: {
      kind: "mcp",
      connectionId: "linear",
      toolName: "list_issues",
      argumentsJson: "{}",
      cursorArgument: "",
      nextCursorPointer: "",
    },
  };
}

const templates: EventCheckIconTemplate[] = [
  { slug: "slack-activity", iconUrl: "https://slack.com/favicon.ico" },
  { slug: "gmail-inbox", iconUrl: null },
  { slug: "linear-assigned-intake", iconUrl: "http://linear.app/favicon.ico" },
];

describe("event check icon of an app", () => {
  it("takes the icon of the template that the check was made from", () => {
    expect(eventCheckIconUrl(apiCheck("c1", "slack-activity"), templates)).toBe("https://slack.com/favicon.ico");
  });

  it("has no icon when the template has none, is retired, or the check has no template", () => {
    expect(eventCheckIconUrl(apiCheck("c1", "gmail-inbox"), templates)).toBeNull();
    expect(eventCheckIconUrl(apiCheck("c1", "retired"), templates)).toBeNull();
    expect(eventCheckIconUrl(apiCheck("c1", undefined), templates)).toBeNull();
    expect(eventCheckIconUrl(mcpCheck("c1"), templates)).toBeNull();
    expect(eventCheckIconUrl(undefined, templates)).toBeNull();
  });

  it("draws only an https address", () => {
    expect(eventCheckIconUrl(apiCheck("c1", "linear-assigned-intake"), templates)).toBeNull();
    expect(eventCheckIconAddress("https://slack.com/favicon.ico")).toBe("https://slack.com/favicon.ico");
    expect(eventCheckIconAddress("javascript:alert(1)")).toBeNull();
    expect(eventCheckIconAddress("data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(eventCheckIconAddress("not a url")).toBeNull();
  });
});

describe("event check icon loader", () => {
  function source(checks: EventCheckIconCheck[]) {
    return {
      listChecks: vi.fn(async () => checks),
      listTemplates: vi.fn(async () => templates),
    };
  }

  it("reads the checks once for every chip of an agent, and the templates once", async () => {
    const calls = source([apiCheck("c1", "slack-activity"), apiCheck("c2", "gmail-inbox"), mcpCheck("c3")]);
    const loader = createEventCheckIconLoader(calls);

    const found = await loader.resolve("agent", ["c1", "c2", "c3"]);
    expect([...found]).toEqual([
      ["c1", "https://slack.com/favicon.ico"],
      ["c2", null],
      ["c3", null],
    ]);
    await loader.resolve("agent", ["c1"]);
    await loader.resolve("agent", ["c2", "c3"]);

    expect(calls.listChecks).toHaveBeenCalledTimes(1);
    expect(calls.listChecks).toHaveBeenCalledWith("agent");
    expect(calls.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("reads the checks again for a check it has not seen, and not again for one that is gone", async () => {
    const checks = [apiCheck("c1", "slack-activity")];
    const calls = source(checks);
    const loader = createEventCheckIconLoader(calls);
    await loader.resolve("agent", ["c1"]);

    checks.push(apiCheck("c2", "slack-activity"));
    expect((await loader.resolve("agent", ["c1", "c2"])).get("c2")).toBe("https://slack.com/favicon.ico");
    expect(calls.listChecks).toHaveBeenCalledTimes(2);

    expect((await loader.resolve("agent", ["deleted"])).get("deleted")).toBeNull();
    await loader.resolve("agent", ["deleted", "c1"]);
    expect(calls.listChecks).toHaveBeenCalledTimes(3);
  });

  it("throws when a read fails and asks again on the next call", async () => {
    const calls = source([apiCheck("c1", "slack-activity")]);
    calls.listTemplates.mockRejectedValueOnce(new Error("offline"));
    const loader = createEventCheckIconLoader(calls);

    await expect(loader.resolve("agent", ["c1"])).rejects.toThrow("offline");

    expect((await loader.resolve("agent", ["c1"])).get("c1")).toBe("https://slack.com/favicon.ico");
  });
});
