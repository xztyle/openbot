/**
 * Markdown formats that the workspace composer puts around the selection, as Slack's formatting
 * toolbar does. The editor holds plain text with chat tags, so a format is text: `**bold**`,
 * `_italic_`, `~~strike~~`, `` `code` ``, `[text](url)`, list markers and `> ` at the start of lines,
 * and a ```` ``` ```` fence around a code block.
 */
export type ComposerTextFormat =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "bulleted-list"
  | "numbered-list"
  | "quote"
  | "code-block";

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
  if (format === "quote") return toggleQuote(value, start, end);
  if (format === "code-block") return codeBlock(value, start, end);
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

/** Puts `> ` before each line of the selection, or takes it off when every line has it. */
function toggleQuote(value: string, start: number, end: number): FormattedDraft {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const quoted = lines.every((line) => line.startsWith("> ") || line === ">");
  const block = lines.map((line) => (quoted ? line.replace(/^> ?/u, "") : `> ${line}`)).join("\n");
  const caret = lineStart + block.length;
  return {
    value: value.slice(0, lineStart) + block + value.slice(lineEnd),
    selection: start === end ? { start: caret, end: caret } : { start: lineStart, end: caret },
  };
}

/**
 * Puts a ```` ``` ```` fence on its own lines around the selection, or takes off the fence that is
 * around it. With no selection, an empty block opens with the caret inside.
 */
function codeBlock(value: string, start: number, end: number): FormattedDraft {
  const before = value.slice(0, start);
  const after = value.slice(end);
  if (before.endsWith("```\n") && after.startsWith("\n```")) {
    const open = start - 4;
    return {
      value: value.slice(0, open) + value.slice(start, end) + value.slice(end + 4),
      selection: { start: open, end: end - 4 },
    };
  }
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after && !after.startsWith("\n") ? "\n" : "";
  const opened = `${lead}\`\`\`\n`;
  return {
    value: `${before}${opened}${value.slice(start, end)}\n\`\`\`${trail}${after}`,
    selection: { start: start + opened.length, end: end + opened.length },
  };
}

/** Whether the caret at `offset` is inside an open ```` ``` ```` block, where Enter adds a line. */
export function insideCodeFence(value: string, offset: number): boolean {
  const before = value.slice(0, offset);
  return (before.match(/^```/gmu)?.length ?? 0) % 2 === 1;
}

/** The format that a key chord asks for, as Slack binds them, or null. */
export function composerFormatShortcut(event: KeyboardEvent, macLike: boolean): ComposerTextFormat | null {
  const mod = macLike ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  // Slack: the platform key with Alt, Shift and C makes a code block.
  if (event.altKey) return event.shiftKey && event.code === "KeyC" ? "code-block" : null;
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
    case "Digit9":
      return "quote";
    default:
      return null;
  }
}
