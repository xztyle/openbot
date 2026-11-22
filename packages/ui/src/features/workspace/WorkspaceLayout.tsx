import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, createUniqueId, Show } from "solid-js";
import { PanelResizer } from "../../components/PanelResizer";
import { useText } from "../../text";
import { cx } from "../../utils";

export type WorkspacePane = "sidebar" | "main" | "panel";

export const WORKSPACE_SIDEBAR_WIDTH = { default: 260, min: 200, max: 420 } as const;
export const WORKSPACE_PANEL_WIDTH = { default: 400, min: 320, max: 640 } as const;

export interface WorkspaceLayoutProps {
  /** The server switcher at the far left, as Slack's workspace rail. */
  rail?: JSX.Element;
  sidebar: JSX.Element;
  main: JSX.Element;
  /** The right panel: a thread or channel details. It shows when it is set. */
  panel?: JSX.Element | undefined;
  /** The sidebar width in pixels. Without it the layout keeps its own width. */
  sidebarWidth?: number | undefined;
  onSidebarWidthChange?: ((width: number) => void) | undefined;
  /** Hides the sidebar on a wide screen. */
  sidebarCollapsed?: boolean | undefined;
  panelWidth?: number | undefined;
  onPanelWidthChange?: ((width: number) => void) | undefined;
  /**
   * The one pane that a narrow layout shows. Each pane's header has the back button that goes to
   * the pane before it; the caller changes this value.
   */
  phonePane?: WorkspacePane | undefined;
  class?: string;
}

/**
 * The Slack grid: rail, sidebar, message pane and an optional right panel. The sidebar and the
 * panel resize from their inner edge. Under 720px of width the layout shows one pane at a time.
 */
export function WorkspaceLayout(props: WorkspaceLayoutProps): JSX.Element {
  const { t } = useText();
  const sidebarId = createUniqueId();
  const panelId = createUniqueId();
  const [sidebarWidth, setSidebarWidth] = createSignal(() => props.sidebarWidth ?? WORKSPACE_SIDEBAR_WIDTH.default);
  const [panelWidth, setPanelWidth] = createSignal(() => props.panelWidth ?? WORKSPACE_PANEL_WIDTH.default);
  /*
   * The right panel takes the focus when it opens (a thread's composer) and drops it when it closes.
   * The last element focused outside it, such as the "View thread" button, takes the focus back, or
   * the message box when that one is gone; without this the focus fell to the page.
   */
  let root: HTMLDivElement | undefined;
  let panel: HTMLElement | undefined;
  let lastOutside: HTMLElement | null = null;
  createEffect(
    () => Boolean(props.panel),
    (open, wasOpen) => {
      if (open || !wasOpen) return;
      const target = lastOutside;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const fallback = root?.querySelector<HTMLElement>('.ws-layout-main [contenteditable="true"]');
        (target?.isConnected ? target : fallback)?.focus({ preventScroll: true });
      });
    },
  );
  const phonePane = (): WorkspacePane => {
    const pane = props.phonePane ?? "main";
    return pane === "panel" && !props.panel ? "main" : pane;
  };
  return (
    <div
      ref={root}
      class={cx("ws-layout", props.class)}
      onFocusIn={(event) => {
        if (event.target instanceof HTMLElement && !panel?.contains(event.target)) lastOutside = event.target;
      }}
      data-phone-pane={phonePane()}
      data-panel={props.panel ? "" : undefined}
      data-sidebar-collapsed={props.sidebarCollapsed ? "" : undefined}
      style={{ "--ws-sidebar-width": `${sidebarWidth()}px`, "--ws-panel-width": `${panelWidth()}px` }}
    >
      <Show when={props.rail}>
        <div class="ws-layout-rail">{props.rail}</div>
      </Show>
      <div id={sidebarId} class="ws-layout-sidebar">
        {props.sidebar}
        <PanelResizer
          class="ws-layout-resizer ws-layout-resizer-end"
          label={t("workspace.layout.resizeSidebar")}
          controls={sidebarId}
          direction="left"
          value={sidebarWidth()}
          defaultValue={WORKSPACE_SIDEBAR_WIDTH.default}
          min={WORKSPACE_SIDEBAR_WIDTH.min}
          max={WORKSPACE_SIDEBAR_WIDTH.max}
          onResize={setSidebarWidth}
          onResizeEnd={(width) => props.onSidebarWidthChange?.(width)}
        />
      </div>
      <main class="ws-layout-main">{props.main}</main>
      <Show when={props.panel}>
        <aside ref={panel} id={panelId} class="ws-layout-panel">
          <PanelResizer
            class="ws-layout-resizer ws-layout-resizer-start"
            label={t("workspace.layout.resizePanel")}
            controls={panelId}
            direction="right"
            value={panelWidth()}
            defaultValue={WORKSPACE_PANEL_WIDTH.default}
            min={WORKSPACE_PANEL_WIDTH.min}
            max={WORKSPACE_PANEL_WIDTH.max}
            onResize={setPanelWidth}
            onResizeEnd={(width) => props.onPanelWidthChange?.(width)}
          />
          {props.panel}
        </aside>
      </Show>
    </div>
  );
}
