/*
 * What a right-click or a long press on a message landed on, and the actions of that thing. An image
 * offers to copy, save, open and annotate itself; a file to open and download; a link to open and
 * copy; a code block to copy its code; selected text to copy and quote; the author's face or name
 * to open the profile or a direct message. The message's own actions follow them under a divider.
 *
 * The target is read from the DOM that the message renderers draw, so the menu needs no wiring from
 * each renderer: an `img` in a preview button, a `.message-attachment` card, an `a[href]`, a
 * `.message-code-block`, the row's `.ws-profile-trigger`.
 */
import { Copy, Download, ExternalLink, Highlighter, Link, MessageCircle, TextQuote, UserRound } from "../../icons";
import { useText } from "../../text";
import { toast } from "../../toast";
import type { WorkspaceMenuItem } from "./workspace-types";

export interface ImageTarget {
  kind: "image";
  /** The attachment the image shows, or null for a picture in the Markdown text. */
  attachmentId: string | null;
  /** The URL the picture draws from now: a small copy, a `blob:` or `data:` URL, or a web address. */
  src: string;
  name: string;
  /** Opens the picture as a tap on it does: in the viewer. Null when nothing opens it. */
  open: (() => void) | null;
}

export type MessageContextTarget =
  | ImageTarget
  | { kind: "file"; attachmentId: string; name: string }
  | { kind: "link"; href: string }
  | { kind: "code"; text: string }
  | { kind: "selection"; text: string }
  /** The author's face or name. `open` shows the profile, as a tap does. */
  | { kind: "member"; open: (() => void) | null }
  | { kind: "message" };

/** The actions that a target's items run. An absent action leaves its item out. */
export interface MessageTargetActions {
  /** Saves an image or a file: the attachment downloads. A Markdown picture saves from its URL. */
  download?: ((attachmentId: string) => void) | undefined;
  /** Opens a file in the viewer or in its app. */
  openFile?: ((attachmentId: string) => void) | undefined;
  /** Opens the image editor on a picture. The editor fills this in. */
  annotateImage?: ((image: Omit<ImageTarget, "kind" | "open">) => void) | undefined;
  openLink?: ((href: string) => void) | undefined;
  /** Quotes the selected text in the reply. */
  quote?: ((text: string) => void) | undefined;
  /** Opens a direct message with the author. */
  directMessage?: (() => void) | undefined;
}

const PREVIEW_BUTTON = "button[data-attachment-id], .message-markdown-image-button, .attachment-preview-button";

/** A web address that a person can paste somewhere: not a `blob:` or `data:` URL of a loaded copy. */
export function isShareableUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/**
 * Reads what `pressed` is, inside the message `root`. `selection` is the document's selection at the
 * press: selected text that includes the pressed node is what the person means to act on.
 */
export function resolveMessageContextTarget(
  pressed: EventTarget | null,
  root: HTMLElement,
  selection: Selection | null = globalThis.getSelection?.() ?? null,
): MessageContextTarget {
  const element = pressed instanceof Element ? pressed : pressed instanceof Node ? pressed.parentElement : null;
  if (!element || !root.contains(element)) return { kind: "message" };
  const selected = selectedText(selection, root, element);
  if (selected) return { kind: "selection", text: selected };

  const profile = element.closest<HTMLElement>(".ws-profile-trigger");
  if (profile && root.contains(profile)) {
    const trigger = profile.matches("button, [role='button']") ? profile : profile.querySelector("button");
    return { kind: "member", open: trigger instanceof HTMLElement ? () => trigger.click() : null };
  }

  const image = element.closest<HTMLImageElement>("img");
  if (image && !image.closest(".message-link-icon, .ws-avatar") && image.currentSrc) {
    const opener = image.closest<HTMLElement>(PREVIEW_BUTTON);
    const attachmentId = opener?.dataset.attachmentId ?? null;
    const card = image.closest(".message-attachment");
    const name =
      card?.querySelector("strong")?.textContent?.trim() || image.alt.trim() || nameFromUrl(image.currentSrc);
    return {
      kind: "image",
      attachmentId,
      src: image.currentSrc,
      name,
      open: opener instanceof HTMLButtonElement && !opener.disabled ? () => opener.click() : null,
    };
  }

  const link = element.closest<HTMLAnchorElement>("a[href]");
  if (link && root.contains(link) && isShareableUrl(link.href)) return { kind: "link", href: link.href };

  const card = element.closest<HTMLElement>(".message-attachment");
  if (card && root.contains(card)) {
    const id = card.querySelector<HTMLElement>("[data-attachment-id]")?.dataset.attachmentId;
    if (id) return { kind: "file", attachmentId: id, name: card.querySelector("strong")?.textContent?.trim() ?? "" };
  }

  const block = element.closest<HTMLElement>(".message-code-block");
  if (block && root.contains(block)) {
    const lines = Array.from(block.querySelectorAll(".message-code-line-source"), (line) => line.textContent ?? "");
    const text = lines.length ? lines.join("\n") : (block.querySelector("pre")?.textContent ?? "");
    if (text.trim()) return { kind: "code", text: text.replace(/\n$/u, "") };
  }
  const inline = element.closest("code");
  if (inline && root.contains(inline) && inline.textContent?.trim())
    return { kind: "code", text: inline.textContent.trim() };

  return { kind: "message" };
}

function selectedText(selection: Selection | null, root: HTMLElement, pressed: Element): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer) || !range.intersectsNode(pressed)) return "";
  return selection.toString().trim();
}

function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "image";
  } catch {
    return "image";
  }
}

