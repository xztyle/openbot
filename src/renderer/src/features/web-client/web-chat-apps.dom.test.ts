import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { createRoot } from "solid-js";
import { expect, it } from "vitest";
import { createWebChatApps } from "./web-chat-apps";

it("keeps saved choices untouched when loading fails", async () => {
  let saves = 0;
  let fail = true;
  const request: TeamApiRequest = async (_method, path, decode) => {
    if (path.endsWith("get") && fail) throw new Error("Offline");
    if (path.endsWith("save")) saves += 1;
    return decode({ grants: [], connections: [] });
  };
  const state = createRoot(() => createWebChatApps(() => request));
  await state.open({ kind: "agent", id: "one" });
  await state.save();
  expect(saves).toBe(0);
  expect(state.state.open).toBe(true);
  fail = false;
  await state.open({ kind: "agent", id: "one" });
  await state.save();
  expect(saves).toBe(1);
});
