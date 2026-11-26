/*
 * The conversation's icons, by their role, so a call site names what it means and the set stays
 * one: every glyph here is a Lucide icon from `../../icons`, at the size of its place. The classes
 * that feature stylesheets size (`message-link-fallback`, `browser-toolbar-icon`, ...) stay on
 * the icon, so the rules that dress them hold.
 */
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownRight,
  Download,
  Link,
  ListEnd,
  Monitor,
  MousePointer2,
  Pencil,
  Plus,
  Reply,
  RotateCw,
  ScreenShare,
  SmilePlus,
  Square,
  Trash2,
  X,
} from "../../icons";

export function CloseIcon() {
  return <X aria-hidden="true" class="ui-icon-sm" />;
}

export function DownloadIcon() {
  return <Download aria-hidden="true" class="image-generation-download-icon" />;
}

/** Stop: a filled square, as on a player. */
export function StopIcon() {
  return <Square aria-hidden="true" class="ui-icon-sm fill-current" />;
}

export function PlusIcon() {
  return <Plus aria-hidden="true" class="ui-icon-sm" />;
}

export function LinkIcon() {
  return <Link aria-hidden="true" class="message-link-fallback" />;
}

export function ReactionIcon() {
  return <SmilePlus aria-hidden="true" />;
}

export function ReplyIcon() {
  return <Reply aria-hidden="true" />;
}

/** Send after the current turn: the end of the list. */
export function QueueIcon() {
  return <ListEnd aria-hidden="true" />;
}

export function TrashIcon() {
  return <Trash2 aria-hidden="true" />;
}

export function EditIcon() {
  return <Pencil aria-hidden="true" />;
}

/** Steer the running turn: a turn into the current line. */
export function SteerIcon() {
  return <CornerDownRight aria-hidden="true" />;
}

export function CopyIcon() {
  return <Copy aria-hidden="true" />;
}

export function CheckIcon() {
  return <Check aria-hidden="true" />;
}

export function ComputerIcon() {
  return <Monitor aria-hidden="true" class="ui-icon-sm" />;
}

export function RemoteDesktopIcon() {
  return <ScreenShare aria-hidden="true" class="ui-icon-sm" />;
}

/** The agent holds this browser tab: a pointer. */
export function BrowserControlIcon() {
  return <MousePointer2 aria-hidden="true" class="browser-tab-control-icon" />;
}

export function BrowserBackIcon() {
  return <ChevronLeft aria-hidden="true" class="browser-toolbar-icon" />;
}

export function BrowserForwardIcon() {
  return <ChevronRight aria-hidden="true" class="browser-toolbar-icon" />;
}

export function BrowserStopIcon() {
  return <X aria-hidden="true" class="browser-toolbar-icon" />;
}

export function BrowserReloadIcon() {
  return <RotateCw aria-hidden="true" class="browser-toolbar-icon" />;
}
