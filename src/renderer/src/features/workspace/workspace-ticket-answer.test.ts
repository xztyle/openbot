import { translateFor } from "@openbot/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerTicket, ticketAnswers } from "./workspace-ticket-answer";

// Failure mode: Approve on a Motion ticket in the browser client says "could not send" and the agent
// never hears it, because the answer went through the desktop's preload, which the browser has none of.
const item = { agentId: "agent-1", requestId: "motion:issue-1" };

describe("answerTicket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends through the channels port with no desktop preload, then answers the ticket", async () => {
    vi.stubGlobal("openbot", undefined);
    const sendAgentMessage = vi.fn(async () => undefined);
    const respondToPrompt = vi.fn(async () => undefined);
    const result = await answerTicket({ sendAgentMessage, agent: { respondToPrompt } }, item, "msg", "ok");
    expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-1", text: "msg" }));
    expect(respondToPrompt).toHaveBeenCalledWith({ requestId: "motion:issue-1", answers: { answer: ["ok"] } });
    expect(result).toEqual({ commented: true });
  });

  it("throws the host's reason when the message fails, and keeps the ticket", async () => {
    const respondToPrompt = vi.fn(async () => undefined);
    const sendAgentMessage = vi.fn(async () => {
      throw new Error("The host is offline.");
    });
    await expect(answerTicket({ sendAgentMessage, agent: { respondToPrompt } }, item, "m", "ok")).rejects.toThrow(
      "The host is offline.",
    );
    expect(respondToPrompt).not.toHaveBeenCalled();
  });

  it("reports a missing comment without failing the answer", async () => {
    const respondToPrompt = vi.fn(async () => {
      throw new Error("Motion is down");
    });
    const result = await answerTicket(
      { sendAgentMessage: async () => undefined, agent: { respondToPrompt } },
      item,
      "m",
      "ok",
    );
    expect(result).toEqual({ commented: false });
  });
});

describe("ticketAnswers", () => {
  const t = translateFor("en");

  it("offers a sign-in button, not Approve and Decline, when the ticket asks for a sign-in", () => {
    const answers = ticketAnswers({ asks: "approval", signIn: { site: "Hotmart", url: "https://sso.hotmart.com" } }, t);
    expect(answers.primary?.label).toBe("Sign in to Hotmart");
    expect(answers.primary?.answer).toContain("https://sso.hotmart.com");
    expect(answers.primary?.decision).toBeUndefined();
    expect(answers.secondary).toBeUndefined();
    expect(ticketAnswers({ asks: "approval" }, t).primary?.decision).toBe("approve");
  });
});
