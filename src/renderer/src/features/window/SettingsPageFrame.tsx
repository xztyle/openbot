import type { ServerSummary } from "@openbot/contracts/ipc";
import { ChevronLeft, IconButton, X } from "@openbot/ui";
import { ServerMark } from "@openbot/ui/features/servers/ServerMark";
import type { SettingsPagePlacement } from "@openbot/ui/features/settings/SettingsDialogShell";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled } from "solid-js";
import { requestSettingsLeave } from "./settings-leave-guard";

/**
 * The frame of a settings page, on desktop and on the web: the heading and the section list at the
 * width of the sidebar, and the panel. The settings panel shows its nav and content in the mounts
 * that `onMounts` gets.
 */
export function SettingsPageFrame(props: {
  heading: JSX.Element;
  /** Content between the heading and the section list, such as a search. */
  children?: JSX.Element;
  /** The section list, when the page draws one list for every settings panel. */
  nav?: JSX.Element;
  sectionsHidden?: boolean;
  onMounts: (mounts: SettingsPagePlacement | undefined) => void;
  /** Escape outside a popup or a text field of the window, and the Close or Back button. */
  onEscape: () => void;
  /**
   * The section that the opener asked for, such as `members` of an address. On a phone the page then
   * opens on that section, not on the list of sections.
   */
  section?: string | null;
}) {
  const { t } = useText();
  /**
   * On a phone the page is two screens, as iOS Settings and Slack's app: the list of sections, and
   * the section that a tap on the list opens. Back on a section goes to the list; Back on the list
   * closes the page. A wider window shows both side by side and ignores this.
   */
  const [phoneView, setPhoneView] = createSignal<"list" | "section">("list");
  createEffect(
    () => props.section ?? null,
    (section) => {
      if (section) setPhoneView("section");
    },
  );
  /** Close, Back and Escape: unsaved changes of the open form ask first. */
  const leave = () => requestSettingsLeave(() => props.onEscape());
  /** Back of the phone: the list from a section, or out of the page from the list. */
  const back = () => (phoneView() === "section" ? setPhoneView("list") : leave());
  /** A tap on a section or on a search result opens it over the list. */
  const openSection = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button") && !target.closest(".settings-page-heading")) setPhoneView("section");
  };
  let nav!: HTMLDivElement;
  let content!: HTMLDivElement;
  let root!: HTMLDivElement;
  let navColumn!: HTMLDivElement;

  onSettled(() => {
    props.onMounts({ nav, content });
    // As on the usage and schedule pages, the heading takes the focus, so a screen reader reads the
    // page that opened. The settings shell puts the focus back on the opener when the page closes.
    root.querySelector<HTMLElement>(".settings-page-title")?.focus({ preventScroll: true });
    // Escape closes the page, as it closed the settings dialog. On the document and after the
    // delegated handlers, so a control that handles Escape keeps it. A click can put the focus back on
    // the rail or the server menu, so a target outside the page also counts, except an open popup or a
    // text field.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      if (target && !root.contains(target) && target.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      leave();
    };
    document.addEventListener("keydown", closeOnEscape);
    // In the capture phase: a section is a tab trigger that may stop the click.
    navColumn.addEventListener("click", openSection, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      navColumn.removeEventListener("click", openSection, true);
      props.onMounts(undefined);
    };
  });

  return (
    <div class="settings-page" ref={root} data-phone-view={phoneView()}>
      <div class="settings-page-nav" ref={navColumn}>
        {/* A visible way out: Close on a computer, Back on a phone (docs/ux/standard.md § 5). Escape too. */}
        <div class="settings-page-heading">
          <IconButton variant="ghost" class="settings-page-back" label={t("common.back")} onClick={back}>
            <ChevronLeft />
          </IconButton>
          {props.heading}
          <IconButton variant="ghost" class="settings-page-close" label={t("common.close")} onClick={leave}>
            <X />
          </IconButton>
        </div>
        {props.children}
        <div class="settings-page-sections" ref={nav} hidden={props.sectionsHidden}>
          {props.nav}
        </div>
      </div>
      <div class="settings-page-content" ref={content} />
    </div>
  );
}

/** The heading of a server settings page: the server mark and name, as the server menu shows them. */
export function ServerSettingsPageTitle(props: { server: ServerSummary }) {
  return (
    <h1 class="settings-page-title settings-page-server" tabindex={-1}>
      <span class="server-menu-mark" aria-hidden="true">
        <ServerMark server={props.server} />
      </span>
      <span class="server-menu-name">{props.server.name}</span>
    </h1>
  );
}
