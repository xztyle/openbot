import { z } from "zod";

export const EMAIL_REPLY_TOOL = "email_reply";
export const EMAIL_SEND_TOOL = "email_send";
export const MAIL_TOOLS: ReadonlySet<string> = new Set([EMAIL_REPLY_TOOL, EMAIL_SEND_TOOL]);

const mailFormat = z
  .enum(["text", "markdown"])
  .optional()
  .describe(
    'How Atelier sends `text`. "markdown" sends a formatted mail that looks like a Motion page (headings, tables, lists, checklists, `> [!IMPORTANT]` callouts, a link alone on its line as a button) with a plain-text copy beside it. "text" sends it as written. Without it, Atelier sends Markdown when the text reads as Markdown.',
  );

export const emailReplyToolSchema = z.strictObject({
  threadId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('The mail thread from the message that brought the mail, such as "mt_3f9a…".'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe('The answer, in the customer\'s language: plain text, or Markdown with format "markdown".'),
  format: mailFormat,
});

export const emailSendToolSchema = z.strictObject({
  to: z.string().trim().min(3).max(254).describe("One address."),
  subject: z.string().trim().min(1).max(200),
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      'The mail: plain text, or Markdown with format "markdown". A report to a person is Markdown: the link to its Motion page alone on the first line, the decision in a `> [!IMPORTANT]` callout, tables over prose.',
    ),
  format: mailFormat,
  from: z
    .string()
    .trim()
    .max(254)
    .optional()
    .describe("Your address to send from, when you have more than one that may write first."),
});

export type EmailReplyCall = z.infer<typeof emailReplyToolSchema>;
export type EmailSendCall = z.infer<typeof emailSendToolSchema>;
export type MailToolCall =
  | { tool: "email_reply"; input: EmailReplyCall }
  | { tool: "email_send"; input: EmailSendCall };

/** What one call would send, before it runs. */
export interface MailCallPlan {
  from: string;
  to: string;
  subject: string;
  /** A first contact (`email_send` to someone new) that the owner has not approved yet: ask first. */
  needsApproval: boolean;
  /**
   * The address asks the owner for every mail (`ownerApprovesEverySend`): tier 2, so no manager
   * answers it and full access does not skip it. `needsApproval` is then true for every call.
   */
  ownerOnly: boolean;
}

/**
 * The agent mailboxes of the host (`src/main/agent-mail`), as the tool router uses them. `plan`
 * checks a call (the address, the mode, the rate limits, an opt-out) without sending; `send` checks
 * it again and sends. `approved` is true after the owner's OK for a first contact. `key` names the
 * tool call, so a retried call sends once.
 */
export interface AgentMailPort {
  plan(agentId: string, call: MailToolCall): { ok: true; plan: MailCallPlan } | { ok: false; message: string };
  send(
    agentId: string,
    call: MailToolCall,
    /** `approved` is the OK that `plan` asked for: the owner's, or for a first contact the manager's. */
    options: { approved: boolean; key: string },
  ): Promise<{ ok: true; result: Record<string, string> } | { ok: false; message: string }>;
}

/** How to write a mail that a person reads: shared by both tools and the tool guidance. */
export const MAIL_FORMAT_GUIDANCE = [
  'Short answers are plain text. A report, summary or update for a person (the owner or a teammate) is Markdown with format "markdown": Atelier sends it formatted like a Motion page, with a plain-text copy.',
  "Shape a report so it reads in one screen: the link to its Motion page alone on the first line (it shows as a button at the top), then the decision first in a `> [!IMPORTANT]` callout (what you need from the reader and by when), the key numbers as a small table, decisions as a numbered list with a deadline each, open steps as a `- [ ]` checklist, and what is done as a short table. Prefer tables to prose.",
  "Plain business language: no IDs, codes, file names, field names or jargon; write out abbreviations. No images and no raw HTML: they are removed.",
].join(" ");

export const MAIL_TOOL_DEFINITIONS = [
  {
    name: EMAIL_REPLY_TOOL,
    description: [
      "Answer a mail that came to your mail address, as that address, in the same mail thread. Pass the threadId from the message that brought the mail.",
      "Write like a person on the team: short, in the customer's language, no signature block of secrets or prices you were not given. Never promise refunds, money or anything only the owner decides: ask the owner first.",
      MAIL_FORMAT_GUIDANCE,
      "It sends at once, with no approval. Atelier limits how many mails you send an hour and a day.",
      'The result is JSON {"status":"sent","to","subject","messageId"}.',
    ].join(" "),
    shape: emailReplyToolSchema.shape,
  },
  {
    name: EMAIL_SEND_TOOL,
    description: [
      "Write a new mail to someone who has not written to you, from your mail address. It works only from an address that the owner set to may write first; otherwise answer mail with email_reply.",
      "The first mail to each new person waits for the owner's OK in Needs you, and Atelier adds a line on how to opt out. Never write to someone who opted out. Keep it short and personal: no bulk mail.",
      MAIL_FORMAT_GUIDANCE,
      'The result is JSON {"status":"sent","to","subject","threadId","messageId"}.',
    ].join(" "),
    shape: emailSendToolSchema.shape,
  },
];

/** The call of a mail tool with valid arguments, or a message that says what to correct. */
export function parseMailToolCall(tool: string, input: unknown): MailToolCall | { error: string } {
  if (tool === EMAIL_REPLY_TOOL) {
    const parsed = emailReplyToolSchema.safeParse(input);
    return parsed.success ? { tool, input: parsed.data } : { error: z.prettifyError(parsed.error) };
  }
  if (tool === EMAIL_SEND_TOOL) {
    const parsed = emailSendToolSchema.safeParse(input);
    return parsed.success ? { tool, input: parsed.data } : { error: z.prettifyError(parsed.error) };
  }
  return { error: `${tool} is not a mail tool.` };
}
