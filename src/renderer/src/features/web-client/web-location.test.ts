import { describe, expect, it } from "vitest";
import {
  emptyWebLocation,
  formatWebLocation,
  parseLegacyWebMessageHash,
  parseWebLocation,
  sameWebPlace,
  type WebLocation,
} from "./web-location";

function place(change: Partial<WebLocation>): WebLocation {
  return { ...emptyWebLocation(), ...change };
}

const ROUND_TRIPS: Array<[string, WebLocation, boolean]> = [
  ["/app", place({}), false],
  ["/app/s/host-1", place({ hostId: "host-1" }), false],
  ["/app/market-sniper", place({ hostId: "host-1", space: "market-sniper" }), false],
  ["/app/s/host-1/market-sniper", place({ hostId: "host-1", space: "market-sniper" }), true],
  [
    "/app/general/c/chan-1",
    place({ hostId: "host-1", space: "general", target: { kind: "channel", channelId: "chan-1", threadRootId: null } }),
    false,
  ],
  [
    "/app/s/host-1/general/c/chan-1/t/root-9",
    place({
      hostId: "host-1",
      space: "general",
      target: { kind: "channel", channelId: "chan-1", threadRootId: "root-9" },
    }),
    true,
  ],
  [
    "/app/general/c/chan-1/t/root-9/m/msg-3",
    place({
      hostId: "host-1",
      space: "general",
      target: { kind: "channel", channelId: "chan-1", threadRootId: "root-9" },
      messageId: "msg-3",
    }),
    false,
  ],
  [
    "/app/general/c/chan-1/m/msg-3",
    place({
      hostId: "host-1",
      space: "general",
      target: { kind: "channel", channelId: "chan-1", threadRootId: null },
      messageId: "msg-3",
    }),
    false,
  ],
  [
    "/app/general/dm/agent-7",
    place({ hostId: "host-1", space: "general", target: { kind: "agent", agentId: "agent-7" } }),
    false,
  ],
  [
    "/app/general/dm/agent-7/m/msg-1",
    place({ hostId: "host-1", space: "general", target: { kind: "agent", agentId: "agent-7" }, messageId: "msg-1" }),
    false,
  ],
  [
    "/app/general/activity",
    place({ hostId: "host-1", space: "general", target: { kind: "view", view: "activity", agentId: null } }),
    false,
  ],
  [
    "/app/general/agents",
    place({ hostId: "host-1", space: "general", target: { kind: "view", view: "space-agents", agentId: null } }),
    false,
  ],
  [
    "/app/general/between-agents",
    place({ hostId: "host-1", space: "general", target: { kind: "view", view: "agents", agentId: null } }),
    false,
  ],
  [
    "/app/general/between-agents/agent-7",
    place({ hostId: "host-1", space: "general", target: { kind: "view", view: "agents", agentId: "agent-7" } }),
    false,
  ],
  [
    "/app/general/org",
    place({ hostId: "host-1", space: "general", target: { kind: "view", view: "org", agentId: null } }),
    false,
  ],
  [
    "/app/general/fleet?page=server-settings&section=members",
    place({
      hostId: "host-1",
      space: "general",
      target: { kind: "view", view: "fleet", agentId: null },
      page: { kind: "server-settings", section: "members" },
    }),
    false,
  ],
  [
    "/app/general/dm/agent-7?page=settings",
    place({
      hostId: "host-1",
      space: "general",
      target: { kind: "agent", agentId: "agent-7" },
      page: { kind: "settings", section: null },
    }),
    false,
  ],
];

function split(address: string): [string, string] {
  const at = address.indexOf("?");
  return at < 0 ? [address, ""] : [address.slice(0, at), address.slice(at)];
}

describe("web location addresses", () => {
  it.each(ROUND_TRIPS)("%s reads back as the place it was written from", (address, location, includeHost) => {
    expect(formatWebLocation(location, { includeHost })).toBe(address);
    const [path, search] = split(address);
    const read = parseWebLocation(path, search);
    // An address without the server does not name it; the client keeps the server it has.
    expect(read).toEqual(includeHost || address === "/app/s/host-1" ? location : { ...location, hostId: null });
  });

  it("names the server when the space slug reads as the server mark", () => {
    const location = place({ hostId: "h", space: "s", target: { kind: "view", view: "threads", agentId: null } });
    const address = formatWebLocation(location, { includeHost: false });
    expect(address).toBe("/app/s/h/s/threads");
    expect(parseWebLocation(address)).toEqual(location);
  });

  it("encodes ids that hold reserved characters", () => {
    const location = place({
      hostId: "host 1",
      space: "café",
      target: { kind: "channel", channelId: "discord-1:2", threadRootId: "a?b#c" },
    });
    const address = formatWebLocation(location, { includeHost: true });
    expect(address).toBe("/app/s/host%201/caf%C3%A9/c/discord-1%3A2/t/a%3Fb%23c");
    expect(parseWebLocation(address)).toEqual(location);
  });

  it("reads only addresses of the web client", () => {
    expect(parseWebLocation("/")).toBeNull();
    expect(parseWebLocation("/app-preview")).toBeNull();
    expect(parseWebLocation("/apps/general")).toBeNull();
    expect(parseWebLocation("/app/")).toEqual(place({}));
  });

  it("keeps the parts before a part that does not read", () => {
    expect(parseWebLocation("/app/general/c")).toEqual(place({ space: "general" }));
    expect(parseWebLocation("/app/general/unknown-view/x")).toEqual(place({ space: "general" }));
    expect(parseWebLocation("/app/general/c/%E0%A4%A")).toEqual(place({ space: "general" }));
    expect(parseWebLocation("/app/s")).toEqual(place({}));
    expect(parseWebLocation(`/app/general/dm/${"a".repeat(201)}`)).toEqual(place({ space: "general" }));
    // A message mark needs a conversation.
    expect(parseWebLocation("/app/general/activity/m/msg-1")).toEqual(
      place({ space: "general", target: { kind: "view", view: "activity", agentId: null } }),
    );
  });

  it("drops a page or a section that it does not know", () => {
    expect(parseWebLocation("/app/general", "?page=billing")).toEqual(place({ space: "general" }));
    expect(parseWebLocation("/app/general", "?page=server-settings&section=..%2Fx")).toEqual(
      place({ space: "general", page: { kind: "server-settings", section: null } }),
    );
  });

  it("reads a message link of an older web client as its thread", () => {
    expect(parseLegacyWebMessageHash("#ws=host-1/chan-1/msg-2")).toEqual(
      place({ hostId: "host-1", target: { kind: "channel", channelId: "chan-1", threadRootId: "msg-2" } }),
    );
    expect(parseLegacyWebMessageHash("#ws=host-1/chan-1")).toBeNull();
    expect(parseLegacyWebMessageHash("#other")).toBeNull();
  });

  it("compares places without the message to show", () => {
    const base = place({
      hostId: "h",
      space: "general",
      target: { kind: "channel", channelId: "c", threadRootId: null },
    });
    expect(sameWebPlace(base, { ...base, messageId: "m" })).toBe(true);
    expect(sameWebPlace(base, { ...base, target: { kind: "channel", channelId: "c", threadRootId: "r" } })).toBe(false);
    expect(sameWebPlace(base, { ...base, page: { kind: "settings", section: null } })).toBe(false);
    expect(sameWebPlace(base, { ...base, space: "other" })).toBe(false);
  });
});
