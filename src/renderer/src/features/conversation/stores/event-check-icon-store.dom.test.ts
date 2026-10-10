import type { MessageEventCheckOrigin } from "@openbot/ui/data";
import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { EventCheckIconCheck, EventCheckIconSource } from "../event-check-icons";
import { createEventCheckIconStore } from "./event-check-icon-store";

const slackCheck: EventCheckIconCheck = {
  id: "slack-check",
  source: {
    kind: "api",
    connectionId: "slack-work",
    toolName: "program.mjs",
    argumentsJson: "{}",
    cursorArgument: "",
    nextCursorPointer: "",
    variables: [],
    configuration: [],
    template: { slug: "slack-activity", version: "1.0.0" },
  },
};

function chip(checkId: string): MessageEventCheckOrigin {
  return { name: "Slack", checkId, timestamp: "2026-09-13T21:03:00.000Z", position: "only" };
}

function host(iconUrl: string | null, listChecks = vi.fn(async () => [slackCheck])) {
  const listTemplates = vi.fn(async () => [{ slug: "slack-activity", iconUrl }]);
  return { listChecks, listTemplates } satisfies EventCheckIconSource;
}

/** Waits for the reads that the store started, then applies the signal writes. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
}

describe("event check icon store", () => {
  it("reads the checks and templates once for the chips and answers by check id", async () => {
    const source = host("https://slack.com/favicon.ico");
    await createRoot(async (dispose) => {
      const [origins, setOrigins] = createSignal(
        new Map([
          ["m1", chip("slack-check")],
          ["m2", chip("slack-check")],
        ]),
      );
      const store = createEventCheckIconStore({ source: () => source, agentId: () => "chief", origins });
      flush();
      expect(store.eventCheckIconUrl("slack-check")).toBeNull();
      await settle();
      expect(store.eventCheckIconUrl("slack-check")).toBe("https://slack.com/favicon.ico");
      expect(store.eventCheckIconUrl("other")).toBeNull();
      expect(store.eventCheckIconUrl(undefined)).toBeNull();
      expect(source.listChecks).toHaveBeenCalledTimes(1);
      expect(source.listChecks).toHaveBeenCalledWith("chief");
      expect(source.listTemplates).toHaveBeenCalledTimes(1);

      // Another chip of the same check asks for nothing.
      setOrigins(new Map([["m3", chip("slack-check")]]));
      flush();
      await settle();
      expect(source.listChecks).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  it("asks for nothing without a chip, and keeps the bell without a readable host or when a read fails", async () => {
    const quiet = host("https://slack.com/favicon.ico");
    const refused = host(
      "https://slack.com/favicon.ico",
      vi.fn(async () => {
        throw new Error("forbidden");
      }),
    );
    await createRoot(async (dispose) => {
      const origins = () => new Map([["m1", chip("slack-check")]]);
      const noChip = createEventCheckIconStore({
        source: () => quiet,
        agentId: () => "chief",
        origins: () => new Map(),
      });
      const noHost = createEventCheckIconStore({ source: () => undefined, agentId: () => "chief", origins });
      const failing = createEventCheckIconStore({ source: () => refused, agentId: () => "chief", origins });
      flush();
      await settle();
      expect(quiet.listChecks).not.toHaveBeenCalled();
      expect(noChip.eventCheckIconUrl("slack-check")).toBeNull();
      expect(noHost.eventCheckIconUrl("slack-check")).toBeNull();
      expect(failing.eventCheckIconUrl("slack-check")).toBeNull();
      dispose();
    });
  });

  it("leaves the icons of a host that was replaced, and reads the new host", async () => {
    await createRoot(async (dispose) => {
      const [source, setSource] = createSignal(host("https://one.example/icon.png"));
      const store = createEventCheckIconStore({
        source,
        agentId: () => "chief",
        origins: () => new Map([["m1", chip("slack-check")]]),
      });
      flush();
      await settle();
      expect(store.eventCheckIconUrl("slack-check")).toBe("https://one.example/icon.png");

      setSource(host("https://two.example/icon.png"));
      flush();
      expect(store.eventCheckIconUrl("slack-check")).toBeNull();
      await settle();
      expect(store.eventCheckIconUrl("slack-check")).toBe("https://two.example/icon.png");
      dispose();
    });
  });
});
