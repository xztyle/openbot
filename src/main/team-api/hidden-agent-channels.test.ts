import { describe, expect, it } from "vitest";
import { hiddenAuthor, requireVisibleChannel, seesChannel } from "./hidden-agent-channels";

const hidden = new Set(["agent-finance"]);
const members = (...ids: string[]) => ids.map((agentId) => ({ agentId }));

describe("hidden-agent channels", () => {
  it("hides a channel whose members are all hidden agents", () => {
    expect(seesChannel(members("agent-finance"), hidden)).toBe(false);
    expect(seesChannel(members("agent-finance", "agent-general"), hidden)).toBe(true);
    expect(seesChannel([], hidden)).toBe(true);
  });

  it("answers a hidden channel as one that does not exist", () => {
    const channels = { store: { exists: () => true, get: () => ({ members: members("agent-finance") }) } };
    expect(() => requireVisibleChannel(channels, "channel-1", hidden)).toThrow();
    expect(() => requireVisibleChannel(channels, "channel-1", new Set())).not.toThrow();
  });

  it("finds the messages of a hidden agent", () => {
    const message = (kind: "agent" | "member", id: string) => ({ author: { kind, id, name: id } });
    expect(hiddenAuthor(message("agent", "agent-finance"), hidden)).toBe(true);
    expect(hiddenAuthor(message("agent", "agent-general"), hidden)).toBe(false);
    expect(hiddenAuthor(message("member", "agent-finance"), hidden)).toBe(false);
  });
});
