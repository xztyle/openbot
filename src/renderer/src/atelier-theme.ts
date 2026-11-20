import { DEFAULT_WORKSPACE_APPEARANCE, type WorkspaceAppearance, workspaceAppearanceOf } from "@openbot/contracts/ipc";
import { ATELIER_THEME_STORAGE_KEY } from "./atelier-theme-key";

/**
 * `atelier-themes.css` gives the Atelier theme of the root element's `data-atelier-theme`, and the
 * faces read `data-atelier-faces` (`@openbot/ui/atelier-appearance`). The server owner chooses both
 * in Server settings; the last value read is kept here, so the next start paints it at once.
 */
function applyToRoot(appearance: WorkspaceAppearance): void {
  document.documentElement.dataset.atelierTheme = appearance.theme;
  document.documentElement.dataset.atelierFaces = appearance.faces;
  document.documentElement.dataset.atelierSkin = appearance.skin;
}

function cachedAppearance(): WorkspaceAppearance {
  try {
    const raw = window.localStorage.getItem(ATELIER_THEME_STORAGE_KEY);
    return raw ? workspaceAppearanceOf(JSON.parse(raw)) : DEFAULT_WORKSPACE_APPEARANCE;
  } catch {
    return DEFAULT_WORKSPACE_APPEARANCE;
  }
}

/** Shows the look of the last workspace, Craft Studio before any server answered. */
export function showCachedAtelierTheme(): void {
  applyToRoot(cachedAppearance());
}

/** Shows the look that the server of this window chose, and keeps it for the next start. */
export function applyWorkspaceAppearance(value: unknown): void {
  const appearance = workspaceAppearanceOf(value);
  applyToRoot(appearance);
  try {
    window.localStorage.setItem(ATELIER_THEME_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // The look holds for this window when browser storage is unavailable.
  }
}

/** Removes the Atelier look, so a public page keeps its own. */
export function clearAtelierTheme(): void {
  delete document.documentElement.dataset.atelierTheme;
  delete document.documentElement.dataset.atelierFaces;
  delete document.documentElement.dataset.atelierSkin;
}
