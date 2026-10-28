/**
 * Markdown formats that the workspace composer puts around the selection, as Slack's formatting
 * toolbar does. The editor holds plain text with chat tags, so a format is text: `**bold**`,
 * `_italic_`, `~~strike~~`, `` `code` ``, `[text](url)`, and list markers at the start of lines.
 */
export type ComposerTextFormat = "bold" | "italic" | "strike" | "code" | "link" | "bulleted-list" | "numbered-list";

export interface ComposerTextRange {
  start: number;
  end: number;
}

export interface FormattedDraft {
  value: string;
  selection: ComposerTextRange;
}

const WRAPS = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
} as const satisfies Partial<Record<ComposerTextFormat, readonly [string, string]>>;

const URL_TEXT = /^https?:\/\/\S+$/u;

/** The draft after `format` is applied to `selection`. A second press of a wrap takes it off again. */
export function applyComposerFormat(
  value: string,
  selection: ComposerTextRange,
  format: ComposerTextFormat,
): FormattedDraft {
  const start = Math.max(0, Math.min(selection.start, selection.end, value.length));
  const end = Math.min(value.length, Math.max(selection.start, selection.end));
  if (format === "bulleted-list" || format === "numbered-list") return toggleList(value, start, end, format);
  if (format === "link") return link(value, start, end);
  const selected = value.slice(start, end);
  if (format === "code" && selected.includes("\n")) return wrap(value, start, end, "```\n", "\n```");
  const [before, after] = WRAPS[format];
  return wrap(value, start, end, before, after);
}

function wrap(value: string, start: number, end: number, before: string, after: string): FormattedDraft {
  // Already wrapped, inside or around the selection: take the markers off.
  if (value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after)
    return {
      value: value.slice(0, start - before.length) + value.slice(start, end) + value.slice(end + after.length),
      selection: { start: start - before.length, end: end - before.length },
    };
  const selected = value.slice(start, end);
  if (selected.length >= before.length + after.length && selected.startsWith(before) && selected.endsWith(after))
    return {
      value: value.slice(0, start) + selected.slice(before.length, selected.length - after.length) + value.slice(end),
      selection: { start, end: end - before.length - after.length },
    };
  return {
    value: value.slice(0, start) + before + selected + after + value.slice(end),
    selection: { start: start + before.length, end: end + before.length },
  };
}

function link(value: string, start: number, end: number): FormattedDraft {
  const selected = value.slice(start, end);
  if (URL_TEXT.test(selected)) {
    // A selected address becomes the target; the caret goes where its text belongs.
    const next = `${value.slice(0, start)}[](${selected})${value.slice(end)}`;
    return { value: next, selection: { start: start + 1, end: start + 1 } };
  }
  const next = `${value.slice(0, start)}[${selected}]()${value.slice(end)}`;
  const caret = start + selected.length + 3;
  return { value: next, selection: { start: caret, end: caret } };
}

function toggleList(
  value: string,
  start: number,
  end: number,
  format: "bulleted-list" | "numbered-list",
): FormattedDraft {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const marker = format === "bulleted-list" ? /^[-*•] / : /^\d+\. /;
  const listed = lines.every((line) => marker.test(line));
  const next = listed
    ? lines.map((line) => line.replace(marker, ""))
    : lines.map((line, index) =>
        format === "bulleted-list"
          ? `- ${line.replace(/^\d+\. |^[-*•] /, "")}`
          : `${index + 1}. ${line.replace(/^\d+\. |^[-*•] /, "")}`,
      );
  const block = next.join("\n");
  const result = value.slice(0, lineStart) + block + value.slice(lineEnd);
  const caret = lineStart + block.length;
  return {
    value: result,
    selection: start === end ? { start: caret, end: caret } : { start: lineStart, end: caret },
  };
}

/** The format that a key chord asks for, as Slack binds them, or null. */
export function composerFormatShortcut(event: KeyboardEvent, macLike: boolean): ComposerTextFormat | null {
  const mod = macLike ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  if (!event.shiftKey) {
    if (event.code === "KeyB") return "bold";
    if (event.code === "KeyI") return "italic";
    return null;
  }
  switch (event.code) {
    case "KeyX":
      return "strike";
    case "KeyC":
      return "code";
    case "KeyU":
      return "link";
    case "Digit8":
      return "bulleted-list";
    case "Digit7":
      return "numbered-list";
    default:
      return null;
  }
}
