import type { ServerSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { availableServerSettingsSections } from "./server-settings-sections";

const base: ServerSummary = {
  id: "host",
  name: "Host",
  kind: "remote",
  state: "online",
  role: "member",
  active: true,
  apiUrl: null,
  remoteDesktopAvailable: false,
  logoUrl: null,
  notificationsMuted: false,
  notificationsMutedUntil: null,
  notificationLevel: "all",
};

function host(role: ServerSummary["role"], capabilities: string[]): ServerSummary {
  return {
    ...base,
    role,
    compatibility: {
      localAppVersion: "1.0.0",
      hostAppVersion: "1.0.0",
      localProtocol: { minimum: 1, maximum: 6 },
      hostProtocol: { minimum: 1, maximum: 6 },
      negotiatedProtocol: 6,
      capabilities,
    },
  };
}

describe("available server settings sections", () => {
  it("gives this computer every section on macOS", () => {
    const local: ServerSummary = { ...base, id: "local", kind: "local", role: "owner" };
    expect(availableServerSettingsSections(local, { platform: "darwin", providers: true })).toEqual([
      "general",
      "members",
      "desktop",
      "mcp",
      "storage",
      "sites",
      "providers",
      "import",
      "routines",
      "connectors",
    ]);
  });

  it("leaves out remote desktop off macOS and providers that belong to another server", () => {
    const local: ServerSummary = { ...base, id: "local", kind: "local", role: "owner" };
    const sections = availableServerSettingsSections(local, { platform: "linux", providers: false });
    expect(sections).not.toContain("desktop");
    expect(sections).not.toContain("providers");
  });

  it("gives a member of a joined host only the sections that the host supports", () => {
    expect(
      availableServerSettingsSections(host("member", ["storage-v1", "agent-import-v1"]), {
        platform: "darwin",
        providers: false,
      }),
    ).toEqual(["general", "members", "desktop", "storage", "import"]);
  });

  it("offers MCP and Updates to an administrator of a host that has them", () => {
    const sections = availableServerSettingsSections(host("admin", ["mcp-servers-v1", "host-update-v1"]), {
      platform: "linux",
      providers: true,
    });
    expect(sections).toEqual(["general", "members", "mcp", "providers", "updates"]);
  });
});
