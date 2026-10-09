import { redactText } from "@openbot/logging";

/**
 * The most reasoning text one thinking item keeps, in characters. A model can think for pages, and
 * the item is stored with the conversation and sent to every client of the host, so it needs a bound.
 * The limit is generous: it is the user's view of what the model did, not a preview.
 */
export const REASONING_TEXT_LIMIT = 40_000;

/** The mark where a long item was cut. Symbols only, so it needs no translation. */
const CUT_MARK = "\n\n[…]";

/**
 * The text of a thinking item as OpenBot keeps and shows it: redacted, then cut at the limit.
 *
 * A model quotes what it read, so its reasoning can hold a key or a token from a file or a command.
 * The conversation reaches the web client, the phone and other members of a joined server, so the
 * text is redacted once, here, before it is stored. The redaction runs before the cut, so a token
 * that straddles the limit is masked and not left as a stub. Streamed pieces arrive before the
 * item completes and are not redacted one by one: a secret can split across two pieces. The
 * completed item replaces them with this text.
 */
export function boundedReasoningText(text: string): string {
  const redacted = redactText(text);
  return redacted.length > REASONING_TEXT_LIMIT ? `${redacted.slice(0, REASONING_TEXT_LIMIT)}${CUT_MARK}` : redacted;
}
