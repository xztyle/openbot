import { decodeInboundMail, signAgentMail, verifyAgentMail } from "@openbot/contracts/agent-mail";
import { describe, expect, it, vi } from "vitest";
import { authVerdicts, cleanBody, htmlToText, inboundMail } from "./inbound";
import { type Env, handleSend, type IncomingMail, outboundHeaders, receiveMail } from "./index";

const SECRET = "test-mail-secret-0123456789abcdef";

function raw(lines: string[]): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(lines.join("\r\n"));
}

const HTML_MAIL = [
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.org; spf=softfail smtp.mailfrom=example.org; dmarc=pass",
  "Authentication-Results: evil.example; spf=pass; dkim=pass",
  'From: "Ana López" <Ana@Example.org>',
  "To: ventas@aprendivo.com",
  "Subject: =?UTF-8?Q?Pregunta_sobre_el_curso?=",
  "Message-ID: <abc123@example.org>",
  "In-Reply-To: <first@aprendivo.com>",
  "References: <root@example.org> <first@aprendivo.com>",
  "MIME-Version: 1.0",
  'Content-Type: text/html; charset="utf-8"',
  "",
  '<html><head><style>p{color:red}</style></head><body><p>Hola,&nbsp;¿el curso <b>incluye</b> certificado?</p><img src="https://tracker.example/p.gif"><p><a href="https://evil.example/x">mi web</a></p><script>alert(1)</script></body></html>',
];

function incoming(bytes: Uint8Array<ArrayBuffer>, to = "ventas@aprendivo.com") {
  const rejected: string[] = [];
  const message: IncomingMail = {
    from: "bounce@example.org",
    to,
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    setReject: (reason) => rejected.push(reason),
  };
  return { message, rejected };
}

function env(send: Env["EMAIL"]["send"] = vi.fn(async () => ({ messageId: "cf-1" }))): Env {
  return {
    HOST_INBOX_URL: "https://connect.example.com/hooks/mail_route",
    MAIL_SECRET: SECRET,
    SENDER_DOMAINS: "aprendivo.com, delynith.com",
    EMAIL: { send },
  };
}

describe("inbound parsing", () => {
  it("reads only Cloudflare's own verdicts", () => {
    expect(
      authVerdicts([{ key: "authentication-results", value: "mx.cloudflare.net; spf=pass; dkim=fail; dmarc=none" }]),
    ).toEqual({ spf: "pass", dkim: "fail", dmarc: "none" });
    expect(authVerdicts([{ key: "authentication-results", value: "evil.example; spf=pass; dkim=pass" }])).toEqual({
      spf: "none",
      dkim: "none",
      dmarc: "none",
    });
  });

  it("turns HTML into text without images, scripts or link targets", () => {
    const text = htmlToText(
      '<p>Hi</p><img src="https://x/y.png"><a href="https://evil.example">here</a><script>steal()</script>',
    );
    expect(text).toContain("Hi");
    expect(text).toContain("here");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("y.png");
    expect(text).not.toContain("steal");
  });

  it("drops hidden characters and caps the text", () => {
    expect(cleanBody("a​b‮c").text).toBe("abc");
    const long = cleanBody("x".repeat(30_000));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(24_000);
  });

  it("parses a message into the host's shape", async () => {
    const mail = await inboundMail(raw(HTML_MAIL), { from: "bounce@example.org", to: "Ventas@Aprendivo.com" });
    expect(mail).not.toBeNull();
    expect(mail?.to).toBe("ventas@aprendivo.com");
    expect(mail?.from).toEqual({ address: "ana@example.org", name: "Ana López" });
    expect(mail?.subject).toBe("Pregunta sobre el curso");
    expect(mail?.messageId).toBe("abc123@example.org");
    expect(mail?.inReplyTo).toBe("first@aprendivo.com");
    expect(mail?.references).toEqual(["root@example.org", "first@aprendivo.com"]);
    expect(mail?.auth).toEqual({ spf: "softfail", dkim: "pass", dmarc: "pass" });
    expect(mail?.text).toContain("¿el curso incluye certificado?");
    expect(mail?.text).not.toContain("tracker.example");
    expect(mail?.automated).toBe(false);
    // The host decodes what the Worker posts without losing a field.
    expect(decodeInboundMail(JSON.parse(JSON.stringify(mail)))).toEqual(mail);
  });

  it("marks an out-of-office answer as automated and makes up a stable id when there is none", async () => {
    const lines = ["From: a@example.org", "To: ventas@aprendivo.com", "Auto-Submitted: auto-replied", "", "Away"];
    const first = await inboundMail(raw(lines), { from: "a@example.org", to: "ventas@aprendivo.com" });
    const second = await inboundMail(raw(lines), { from: "a@example.org", to: "ventas@aprendivo.com" });
    expect(first?.automated).toBe(true);
    expect(first?.messageId).toMatch(/^generated\.[0-9a-f]{32}@aprendivo\.com$/u);
    expect(second?.messageId).toBe(first?.messageId);
  });
});

