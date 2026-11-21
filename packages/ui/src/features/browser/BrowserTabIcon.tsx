import type { BrowserTab } from "@openbot/contracts/ipc";
import { Globe2, LoaderCircle } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";
import { AVATAR_HUE_CHOICES, avatarHueSwatch } from "../../bloub-avatar";
import type { BrowserFullViewProps } from "./browser-full-view-types";
import { browserDisplayUrl } from "./browser-suggestions";
import { type BrowserShortcutName, browserShortcutGlyph } from "./browser-view-shortcuts";

/** The agent of a tab, or a globe for a tab of the user. A ring shows that the agent acts on the page now. */
export function BrowserOwnerIcon(props: { agent: AgentProfile | undefined; acting?: boolean }) {
  return (
    <Show when={props.agent} fallback={<Globe2 class="browser-full-owner-globe" aria-hidden="true" />}>
      {(agent) => (
        <AgentAvatar
          agent={agent()}
          class={props.acting ? "browser-full-owner-avatar browser-full-owner-acting" : "browser-full-owner-avatar"}
        />
      )}
    </Show>
  );
}

/** The site of an address, for its mark: the host without `www.`. Empty for a page that is not on the web. */
function siteHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.replace(/^www\./u, "") : "";
  } catch {
    return "";
  }
}

/**
 * The mark of a site: its first letter on a color that the host name selects, so each site keeps its
 * color. The client does not load the page's own icon: that request would tell a third party which
 * pages the agents visit.
 */
export function BrowserSiteIcon(props: { url: string; acting?: boolean }) {
  const host = () => siteHost(props.url);
  const hue = () => {
    let hash = 0;
    for (const character of host()) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
    return (AVATAR_HUE_CHOICES[hash % AVATAR_HUE_CHOICES.length] ?? AVATAR_HUE_CHOICES[0])?.hue ?? 215;
  };
  return (
    <Show when={host()} fallback={<Globe2 class="browser-full-owner-globe" aria-hidden="true" />}>
      <span
        class="browser-site-icon"
        data-acting={props.acting ? "" : undefined}
        style={{ background: avatarHueSwatch(hue()) }}
        aria-hidden="true"
      >
        {host().charAt(0).toUpperCase()}
      </span>
    </Show>
  );
}

/**
 * The icon of a tab: a spinner while it loads, else the mark of its site. When the row shows the tabs
 * of all agents, the avatar of the tab's agent is on the mark.
 */
export function BrowserTabIcon(props: { view: BrowserFullViewProps; tab: BrowserTab }) {
  const acting = () => props.view.controlForTab(props.tab)?.phase === "acting";
  const owner = () => (props.view.showAllTabs ? props.view.ownerForTab(props.tab) : undefined);
  return (
    <Show when={!props.tab.loading} fallback={<LoaderCircle class="browser-full-spin" aria-hidden="true" />}>
      <span class="browser-tab-icon">
        <BrowserSiteIcon url={props.tab.url} acting={acting()} />
        <Show when={owner()}>{(agent) => <AgentAvatar agent={agent()} class="browser-tab-icon-owner" />}</Show>
      </span>
    </Show>
  );
}

/** The keys of a menu row. The web client has none. */
export function BrowserShortcutHint(props: { view: BrowserFullViewProps; name: BrowserShortcutName }) {
  return (
    <Show when={props.view.shortcuts}>
      {(platform) => (
        <span class="ui-menu-trailing" aria-hidden="true">
          {browserShortcutGlyph(props.name, platform())}
        </span>
      )}
    </Show>
  );
}

/** The name of a tab: its title, its address, or the loading text. */
export function useBrowserTabTitle() {
  const { t } = useText();
  return (tab: BrowserTab) =>
    tab.loading && !tab.title ? t("common.loading") : tab.title || browserDisplayUrl(tab.url) || t("browser.newTab");
}
