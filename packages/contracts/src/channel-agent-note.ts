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

/** A greeting before the name that a message opens with: "Hola Alejandro, …". */
const GREETING = /^(?:hola|hi|hello|hey|buenas|bonjour|salut|hallo|ciao|olá|oi|привет)[\s,!]+/iu;
/** The name a message opens with, before a comma or a colon: "Alejandro, …", "Ana María: …". */
const VOCATIVE = /^([\p{Lu}][\p{L}\p{M}'’-]*(?: [\p{Lu}][\p{L}\p{M}'’-]*){0,2})\s*([,:])/u;

/**
 * Whether an agent's message opens by speaking to a person of the channel: a mention of a person,
 * or a name that is not an agent's, such as "Alejandro, rehice el copy…". `people` are the names of
 * the people; `briefs` are the texts the agent was given, which name the people as the team calls
 * them ("Alejandro dijo…"), so a name found there counts too when a comma follows it.
 */
export function addressesPerson(
  text: string,
  names: { people: readonly string[]; agents: readonly string[]; briefs?: readonly string[] },
): boolean {
  const start = text.trimStart().slice(0, 400);
  if (/^@\[[^\]\r\n]+\]\(member:/u.test(start)) return true;
  if (start.startsWith("@[")) return false;
  const match = VOCATIVE.exec(start.replace(GREETING, ""));
  const name = match?.[1];
  if (!name) return false;
  const lower = name.toLocaleLowerCase();
  const firstWord = (full: string) => full.trim().split(/\s+/u)[0]?.toLocaleLowerCase() ?? "";
  if (names.agents.some((agent) => agent.trim().toLocaleLowerCase() === lower || firstWord(agent) === lower))
    return false;
  if (names.people.some((person) => person.trim().toLocaleLowerCase() === lower || firstWord(person) === lower))
    return true;
  if (match[2] !== ",") return false;
  const word = new RegExp(`(?<![\\p{L}\\p{M}])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{M}])`, "u");
  return (names.briefs ?? []).some((brief) => word.test(brief));
}
