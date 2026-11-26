import {
  ActionSheet,
  type ActionSheetItem,
  Badge,
  Button,
  buttonVariants,
  Clock3,
  DropdownMenu,
  Ellipsis,
  Globe2,
  IconButton,
  LabelTooltip,
  LabelTooltipTrigger,
  Lock,
  PanelRight,
  Search,
  Settings,
} from "@openbot/ui";
import { ProviderModelPicker } from "@openbot/ui/components/ProviderModelPicker";
import type { AgentProfile } from "@openbot/ui/data";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { agentAccessLockLabel } from "@openbot/ui/features/agents/agent-access";
import { RemoteDesktopIcon } from "@openbot/ui/features/conversation/ConversationIcons";
import { SidePanelToggle, type SidePanelToggleProps } from "@openbot/ui/features/conversation/SidePanel";
import { useText } from "@openbot/ui/text";
import type { ComponentProps, JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

export interface ConversationHeaderProps {
  actions?: JSX.Element;
  /**
   * The choices of `actions` for the More sheet of a phone, where the header keeps only the model and
   * More. Left out when `actions` has nothing a phone needs.
   */
  menuActions?: readonly ActionSheetItem[] | undefined;
  agent: AgentProfile | null | undefined;
  /** The title of a chat that has no one agent, such as a channel. It shows when `agent` is missing. */
  title?: JSX.Element | undefined;
  modelPicker: ComponentProps<typeof ProviderModelPicker>;
  /** A model, effort, provider or account chosen during the running turn. It applies from the next turn. */
  pendingModel?: ConversationHeaderPendingModel | undefined;
  onSettingsIntent: () => void;
  onOpenSettings: () => void;
  /**
   * Opens the search of this conversation. A phone has no Cmd+F, so the header offers a button.
   * Left out where the client has no conversation search.
   */
  onOpenSearch?: (() => void) | undefined;
  remoteControl?: ConversationHeaderRemoteControl | undefined;
  /** Missing when the chat has no side panel, such as a deleted channel. */
  sidePanel?: SidePanelToggleProps | undefined;
  /**
   * The agent's browser tabs, to watch or work in one at any time. Left out, or empty, when the
   * agent has no tab or this client cannot show one.
   */
  browser?: ConversationHeaderBrowser | undefined;
}

export interface ConversationHeaderBrowser {
  tabs: readonly { id: string; title: string; url: string }[];
  onOpen: (tabId: string) => void;
}

export interface ConversationHeaderPendingModel {
  /** The model, and the effort when it changes too, of the running turn. */
  running: string;
  /** The same for the next turn. */
  next: string;
}

export interface ConversationHeaderRemoteControl {
  enabled: boolean;
  active: boolean;
  visible: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
}

export function ConversationHeader(props: ConversationHeaderProps) {
  const { t } = useText();
  const [browserMenuOpen, setBrowserMenuOpen] = createSignal(false);
  return (
    <header class="window-drag conversation-header">
      <div class="conversation-heading-group">
        <Show when={props.agent} fallback={props.title}>
          {(agent) => (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="conversation-title no-drag"
              aria-label={t("conversation.header.settings")}
              onPointerEnter={props.onSettingsIntent}
              onFocus={props.onSettingsIntent}
              onClick={props.onOpenSettings}
            >
              <AgentAvatar agent={agent()} />
              <h1>{agent().name}</h1>
            </Button>
          )}
        </Show>
        <Show when={props.agent && agentAccessLockLabel(props.agent, t)}>
          {(label) => (
            <span class="conversation-access-lock" role="img" aria-label={label()} title={label()}>
              <Lock aria-hidden="true" />
            </span>
          )}
        </Show>
      </div>
      <div class="conversation-header-actions no-drag">
        {props.actions}
        <Show when={props.agent && props.pendingModel}>
          {(change) => {
            const detail = () => t("conversation.header.modelNextTurnDetail", change());
            return (
              <Badge variant="info-light" class="conversation-model-pending" role="status" title={detail()}>
                <Clock3 aria-hidden="true" />
                {t("conversation.header.modelNextTurn")}
                <span class="sr-only">{detail()}</span>
              </Badge>
            );
          }}
        </Show>
        <Show when={props.agent}>
          <ProviderModelPicker {...props.modelPicker} />
        </Show>
        <Show when={props.onOpenSearch && props.agent}>
          <LabelTooltip content={t("chat.search.label")}>
            <LabelTooltipTrigger
              as={Button}
              variant="ghost"
              type="button"
              class="header-panel-toggle"
              aria-label={t("chat.search.label")}
              onClick={() => props.onOpenSearch?.()}
              data-cuelume-tap="open"
            >
              <Search aria-hidden="true" class="ui-icon-sm" />
            </LabelTooltipTrigger>
          </LabelTooltip>
        </Show>
        <Show when={props.agent && props.browser && props.browser.tabs.length > 0 ? props.browser : undefined}>
          {(browser) => (
            <DropdownMenu.Root placement="bottom-end" gutter={4} onOpenChange={setBrowserMenuOpen}>
              <LabelTooltip
                content={t("conversation.header.browser", { name: props.agent?.name ?? "" })}
                disabled={browserMenuOpen()}
              >
                <LabelTooltipTrigger
                  as={DropdownMenu.Trigger}
                  class={`${buttonVariants({ variant: "ghost" })} header-panel-toggle`}
                  aria-label={t("conversation.header.browser", { name: props.agent?.name ?? "" })}
                >
                  <Globe2 aria-hidden="true" class="ui-icon-sm" />
                </LabelTooltipTrigger>
              </LabelTooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="conversation-browser-menu">
                  <For each={browser().tabs}>
                    {(tab) => (
                      <DropdownMenu.Item onSelect={() => browser().onOpen(tab.id)}>
                        <span class="conversation-browser-menu-title">{tab.title || pageHost(tab.url)}</span>
                        <small class="conversation-browser-menu-host">{pageHost(tab.url)}</small>
                      </DropdownMenu.Item>
                    )}
                  </For>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </Show>
        <Show when={props.remoteControl}>
          {(control) => (
            <Button
              variant="ghost"
              type="button"
              class="header-panel-toggle remote-desktop-button"
              aria-label={t(control().active ? "conversation.header.resumeRemote" : "conversation.header.openRemote")}
              aria-expanded={control().visible ? "true" : "false"}
              disabled={!control().enabled}
              onClick={(event) => control().onOpen(event.currentTarget)}
              data-cuelume-tap="open"
            >
              <RemoteDesktopIcon />
              <Show when={control().active}>
                <span class="remote-desktop-button-dot" aria-hidden="true" />
              </Show>
            </Button>
          )}
        </Show>
        <Show when={props.sidePanel}>{(sidePanel) => <SidePanelToggle {...sidePanel()} />}</Show>
        <Show when={props.agent}>{(agent) => <PhoneMoreMenu {...props} agentName={agent().name} />}</Show>
      </div>
    </header>
  );
}

/**
 * A phone has room for the model and one button in the header row, as Slack's DM header: More opens
 * the other controls (apps, search, the browser, remote control, the side panel and the agent's
 * settings) in a sheet. The CSS shows it, and hides those controls, only on a narrow screen.
 */
function PhoneMoreMenu(props: ConversationHeaderProps & { agentName: string }) {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  const items = (): ActionSheetItem[] => {
    const list: ActionSheetItem[] = [...(props.menuActions ?? [])];
    const search = props.onOpenSearch;
    if (search)
      list.push({
        id: "search",
        label: t("chat.search.label"),
        icon: <Search aria-hidden="true" />,
        onSelect: search,
      });
    for (const tab of props.browser?.tabs ?? [])
      list.push({
        id: `browser:${tab.id}`,
        label: `${t("conversation.header.browser", { name: props.agentName })}: ${tab.title || pageHost(tab.url)}`,
        icon: <Globe2 aria-hidden="true" />,
        onSelect: () => props.browser?.onOpen(tab.id),
      });
    const remote = props.remoteControl;
    if (remote)
      list.push({
        id: "remote",
        label: t(remote.active ? "conversation.header.resumeRemote" : "conversation.header.openRemote"),
        icon: <RemoteDesktopIcon />,
        disabled: !remote.enabled,
        onSelect: () => {
          const trigger = document.querySelector<HTMLButtonElement>(".conversation-header .remote-desktop-button");
          if (trigger) remote.onOpen(trigger);
        },
      });
    const panel = props.sidePanel;
    if (panel)
      list.push({
        id: "side-panel",
        label: t(panel.open ? "conversation.sidePanel.close" : "conversation.sidePanel.open"),
        icon: <PanelRight aria-hidden="true" />,
        onSelect: () => panel.onToggle(),
      });
    list.push({
      id: "settings",
      label: t("conversation.header.settings"),
      icon: <Settings aria-hidden="true" />,
      onSelect: () => props.onOpenSettings(),
    });
    return list;
  };
  return (
    <>
      <IconButton
        variant="ghost"
        class="conversation-header-more"
        label={t("workspace.message.more")}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(true)}
      >
        <Ellipsis />
      </IconButton>
      <Show when={open()}>
        <ActionSheet open onOpenChange={setOpen} title={t("workspace.message.more")} items={items()} />
      </Show>
    </>
  );
}

function pageHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