/** Copies a picture's pixels. The clipboard takes PNG only, so another format is redrawn as PNG. */
export async function copyImageToClipboard(src: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("No image clipboard.");
  const png = async (): Promise<Blob> => {
    const response = await fetch(src);
    const blob = await response.blob();
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("No PNG."))), "image/png"),
    );
  };
  // The item is made in the tap, with the pending bytes, so Safari keeps the user activation.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]);
}

/** Saves a picture that is not an attachment, such as one in the Markdown text, through a download link. */
export function saveImageFromUrl(src: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = src;
  anchor.download = name;
  anchor.rel = "noopener";
  if (isShareableUrl(src)) anchor.target = "_blank";
  anchor.click();
}

/**
 * The items of a target, in the order the menu shows them. The result reads `actions()` when it
 * runs, so a row whose handlers change keeps the menu right.
 */
export function createMessageTargetItems(
  actions: () => MessageTargetActions | undefined,
): (target: MessageContextTarget) => WorkspaceMenuItem[] {
  const { t } = useText();
  const copyText = (text: string, done: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(done),
      () => toast.error(t("app.clipboard.copyFailed")),
    );
  const copyLink = (href: string): WorkspaceMenuItem => ({
    id: "target-copy-link",
    label: t("workspace.app.message.copyLink"),
    icon: <Link aria-hidden="true" />,
    onSelect: () => copyText(href, t("workspace.app.message.linkCopied")),
  });
  return (target) => {
    const act = actions() ?? {};
    switch (target.kind) {
      case "image": {
        const out: WorkspaceMenuItem[] = [
          {
            id: "target-copy-image",
            label: t("workspace.context.copyImage"),
            icon: <Copy aria-hidden="true" />,
            onSelect: () =>
              void copyImageToClipboard(target.src).then(
                () => toast.success(t("workspace.context.imageCopied")),
                () => toast.error(t("workspace.context.imageCopyFailed")),
              ),
          },
        ];
        if (target.attachmentId ? act.download : true) {
          const id = target.attachmentId;
          out.push({
            id: "target-save-image",
            label: t("workspace.context.saveImage"),
            icon: <Download aria-hidden="true" />,
            onSelect: () => (id ? act.download?.(id) : saveImageFromUrl(target.src, target.name)),
          });
        }
        if (target.open)
          out.push({
            id: "target-open",
            label: t("common.open"),
            icon: <ExternalLink aria-hidden="true" />,
            onSelect: target.open,
          });
        if (act.annotateImage)
          out.push({
            id: "target-annotate",
            label: t("workspace.context.annotate"),
            icon: <Highlighter aria-hidden="true" />,
            onSelect: () =>
              act.annotateImage?.({ attachmentId: target.attachmentId, src: target.src, name: target.name }),
          });
        if (isShareableUrl(target.src)) out.push(copyLink(target.src));
        return out;
      }
      case "file": {
        const out: WorkspaceMenuItem[] = [];
        if (act.openFile)
          out.push({
            id: "target-open",
            label: t("common.open"),
            icon: <ExternalLink aria-hidden="true" />,
            onSelect: () => act.openFile?.(target.attachmentId),
          });
        if (act.download)
          out.push({
            id: "target-download",
            label: t("common.download"),
            icon: <Download aria-hidden="true" />,
            onSelect: () => act.download?.(target.attachmentId),
          });
        return out;
      }
      case "link": {
        const out: WorkspaceMenuItem[] = [];
        if (act.openLink)
          out.push({
            id: "target-open",
            label: t("common.open"),
            icon: <ExternalLink aria-hidden="true" />,
            onSelect: () => act.openLink?.(target.href),
          });
        out.push(copyLink(target.href));
        return out;
      }
      case "code":
        return [
          {
            id: "target-copy-code",
            label: t("chat.code.copy"),
            icon: <Copy aria-hidden="true" />,
            onSelect: () => copyText(target.text, t("chat.code.copied")),
          },
        ];
      case "selection": {
        const out: WorkspaceMenuItem[] = [
          {
            id: "target-copy",
            label: t("common.copy"),
            icon: <Copy aria-hidden="true" />,
            onSelect: () => copyText(target.text, t("workspace.app.message.copied")),
          },
        ];
        if (act.quote)
          out.push({
            id: "target-quote",
            label: t("workspace.context.quote"),
            icon: <TextQuote aria-hidden="true" />,
            onSelect: () => act.quote?.(target.text),
          });
        return out;
      }
      case "member": {
        const out: WorkspaceMenuItem[] = [];
        if (target.open)
          out.push({
            id: "target-profile",
            label: t("workspace.context.viewProfile"),
            icon: <UserRound aria-hidden="true" />,
            onSelect: target.open,
          });
        if (act.directMessage)
          out.push({
            id: "target-dm",
            label: t("workspace.context.directMessage"),
            icon: <MessageCircle aria-hidden="true" />,
            onSelect: () => act.directMessage?.(),
          });
        return out;
      }
      default:
        return [];
    }
  };
}

/**
 * The target's items, then the message's under a divider. A message item that says the same as a
 * target item, such as "Copy link" under a link, is left out: the press was on the link.
 */
export function joinContextItems(
  targetItems: readonly WorkspaceMenuItem[],
  messageItems: readonly WorkspaceMenuItem[],
): WorkspaceMenuItem[] {
  if (targetItems.length === 0) return [...messageItems];
  const labels = new Set(targetItems.map((item) => item.label));
  const [first, ...rest] = messageItems.filter((item) => !labels.has(item.label));
  return first ? [...targetItems, { ...first, divider: true }, ...rest] : [...targetItems];
}
