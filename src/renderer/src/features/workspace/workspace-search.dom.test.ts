import type { WorkspaceSearchInput, WorkspaceSearchPage } from "@openbot/contracts/ipc";
import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ChannelsController } from "../channels/channels-controller";
import type { WorkspaceDirectory } from "./workspace-model";
import { createWorkspaceSearch } from "./workspace-search";

// Failure mode: "Show more" spins for good when a new search runs while a page of the last one loads.
function setup() {
  const calls: { input: WorkspaceSearchInput; resolve: (page: WorkspaceSearchPage) => void }[] = [];
  const workspaceSearch = (input: WorkspaceSearchInput) =>
    new Promise<WorkspaceSearchPage>((resolve) => calls.push({ input, resolve }));
  const stub = { port: () => ({ agent: { workspaceSearch } }), state: { channels: [] } };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a stub of the members that the search reads.
  const channels = stub as unknown as ChannelsController;
  const directory = (): WorkspaceDirectory => ({
    reader: { id: "me", name: "Me", avatarUrl: null },
    people: [],
    agents: [],
    isReader: (id) => id === "me",
    agentStates: {},
  });
  const search = createRoot(() =>
    createWorkspaceSearch({
      channels,
      directory,
      storageKey: () => "reader:host",
      connectionReady: () => true,
      currentSpace: () => null,
    }),
  );
  return { search, calls };
}

const page = (cursor: string | null): WorkspaceSearchPage => ({ hits: [], total: 40, nextCursor: cursor });
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flush();
};

describe("workspace search", () => {
  it("lets go of a page that loads when a new search starts", async () => {
    const { search, calls } = setup();
    search.submit("pricing");
    calls[0]?.resolve(page("20"));
    await settle();
    void search.loadMore();
    flush();
    expect(search.state.loadingMore).toBe(true);
    search.submit("rivals");
    flush();
    calls[2]?.resolve(page("20"));
    calls[1]?.resolve(page(null));
    await settle();
    expect(search.state.query).toBe("rivals");
    expect(search.state.nextCursor).toBe("20");
    expect(search.state.loadingMore).toBe(false);
    // The new search's next page loads.
    void search.loadMore();
    flush();
    expect(calls).toHaveLength(4);
  });
});