describe("receiveMail", () => {
  it("posts the message signed to the host and keeps it on 202", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 202 }),
    );
    const { message, rejected } = incoming(raw(HTML_MAIL));
    await receiveMail(message, env(), fetcher);
    expect(rejected).toEqual([]);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://connect.example.com/hooks/mail_route");
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    expect(await verifyAgentMail(SECRET, (name) => headers.get(name), body)).toBe(true);
    expect(headers.get("x-openbot-delivery-id")).toMatch(/^mail_[0-9a-f]{32}$/u);
  });

  it("bounces when the host refuses or is down", async () => {
    const refused = incoming(raw(HTML_MAIL));
    await receiveMail(refused.message, env(), async () => new Response("{}", { status: 404 }));
    expect(refused.rejected).toEqual(["No mailbox has this address."]);
    const down = incoming(raw(HTML_MAIL));
    await receiveMail(down.message, env(), async () => {
      throw new Error("offline");
    });
    expect(down.rejected[0]).toContain("unavailable");
  });

  it("bounces a message over the size cap without reading it", async () => {
    const fetcher = vi.fn();
    const { message, rejected } = incoming(raw(HTML_MAIL));
    await receiveMail({ ...message, rawSize: 2 * 1024 * 1024 }, env(), fetcher);
    expect(rejected[0]).toContain("larger");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("handleSend", () => {
  const mail = {
    version: 1,
    from: { address: "ventas@aprendivo.com", name: "Lucía (Aprendivo)" },
    to: "ana@example.org",
    subject: "Re: Pregunta sobre el curso",
    text: "Sí, incluye certificado.",
    inReplyTo: "abc123@example.org",
    references: ["root@example.org"],
    listUnsubscribe: null,
  };

  async function request(value: unknown, secret = SECRET) {
    const body = JSON.stringify(value);
    return new Request("https://atelier-mail.example.workers.dev/send", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await signAgentMail(secret, "send_1", body)) },
      body,
    });
  }

  it("sends a signed reply with threading headers", async () => {
    const send = vi.fn(async () => ({ messageId: "cf-42" }));
    const response = await handleSend(await request(mail), env(send));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: "cf-42" });
    expect(send).toHaveBeenCalledWith({
      to: "ana@example.org",
      from: { email: "ventas@aprendivo.com", name: "Lucía (Aprendivo)" },
      subject: "Re: Pregunta sobre el curso",
      text: "Sí, incluye certificado.",
      headers: {
        "In-Reply-To": "<abc123@example.org>",
        References: "<root@example.org> <abc123@example.org>",
        "X-Atelier-Agent-Mail": "1",
      },
    });
  });

  it("refuses a bad signature and a sender domain it does not serve", async () => {
    const send = vi.fn();
    expect((await handleSend(await request(mail, "wrong-secret"), env(send))).status).toBe(401);
    const other = { ...mail, from: { address: "boss@bank.example", name: null } };
    expect((await handleSend(await request(other), env(send))).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 502 with Cloudflare's code when the send fails", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("no"), { code: "E_SENDER_NOT_VERIFIED" });
    });
    const response = await handleSend(await request(mail), env(send));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "E_SENDER_NOT_VERIFIED" });
  });

  it("adds List-Unsubscribe to a first-contact mail", () => {
    expect(
      outboundHeaders({
        ...mail,
        version: 1,
        inReplyTo: null,
        references: [],
        listUnsubscribe: "<mailto:ventas@aprendivo.com?subject=unsubscribe>",
      }),
    ).toEqual({ "List-Unsubscribe": "<mailto:ventas@aprendivo.com?subject=unsubscribe>", "X-Atelier-Agent-Mail": "1" });
  });
});
