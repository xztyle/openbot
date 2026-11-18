import type { TextValue } from "@openbot/ui/text";
import { createEffect, onCleanup } from "solid-js";

/** What the tab tells: a count of things for the user, or only that something is unread. */
export interface WebTitleBadge {
  /** Mentions, DM messages and agents that wait for the user, as the badges of the sidebar count them. */
  count: number;
  /** Something is unread that the count leaves out, such as a new message in a channel. */
  unread: boolean;
}

/** The icon of the site. The badge draws on it, so the tab keeps the OpenBot mark. */
const BASE_ICON = "/favicon-32x32.png";
const ICON_SIZE = 64;
/** The count shows up to this number; above it the badge reads "9+". */
const MAX_SHOWN = 9;

let baseImage: Promise<HTMLImageElement | null> | null = null;

function loadBaseImage(): Promise<HTMLImageElement | null> {
  baseImage ??= new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    // Without the icon (a preview has none), the badge shows alone.
    image.addEventListener("error", () => resolve(null));
    image.src = BASE_ICON;
  });
  return baseImage;
}

/** The colours of the badge, from the design tokens of the page. */
function badgeColors(): { fill: string; text: string; ring: string } {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    fill: read("--openbot-danger") || read("--openbot-accent"),
    text: read("--openbot-text-on-status") || read("--openbot-text-primary"),
    ring: read("--openbot-bg-canvas"),
  };
}

/** The site icon with a count or a dot at its top right corner, as a data address. Null without a canvas. */
async function drawIcon(badge: WebTitleBadge): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = await loadBaseImage();
  if (image) context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  const colors = badgeColors();
  const counted = badge.count > 0;
  const radius = counted ? ICON_SIZE * 0.3 : ICON_SIZE * 0.18;
  const x = ICON_SIZE - radius;
  const y = radius;
  context.beginPath();
  context.arc(x, y, radius + ICON_SIZE * 0.04, 0, Math.PI * 2);
  context.fillStyle = colors.ring;
  context.fill();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = colors.fill;
  context.fill();
  if (counted) {
    context.fillStyle = colors.text;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const label = badge.count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(badge.count);
    context.font = `bold ${Math.round(radius * (label.length > 1 ? 1.15 : 1.5))}px system-ui, sans-serif`;
    context.fillText(label, x, y + radius * 0.08);
  }
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * The browser tab tells what waits for the user, as Slack's does: the title starts with the count of
 * mentions, DM messages and waiting agents, and the icon gets a badge with that count. Unread messages
 * that the count leaves out give the icon a dot only. The same numbers show on the space rail and the
 * sidebar rows, so the tab, the rail and the rows agree.
 */
export function createWebTitleBadge(options: { badge: () => WebTitleBadge; t: TextValue["t"] }): void {
  const baseTitle = document.title;
  /** The icon link that this module added, or the page's own that it changed, with its address before. */
  let icon: { link: HTMLLinkElement; added: boolean; href: string } | null = null;
  /** The drawing that the newest badge asked for; an older one that ends later is dropped. */
  let drawing = 0;

  function iconLink(): { link: HTMLLinkElement; added: boolean; href: string } {
    if (icon) return icon;
    const existing = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (existing) icon = { link: existing, added: false, href: existing.href };
    else {
      const link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/png";
      document.head.append(link);
      icon = { link, added: true, href: BASE_ICON };
    }
    return icon;
  }

  function restoreIcon(): void {
    if (!icon) return;
    if (icon.added) icon.link.remove();
    else icon.link.href = icon.href;
    icon = null;
  }

  createEffect(
    () => {
      const { count, unread } = options.badge();
      return { count, unread };
    },
    (badge) => {
      document.title =
        badge.count > 0 ? options.t("webClient.title.attention", { count: badge.count, title: baseTitle }) : baseTitle;
      const current = ++drawing;
      if (badge.count === 0 && !badge.unread) {
        restoreIcon();
        return;
      }
      void drawIcon(badge).then((href) => {
        if (current !== drawing || !href) return;
        iconLink().link.href = href;
      });
    },
  );
  onCleanup(() => {
    drawing++;
    document.title = baseTitle;
    restoreIcon();
  });
}
