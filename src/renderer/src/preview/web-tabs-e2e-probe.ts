// Loaded in the page by `scripts/web-tabs-e2e.ts`: asks the account service for a remote session as
// the web runtime does, with the real directory client and this tab's real tab ID.
import { runTeamEffect } from "@openbot/team-client";
import { RemoteTeamDirectoryClient } from "@openbot/team-client/remote-directory";
import { Effect } from "effect";
import { webTabInstanceId } from "../features/web-client/web-host-lock";

export async function startSession(hostId: string): Promise<{ sessionId: string; tabId: string }> {
  const directory = new RemoteTeamDirectoryClient({
    apiUrl: location.origin,
    authentication: { kind: "browser" },
    fetch: window.fetch.bind(window),
    verifyHostKeySignature: () => Effect.succeed(false),
    clientInstanceId: webTabInstanceId,
  });
  const bootstrap = await runTeamEffect(directory.createBootstrap(hostId, "client-key-e2e"));
  return { sessionId: bootstrap.sessionId, tabId: await webTabInstanceId() };
}
