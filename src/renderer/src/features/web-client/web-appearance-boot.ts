import { ATELIER_THEME_STORAGE_KEY } from "../../atelier-theme-key";

/** The key under which this browser keeps the web client's theme. */
export const WEB_APPEARANCE_STORAGE_KEY = "openbot.web.appearance";

/**
 * An inline script for the head of `/app`. It shows the saved theme before the first paint: without
 * it, the loading screen paints dark until its code runs. No saved theme leaves the dark default.
 * The loading screen's code then takes over, and removes the attribute when the user leaves `/app`.
 * The Atelier theme of the last workspace shows too, Craft Studio before the first one.
 */
export const WEB_APPEARANCE_BOOT_SCRIPT = `try{var d=document.documentElement.dataset;d.atelierTheme="craft";var a=localStorage.getItem(${JSON.stringify(WEB_APPEARANCE_STORAGE_KEY)});if(a==="system")a=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";if(a==="light"||a==="dark")d.openbotColorScheme=a;var w=JSON.parse(localStorage.getItem(${JSON.stringify(ATELIER_THEME_STORAGE_KEY)})||"{}");if(w.theme==="modern"||w.theme==="riso")d.atelierTheme=w.theme}catch(e){}`;
