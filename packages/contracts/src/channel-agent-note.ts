import { markdownPreviewText } from "./markdown-preview-text";

/** How long a summary that Atelier writes from the text may be, as Slack's one-line previews. */
export const CHANNEL_AGENT_NOTE_LINE_LIMIT = 120;

/**
 * One line of a message between agents for the people of a channel: its first sentence as plain
 * text, without the names it starts with (`Designer: …`, `@[Designer](agent:…) …`), ellipsized at a
 * word. No model writes it, so it costs nothing.
 */
export function channelAgentNoteLine(
  text: string,
  recipientNames: readonly string[] = [],
  limit = CHANNEL_AGENT_NOTE_LINE_LIMIT,
): string {
  let plain = markdownPreviewText(text.slice(0, 4_000));
  // The names it is addressed to: the line shows the faces of the recipients instead.
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of recipientNames) {
      for (const prefix of [`@${name}`, name]) {
        if (!name || !plain.startsWith(prefix)) continue;
        const rest = plain.slice(prefix.length).replace(/^\s*[:,–—-]?\s*/u, "");
        if (rest !== plain) {
          plain = rest;
          changed = true;
        }
      }
    }
  }
  const sentence = /^.+?[.!?…](?=\s|$)/u.exec(plain)?.[0] ?? plain;
  return clip(sentence.trim(), limit);
}

/** A summary that an agent gave, as one line within the limit; empty when it gave none. */
export function givenAgentNoteLine(summary: unknown, limit = 240): string {
  if (typeof summary !== "string") return "";
  return clip(markdownPreviewText(summary.slice(0, 2_000)).trim(), limit);
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
