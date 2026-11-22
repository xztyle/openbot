import { describe, expect, it } from "vitest";
import { impactOf, untrustedNote } from "../guardrails/injection-guard";
import { MAIL_TOOL_DEFINITIONS, parseMailToolCall } from "./mail-tools";

describe("mail tools", () => {
  it("are the reply and the first mail", () => {
    expect(MAIL_TOOL_DEFINITIONS.map((definition) => definition.name)).toEqual(["email_reply", "email_send"]);
  });

  it("parse a call and name what to correct", () => {
    expect(parseMailToolCall("email_reply", { threadId: "mt_1", text: " Hola " })).toEqual({
      tool: "email_reply",
      input: { threadId: "mt_1", text: "Hola" },
    });
    expect(parseMailToolCall("email_send", { to: "a@b.co", subject: "Hi" })).toHaveProperty("error");
    expect(parseMailToolCall("email_reply", { threadId: "mt_1", text: "x", cc: "x@y.z" })).toHaveProperty("error");
  });

  it("count as a send for the injection monitor", () => {
    expect(impactOf("openbot.email_reply", { threadId: "mt_1", text: "x" }, null)).toMatchObject({ kind: "send" });
    expect(impactOf("openbot.email_send", { to: "a@b.co" }, null)).toMatchObject({ kind: "send" });
    expect(untrustedNote("email")).toContain("an email");
  });
});
