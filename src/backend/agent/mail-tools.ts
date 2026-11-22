import { z } from "zod";

export const EMAIL_REPLY_TOOL = "email_reply";
export const EMAIL_SEND_TOOL = "email_send";
export const MAIL_TOOLS: ReadonlySet<string> = new Set([EMAIL_REPLY_TOOL, EMAIL_SEND_TOOL]);

export const emailReplyToolSchema = z.strictObject({
  threadId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('The mail thread from the message that brought the mail, such as "mt_3f9a…".'),
  text: z.string().trim().min(1).max(20_000).describe("The answer, in plain text, in the customer's language."),
});

export const emailSendToolSchema = z.strictObject({
  to: z.string().trim().min(3).max(254).describe("One address."),
  subject: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000).describe("The mail, in plain text."),
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
    options: { approved: boolean; key: string },
  ): Promise<{ ok: true; result: Record<string, string> } | { ok: false; message: string }>;
}

export const MAIL_TOOL_DEFINITIONS = [
  {
    name: EMAIL_REPLY_TOOL,
    description: [
      "Answer a mail that came to your mail address, as that address, in the same mail thread. Pass the threadId from the message that brought the mail.",
      "Write plain text like a person on the team: short, in the customer's language, no signature block of secrets or prices you were not given. Never promise refunds, money or anything only the owner decides: ask the owner first.",
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
