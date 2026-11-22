import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { ActionSheet, type ActionSheetItem } from "../../action-sheet";
import { Button, IconButton } from "../../button";
import { ChevronDown, ChevronLeft, ChevronRight, Search, Server, SquarePen } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { SpaceMark, type SpaceRailItem } from "../spaces/SpaceRail";
import { MemberAvatar } from "./WorkspaceAvatar";
import type { WorkspaceMember, WorkspaceMenuItem } from "./workspace-types";

/** The count on a badge shows up to this number. */
const MAX_COUNT = 99;

function countText(count: number): string {
  return count > MAX_COUNT ? `${MAX_COUNT}+` : String(count);
}

/** A shortcut at the top of the phone's Home, as Slack's row of Threads, Drafts and Saved. */
export interface PhoneChip {
  id: string;
  label: string;
  icon: JSX.Element;
  /** The chip has news, such as a thread with a new reply. */
  unread?: boolean | undefined;
  /** A short note after the label, such as "2 working". */
  detail?: string | undefined;
  /** Something waits for the reader here: the chip stands out ("Needs you"). */
  urgent?: boolean | undefined;
  onSelect: () => void;
}

/** A row of shortcut chips that scrolls sideways, as under the phone's Home header. */
export function PhoneChips(props: { chips: readonly PhoneChip[]; label?: string | undefined }): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.chips.length > 0}>
      <ul class="ws-phone-chips" aria-label={props.label ?? t("workspace.phone.shortcuts")}>
        <For each={props.chips} keyed={(chip) => chip.id}>
          {(chip) => (
            <li>
              <Button
                variant="secondary"
                class="ws-phone-chip"
                data-unread={chip().unread ? "" : undefined}
                data-urgent={chip().urgent ? "" : undefined}
                aria-label={[chip().label, chip().detail ?? "", chip().unread ? t("workspace.sidebar.unread") : ""]
                  .filter(Boolean)
                  .join(", ")}
                onClick={() => chip().onSelect()}
              >
                <span class="ws-phone-chip-icon" aria-hidden="true">
                  {chip().icon}
                </span>
                <span aria-hidden="true">{chip().label}</span>
                <Show when={chip().detail}>
                  {(detail) => (
                    <span class="ws-phone-chip-detail" aria-hidden="true">
                      {detail()}
                    </span>
                  )}
                </Show>
                <Show when={chip().unread}>
                  <span class="ws-unread-dot" aria-hidden="true" />
                </Show>
              </Button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** The mark of the space at the top left of Home. Without spaces the server's initials show. */
export interface PhoneHomeMark {
  name: string;
  icon: string | null;
  hue: SpaceRailItem["hue"];
}

export interface PhoneHomeHeaderProps {
  /** The name of the space, or of the server on a host without spaces. */
  title: string;
  mark: PhoneHomeMark;
  /** Mentions in the other spaces and servers. The mark shows their count, as Slack's workspace icon. */
  elsewhereCount?: number | undefined;
  /** Unread messages in the other spaces, without mentions: the mark shows a dot. */
  elsewhereUnread?: boolean | undefined;
  /** Opens the switcher of spaces and servers. */
  onOpenSwitcher?: (() => void) | undefined;
  /** The workspace's actions: the title opens them in a sheet. */
  menuItems: readonly WorkspaceMenuItem[];
  onSearch: () => void;
  onCompose?: (() => void) | undefined;
  chips: readonly PhoneChip[];
}

/**
 * The top of the phone's Home, as in Slack: the space's mark (the switcher), its name (its actions),
 * search and new message, a Jump to field, and a row of shortcuts in place of the sidebar's views.
 */
export function PhoneHomeHeader(props: PhoneHomeHeaderProps): JSX.Element {
  const { t } = useText();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const elsewhere = () => props.elsewhereCount ?? 0;
  const menuLabel = () => t("workspace.sidebar.workspaceMenu", { name: props.title });
  return (
    <header class="ws-phone-home-header">
      <div class="ws-phone-home-bar">
        <Show
          when={props.onOpenSwitcher}
          fallback={
            <SpaceMark name={props.mark.name} icon={props.mark.icon} hue={props.mark.hue} class="ws-phone-mark" />
          }
        >
          {(open) => (
            <Button
              variant="ghost"
              class="ws-phone-mark-button"
              aria-label={[
                t("workspace.phone.switch"),
                elsewhere() > 0
                  ? t("workspace.sidebar.mentions", { count: elsewhere() })
                  : props.elsewhereUnread
                    ? t("workspace.sidebar.unread")
                    : "",
              ]
                .filter(Boolean)
                .join(", ")}
              onClick={() => open()()}
            >
              <SpaceMark name={props.mark.name} icon={props.mark.icon} hue={props.mark.hue} class="ws-phone-mark" />
              <Show
                when={elsewhere() > 0}
                fallback={
                  <Show when={props.elsewhereUnread}>
                    <span class="ws-phone-mark-dot" aria-hidden="true" />
                  </Show>
                }
              >
                <span class="ws-phone-mark-count" aria-hidden="true">
                  {countText(elsewhere())}
                </span>
              </Show>
            </Button>
          )}
        </Show>
        <Show
          when={props.menuItems.length > 0}
          fallback={<h1 class="ws-phone-home-title ws-truncate">{props.title}</h1>}
        >
          <Button
            variant="ghost"
            class="ws-phone-home-title ws-phone-home-title-button"
            aria-haspopup="dialog"
            aria-label={menuLabel()}
            onClick={() => setMenuOpen(true)}
          >
            <span class="ws-truncate">{props.title}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </Show>
        <div class="ws-phone-home-actions">
          <IconButton variant="ghost" label={t("workspace.app.menu.search")} onClick={() => props.onSearch()}>
            <Search />
          </IconButton>
          <Show when={props.onCompose}>
            {(compose) => (
              <IconButton
                variant="secondary"
                class="ws-phone-compose"
                label={t("workspace.sidebar.newMessage")}
                onClick={() => compose()()}
              >
                <SquarePen />
              </IconButton>
            )}
          </Show>
        </div>
      </div>
      <PhoneChips chips={props.chips} />
      <ActionSheet
        open={menuOpen()}
        onOpenChange={setMenuOpen}
        title={props.title}
        showTitle
        items={props.menuItems.map(
          (item): ActionSheetItem => ({
            id: item.id,
            label: item.label,
            icon: item.icon,
            danger: item.danger,
            disabled: item.disabled,
            onSelect: item.onSelect,
          }),
        )}
      />
    </header>
  );
}

/** A server in the phone's switcher. */
export interface PhoneSwitcherServer {
  id: string;
  name: string;
  active: boolean;
  /** Not connected, such as offline or asleep. */
  unavailable?: boolean | undefined;
}

export interface PhoneSwitcherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: readonly SpaceRailItem[];
  activeSpaceId: string;
  onSelectSpace: (spaceId: string) => void;
  /** The account's servers. The list shows when there is more than one. */
  servers?: readonly PhoneSwitcherServer[] | undefined;
  onSelectServer?: ((serverId: string) => void) | undefined;
  /** Actions under the lists, such as Create a space. */
  actions?: readonly ActionSheetItem[] | undefined;
}

/**
 * The phone's switcher of spaces and servers, as Slack's workspace switcher: a sheet with one row
 * for each space, with its unread dot or mention count, then the other servers.
 */
export function PhoneSwitcherSheet(props: PhoneSwitcherSheetProps): JSX.Element {
  const { t } = useText();
  const choose = (action: () => void) => {
    props.onOpenChange(false);
    action();
  };
  return (
    <ActionSheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t("workspace.phone.switch")}
      class="ws-phone-switcher"
      header={
        <>
          <Show when={props.spaces.length > 0}>
            <section class="ws-phone-switcher-section" aria-label={t("workspace.phone.spaces")}>
              <h2 class="ws-phone-switcher-heading">{t("workspace.phone.spaces")}</h2>
              <ul class="ws-phone-switcher-list">
                <For each={props.spaces} keyed={(space) => space.id}>
                  {(space) => {
                    const active = () => space().id === props.activeSpaceId;
                    return (
                      <li>
                        <Button
                          variant="ghost"
                          class="ws-phone-switcher-row"
                          data-active={active() ? "" : undefined}
                          aria-current={active() ? "true" : undefined}
                          aria-label={[
                            space().name,
                            space().mentionCount > 0
                              ? t("workspace.sidebar.mentions", { count: space().mentionCount })
                              : space().unread
                                ? t("workspace.sidebar.unread")
                                : "",
                          ]
                            .filter(Boolean)
                            .join(", ")}
                          onClick={() => choose(() => props.onSelectSpace(space().id))}
                        >
                          <SpaceMark name={space().name} icon={space().icon} hue={space().hue} class="ws-phone-mark" />
                          <span
                            class="ws-phone-switcher-name ws-truncate"
                            data-unread={space().unread ? "" : undefined}
                          >
                            {space().name}
                          </span>
                          <Show
                            when={space().mentionCount > 0}
                            fallback={
                              <Show when={space().unread && !active()}>
                                <span class="ws-unread-dot" aria-hidden="true" />
                              </Show>
                            }
                          >
                            <span class="ws-mention-badge" aria-hidden="true">
                              {countText(space().mentionCount)}
                            </span>
                          </Show>
                        </Button>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </section>
          </Show>
          <Show when={(props.servers?.length ?? 0) > 1 && props.onSelectServer}>
            {(select) => (
              <section class="ws-phone-switcher-section" aria-label={t("workspace.phone.servers")}>
                <h2 class="ws-phone-switcher-heading">{t("workspace.phone.servers")}</h2>
                <ul class="ws-phone-switcher-list">
                  <For each={props.servers ?? []} keyed={(server) => server.id}>
                    {(server) => (
                      <li>
                        <Button
                          variant="ghost"
                          class="ws-phone-switcher-row"
                          data-active={server().active ? "" : undefined}
                          data-unavailable={server().unavailable ? "" : undefined}
                          aria-current={server().active ? "true" : undefined}
                          onClick={() => choose(() => select()(server().id))}
                        >
                          <span class="ws-phone-switcher-server-icon" aria-hidden="true">
                            <Server />
                          </span>
                          <span class="ws-phone-switcher-name ws-truncate">{server().name}</span>
                        </Button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </Show>
        </>
      }
      items={props.actions ?? []}
    />
  );
}

/** A row of the phone's More tab. */
export interface PhoneMoreRow {
  id: string;
  label: string;
  icon: JSX.Element;
  /** A short value at the right, such as the server's name. */
  detail?: string | undefined;
  count?: number | undefined;
  danger?: boolean | undefined;
  onSelect: () => void;
}

export interface PhoneMoreSection {
  id: string;
  title?: string | undefined;
  rows: readonly PhoneMoreRow[];
}

export interface PhoneMoreScreenProps {
  /** The reader, at the top: a tap opens their settings. */
  account: { name: string; email: string; avatarUrl: string | null };
  onOpenAccount: () => void;
  sections: readonly PhoneMoreSection[];
  /** More opens from Today's header: its back button goes back there. */
  onBack?: (() => void) | undefined;
}

/**
 * The phone's More tab, as Slack's You and More: the reader's profile and settings, then the views
 * that the desktop keeps under More, and the server's pages.
 */
export function PhoneMoreScreen(props: PhoneMoreScreenProps): JSX.Element {
  const { t } = useText();
  const member = (): WorkspaceMember => ({
    id: "reader",
    kind: "human",
    name: props.account.name,
    avatarUrl: props.account.avatarUrl,
  });
  return (
    <section class="ws-phone-screen" aria-label={t("workspace.phone.more")}>
      <header class={cx("ws-phone-screen-header", props.onBack && "ws-phone-screen-header-back")}>
        <Show when={props.onBack}>
          {(back) => (
            <IconButton
              variant="ghost"
              class="ws-phone-compose"
              label={t("workspace.layout.back")}
              onClick={() => back()()}
            >
              <ChevronLeft />
            </IconButton>
          )}
        </Show>
        <h1 class="ws-phone-screen-title">{t("workspace.phone.more")}</h1>
      </header>
      <div class="ws-phone-screen-scroll">
        <Button variant="ghost" class="ws-phone-profile" onClick={() => props.onOpenAccount()}>
          <MemberAvatar member={member()} size="xl" />
          <span class="ws-phone-profile-copy">
            <span class="ws-phone-profile-name ws-truncate">{props.account.name}</span>
            <Show when={props.account.email}>
              <span class="ws-phone-profile-email ws-truncate">{props.account.email}</span>
            </Show>
          </span>
          <ChevronRight aria-hidden="true" />
        </Button>
        <For each={props.sections.filter((section) => section.rows.length > 0)} keyed={(section) => section.id}>
          {(section) => (
            <section class="ws-phone-more-section" aria-label={section().title}>
              <Show when={section().title}>{(title) => <h2 class="ws-phone-more-heading">{title()}</h2>}</Show>
              <ul class="ws-phone-more-list">
                <For each={section().rows} keyed={(row) => row.id}>
                  {(row) => (
                    <li>
                      <Button
                        variant="ghost"
                        class={cx("ws-phone-more-row", row().danger && "ws-phone-more-row-danger")}
                        aria-label={[
                          row().label,
                          row().detail ?? "",
                          (row().count ?? 0) > 0 ? countText(row().count ?? 0) : "",
                        ]
                          .filter(Boolean)
                          .join(", ")}
                        onClick={() => row().onSelect()}
                      >
                        <span class="ws-phone-more-icon" aria-hidden="true">
                          {row().icon}
                        </span>
                        <span class="ws-phone-more-label ws-truncate" aria-hidden="true">
                          {row().label}
                        </span>
                        <Show when={row().detail}>
                          {(detail) => (
                            <span class="ws-phone-more-detail ws-truncate" aria-hidden="true">
                              {detail()}
                            </span>
                          )}
                        </Show>
                        <Show when={(row().count ?? 0) > 0}>
                          <span class="ws-mention-badge" aria-hidden="true">
                            {countText(row().count ?? 0)}
                          </span>
                        </Show>
                        <ChevronRight class="ws-phone-more-chevron" aria-hidden="true" />
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
    </section>
  );
}
