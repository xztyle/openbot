import type { SidebarView } from "@openbot/ui/features/sidebar/sidebar-types";
import { PAGE_RAIL_PINNABLE_PAGES, type PageRailPinnablePage } from "@openbot/ui/features/window/PageRail";
import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { z } from "zod/mini";
import { readPanelWidth } from "./components/panel-width-storage";
import {
  CONVERSATION_MIN_WIDTH,
  LEFT_PANEL_COLLAPSED_STORAGE_KEY,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_STORAGE_KEY,
  RAIL_PINS_STORAGE_KEY,
  SIDEBAR_VIEW_STORAGE_KEY,
} from "./layout-constants";
import { createSimpleContext } from "./simple-context";

/** Whether the conversation still has room beside a sidebar of this width. */
function shouldAutoCompactSidebar(panelWidth: number): boolean {
  return window.innerWidth - panelWidth < CONVERSATION_MIN_WIDTH;
}

/** The pages in the rail until the user chooses. The others start in the More menu. */
const RAIL_PINNED_BY_DEFAULT: ReadonlySet<PageRailPinnablePage> = new Set(["workflows", "usage"]);

// A record, not an object: a page that only another version knows keeps its choice when this version saves.
const railPinChoicesSchema = z.record(z.string(), z.catch(z.optional(z.boolean()), undefined));

type RailPinChoices = z.infer<typeof railPinChoicesSchema>;

/**
 * The pin choices that the user made on this computer. Only a choice is saved, so a page that a later
 * version adds gets its default. Blocked storage or a damaged value reads as no choice.
 */
function readRailPinChoices(): RailPinChoices {
  try {
    const parsed = railPinChoicesSchema.safeParse(
      JSON.parse(window.localStorage.getItem(RAIL_PINS_STORAGE_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The width of the workspace sidebar, and the two independent reasons it can be
 * narrow: the user collapsed it, or the window is too small to keep it open.
 *
 * Only the first is persisted. The second is recomputed from the window on every
 * resize, so restoring a wide sidebar into a narrow
 * window compacts it again rather than restoring an unusable layout - and
 * `expandSidebar` clears both, because a user asking for the sidebar back means
 * both reasons at once.
 *
 * The user also pins pages to the page rail. Pages that are not pinned are in its More menu. The
 * choice is saved on this computer.
 *
 * The geometry itself is in `layout-constants.ts`; the view imports it directly
 * rather than reading constants through a context.
 */
const Layout = createSimpleContext({
  name: "Layout",
  init: () => {
    const [leftPanelWidth, setLeftPanelWidth] = createSignal(
      readPanelWidth(LEFT_PANEL_STORAGE_KEY, LEFT_PANEL_DEFAULT, LEFT_PANEL_MIN, LEFT_PANEL_MAX),
    );
    const [leftPanelCollapsed, setLeftPanelCollapsed] = createSignal(
      window.localStorage.getItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY) === "true",
    );
    const [sidebarView, setSidebarViewSignal] = createSignal<SidebarView>(
      window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "routines" ? "routines" : "agents",
    );
    const [railPinChoices, setRailPinChoices] = createSignal<RailPinChoices>(readRailPinChoices());
    const railPinned = createMemo(() => {
      const choices = railPinChoices();
      return PAGE_RAIL_PINNABLE_PAGES.filter((page) => choices[page] ?? RAIL_PINNED_BY_DEFAULT.has(page));
    });
    const [leftPanelAutoCompact, setLeftPanelAutoCompact] = createSignal(false);
    const leftPanelCompact = createMemo(() => leftPanelCollapsed() || leftPanelAutoCompact());

    function updateResponsiveSidebar(): void {
      setLeftPanelAutoCompact(shouldAutoCompactSidebar(leftPanelWidth()));
    }

    createEffect(leftPanelWidth, (panelWidth) => {
      setLeftPanelAutoCompact(shouldAutoCompactSidebar(panelWidth));
    });

    onSettled(() => {
      window.addEventListener("resize", updateResponsiveSidebar);
      return () => window.removeEventListener("resize", updateResponsiveSidebar);
    });

    // Another window or browser tab can change the pins.
    function readRailPinsFromStorage(event: StorageEvent): void {
      if (event.key === null || event.key === RAIL_PINS_STORAGE_KEY) setRailPinChoices(readRailPinChoices());
    }

    onSettled(() => {
      window.addEventListener("storage", readRailPinsFromStorage);
      return () => window.removeEventListener("storage", readRailPinsFromStorage);
    });

    function setSidebarCollapsed(collapsed: boolean): void {
      setLeftPanelCollapsed(collapsed);
      window.localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
    }

    function setSidebarView(view: SidebarView): void {
      setSidebarViewSignal(view);
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    }

    function setRailPinned(page: PageRailPinnablePage, pinned: boolean): void {
      // Start from the saved value, so the choices of another window stay. Blocked storage reads as no choice.
      const choices = { ...railPinChoices(), ...readRailPinChoices(), [page]: pinned };
      setRailPinChoices(choices);
      try {
        window.localStorage.setItem(RAIL_PINS_STORAGE_KEY, JSON.stringify(choices));
      } catch {
        // Blocked or full storage keeps the choice for this window only.
      }
    }

    function expandSidebar(): void {
      setSidebarCollapsed(false);
      setLeftPanelAutoCompact(false);
    }

    return {
      leftPanelWidth,
      setLeftPanelWidth,
      leftPanelCompact,
      setSidebarCollapsed,
      expandSidebar,
      sidebarView,
      setSidebarView,
      railPinned,
      setRailPinned,
    };
  },
});

export const LayoutProvider = Layout.provider;
export const useLayout = Layout.use;
