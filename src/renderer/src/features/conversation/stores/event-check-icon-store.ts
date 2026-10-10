import { EVENT_CHECK_API_CAPABILITY } from "@openbot/contracts/team-protocol/event-check-api-v1";
import { EVENT_CHECK_TEMPLATES_CAPABILITY } from "@openbot/contracts/team-protocol/event-check-templates-v1";
import { EVENT_CHECKS_CAPABILITY } from "@openbot/contracts/team-protocol/event-checks-v1";
import type { MessageEventCheckOrigin } from "@openbot/ui/data";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { serverCanAdminister } from "../../servers/server-capabilities";
import type { ConversationProps } from "../conversation-types";
import { createEventCheckIconLoader, type EventCheckIconLoader, type EventCheckIconSource } from "../event-check-icons";

export interface EventCheckIconStoreDeps {
  /** Where this conversation's host can be read, or undefined when it cannot. See `eventCheckIconSource`. */
  source: () => EventCheckIconSource | undefined;
  /** The agent of the conversation, whose checks the chips name. */
  agentId: () => string | undefined;
  /** The chips the timeline draws, by message id. */
  origins: () => ReadonlyMap<string, MessageEventCheckOrigin>;
}

/**
 * Where the checks and templates of this conversation's host can be read, or undefined when the
 * person cannot read them. Reading both is an owner or admin call, so a member of a joined host
 * sees the bell, as a check that no host call can name does.
 */
export function eventCheckIconSource(props: ConversationProps): EventCheckIconSource | undefined {
  const runtime = props.runtime;
  if (runtime) {
    const checks = runtime.admin?.eventChecks;
    const templates = runtime.admin?.eventCheckTemplates;
    if (!checks || !templates) return undefined;
    return {
      listChecks: (agentId) => checks.list({ agentId }),
      listTemplates: () => templates.list(),
    };
  }
  const server = props.server;
  if (
    !serverCanAdminister(server, EVENT_CHECKS_CAPABILITY) ||
    !serverCanAdminister(server, EVENT_CHECK_API_CAPABILITY) ||
    !serverCanAdminister(server, EVENT_CHECK_TEMPLATES_CAPABILITY)
  )
    return undefined;
  // The bridge scopes a call to a joined server by its last argument, and to this computer without it.
  const serverId = server.kind === "remote" ? server.id : undefined;
  return {
    listChecks: (agentId) => window.openbot.eventChecks.list({ agentId }, serverId),
    listTemplates: () => window.openbot.eventCheckTemplates.list(serverId),
  };
}

/**
 * The icon of the app of each event check that a chip names.
 *
 * A chip has the id of its check. The check knows the template it was made from, and the template
 * has the icon that the Marketplace draws for it. The host keeps no cache that the chat could read,
 * so this store reads the checks of the agent and the templates of the host once for the chips of
 * the conversation, never once for a chip, and keeps them until the host changes. The image itself
 * loads the way the Marketplace card does, from the https address in the template.
 *
 * A read that fails leaves the bell. Nothing waits for an icon.
 */
export function createEventCheckIconStore(deps: EventCheckIconStoreDeps) {
  const loader = createMemo(() => {
    const source = deps.source();
    return source ? createEventCheckIconLoader(source) : undefined;
  });
  // What was read, with the loader that read it: a host change leaves the old answers unused.
  const [read, setRead] = createSignal<{
    loader: EventCheckIconLoader;
    icons: ReadonlyMap<string, string | null>;
  } | null>(null);
  const known = () => {
    const current = read();
    return current && current.loader === loader() ? current.icons : undefined;
  };
  // One text, so a streamed token that leaves the chips as they are does not run the read again.
  const checkIds = createMemo(() =>
    [...new Set([...deps.origins().values()].map((origin) => origin.checkId))].sort().join("\0"),
  );
  let request = 0;
  createEffect(
    () => ({ loader: loader(), agentId: deps.agentId(), ids: checkIds() }),
    ({ loader: current, agentId, ids }) => {
      const sequence = ++request;
      if (!current || !agentId || !ids) return;
      const answered = untrack(known);
      const wanted = ids.split("\0").filter((id) => !answered?.has(id));
      if (wanted.length === 0) return;
      void current.resolve(agentId, wanted).then(
        (found) => {
          if (sequence !== request) return;
          setRead((previous) => ({
            loader: current,
            icons: new Map([...(previous?.loader === current ? previous.icons : []), ...found]),
          }));
        },
        () => {
          // The chip keeps its bell. A later change of the chips or of the host asks again.
        },
      );
    },
  );

  /** The https address of the icon of the app of the check, or null for the bell. */
  const eventCheckIconUrl = (checkId: string | undefined): string | null =>
    checkId === undefined ? null : (known()?.get(checkId) ?? null);
  return { eventCheckIconUrl };
}
