/*
 * The top bar of the workspace on a computer, as Slack's: the search field of the space in the
 * middle and the keyboard shortcuts at the end, then "Needs you" while a request waits for the
 * reader. A phone has no top bar; its search is a view, and its Home has the "Needs you" chip.
 */

import { Bug, Button } from "@openbot/ui";
import {
  type SearchSuggestion,
  WorkspaceSearchBar,
  type WorkspaceSearchBarApi,
} from "@openbot/ui/features/workspace/WorkspaceSearchBar";
import { useText } from "@openbot/ui/text";
import { onCleanup, Show } from "solid-js";
import { currentDevicePlatform } from "../../send-shortcut-preference";
import { WorkspaceNeedsYouButton } from "./WorkspaceNeedsYou";
import { WorkspaceFocusButton } from "./WorkspaceOwnerAway";
import { useJumpEntries } from "./WorkspaceSwitcher";
import { useWorkspace } from "./workspace-context";
import { debugMode, setDebugMode } from "./workspace-debug";
import { useDecisionQueue } from "./workspace-decisions";
import { shortcutKeys, shortcutLabel } from "./workspace-shortcuts";

export function WorkspaceTopBar() {
  const ws = useWorkspace();
  const { t } = useText();
  const jump = useJumpEntries();
  // The one queue of every space: a loop decision or a request of another space shows the bar too.
  const waiting = useDecisionQueue();
  let element: HTMLDivElement | undefined;
  let api: WorkspaceSearchBarApi | undefined;
  onCleanup(
    ws.search.attachBar({
      focus: (text) => api?.focus(text),
      visible: () => Boolean(element?.isConnected && element.offsetParent !== null),
    }),
  );
  const scope = () =>
    ws.spaces.available() ? (ws.spaces.space(ws.spaces.current())?.name ?? ws.env.serverName()) : ws.env.serverName();
  const suggestions = (text: string): SearchSuggestion[] =>
    jump
      .entries(text, 6)
      .filter((entry) => entry.kind !== "view" && entry.kind !== "create" && entry.kind !== "search")
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        kind: entry.kind === "channel" || entry.kind === "dm" || entry.kind === "agent" ? entry.kind : "person",
        private: entry.private,
        member: entry.member,
      }));
  return (
    <>
      <Show when={ws.env.phone() && debugMode()}>
        <WorkspaceDebugBadge floating />
      </Show>
      <Show
        when={
          !ws.env.phone() &&
          (ws.search.supported() || waiting.queue().length > 0 || Boolean(ws.env.ownerAway?.supported()) || debugMode())
        }
      >
        <div class="ws-topbar" ref={(div) => (element = div)}>
          <Show when={ws.search.supported()}>
            <WorkspaceSearchBar
              ref={(next) => (api = next)}
              placeholder={t("workspace.search.placeholderIn", { name: scope() })}
              shortcut={shortcutKeys(["mod"], "G", currentDevicePlatform() === "darwin").join(
                currentDevicePlatform() === "darwin" ? "" : "+",
              )}
              query={(() => {
                const route = ws.route();
                return route.kind === "view" && route.view === "search" ? ws.search.state.query : "";
              })()}
              recent={ws.search.state.recent}
              suggestions={suggestions}
              onSubmit={(query) => ws.openSearch(query)}
              onOpenSuggestion={(id) => {
                if (id.startsWith("person:")) ws.messageMember(id.slice("person:".length));
                else ws.openConversation(id);
              }}
              onShortcuts={() => ws.openDialog({ kind: "shortcuts" })}
              shortcutsLabel={t("workspace.shortcuts.title")}
              shortcutsKey={shortcutLabel(["mod"], "/")}
            />
          </Show>
          <WorkspaceNeedsYouButton queue={waiting} />
          <WorkspaceFocusButton />
          <Show when={debugMode()}>
            <WorkspaceDebugBadge />
          </Show>
        </div>
      </Show>
    </>
  );
}

/** "Debug" while debug mode is on, so it is obvious; a click turns it off. */
function WorkspaceDebugBadge(props: { floating?: boolean }) {
  const { t } = useText();
  const mac = currentDevicePlatform() === "darwin";
  return (
    <Button
      variant="outline"
      size="xs"
      class="ws-debug-badge"
      data-floating={props.floating ? "" : undefined}
      title={t("workspace.debug.badgeTitle", { keys: shortcutKeys(["mod", "shift"], "D", mac).join(mac ? "" : "+") })}
      onClick={() => setDebugMode(false)}
    >
      <Bug aria-hidden="true" />
      {t("workspace.debug.badge")}
    </Button>
  );
}
