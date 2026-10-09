import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadWatcherCatalog } from "../build-watcher-catalog";

const sourceRoot = fileURLToPath(new URL("../../marketplace/watcher-catalog", import.meta.url));

interface Template {
  slug: string;
  variable: string;
  defaults: { host: string; port: string; security: string };
}
const templates: Template[] = [
  {
    slug: "gmail-inbox",
    variable: "GMAIL_APP_PASSWORD",
    defaults: { host: "imap.gmail.com", port: "993", security: "tls" },
  },
  {
    slug: "protonmail-inbox",
    variable: "PROTONMAIL_BRIDGE_PASSWORD",
    defaults: { host: "127.0.0.1", port: "1143", security: "starttls" },
  },
];
const programPath = (slug: string) => join(sourceRoot, "watchers", slug, "program.mjs");

interface MailItem {
  id: string;
  revision: string;
  actor: string;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  messageId: string;
  unread: boolean;
  preview: string;
}
interface MailResult {
  items: MailItem[];
  hasNextPage: boolean;
  cursor: string | null;
}
interface Program {
  runWatcher(
    input: Record<string, string> | string[],
    deps?: { password?: string; now?: () => number; timeoutMs?: number },
  ): Promise<MailResult>;
  allowsSelfSigned(host: string): boolean;
  senderAddress(raw: string): string;
  decodeWords(value: string): string;
}
async function loadProgram(slug: string): Promise<Program> {
  return await import(pathToFileURL(programPath(slug)).href);
}

// ---------------------------------------------------------------------------------------------
// A small IMAP server. It answers like a real one for the commands the program may send.
// ---------------------------------------------------------------------------------------------

interface FakeMessage {
  uid: number;
  flags: string[];
  internalDate: string;
  header: string;
  text: string;
}
interface FakeOptions {
  user?: string;
  pass?: string;
  uidValidity?: number;
  messages?: FakeMessage[];
  /** When set, the server upgrades after STARTTLS with this certificate. */
  certificate?: { key: string; cert: string };
  /** Never greets, so the client has to give up. */
  silent?: boolean;
  /** The first line the server sends. */
  greeting?: string;
  /** Replaces the whole answer to a command. Return raw bytes, including the tagged line. */
  respond?: (verb: string, tag: string, rest: string) => string | undefined;
}

const CRLF = "\r\n";
function header(from: string, subject: string, extra = ""): string {
  return `From: ${from}${CRLF}To: me@example.com${CRLF}Subject: ${subject}${CRLF}Date: Fri, 17 Jul 2026 02:44:25 -0700${CRLF}Message-ID: <id@example.com>${CRLF}${extra}${CRLF}`;
}
function message(uid: number, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    uid,
    flags: [],
    internalDate: "17-Jul-2026 02:44:25 -0700",
    header: header("Ana <ana@example.com>", `Mail ${uid}`),
    text: `Body of mail ${uid}${CRLF}`,
    ...overrides,
  };
}

class FakeImap {
  readonly commands: string[] = [];
  connections = 0;
  readonly #server: net.Server;
  readonly #sockets = new Set<net.Socket>();
  constructor(readonly options: FakeOptions = {}) {
    this.#server = net.createServer((socket) => {
      this.connections += 1;
      this.#sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => this.#sockets.delete(socket));
      if (!options.silent) socket.write(`${options.greeting ?? "* OK IMAP4rev1 ready"}${CRLF}`);
      this.#serve(socket, socket);
    });
  }
  async start(host = "127.0.0.1"): Promise<number> {
    await new Promise<void>((resolve) => this.#server.listen(0, host, resolve));
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("The fake server has no port.");
    return address.port;
  }
  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
  get verbs(): string[] {
    return this.commands.map((line) => /^\S+ (UID \S+|\S+)/.exec(line)?.[1]?.toUpperCase() ?? "");
  }
  commandsStartingWith(prefix: string): string[] {
    return this.commands.filter((line) => line.split(" ").slice(1).join(" ").toUpperCase().startsWith(prefix));
  }
  #serve(raw: net.Socket, stream: net.Socket | tls.TLSSocket): void {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        const end = buffer.indexOf(CRLF);
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (this.#handle(stream, line)) {
          // STARTTLS: from here on the client speaks TLS on the same connection.
          const certificate = this.options.certificate;
          if (!certificate) return;
          stream.removeAllListeners("data");
          const secure = new tls.TLSSocket(raw, { isServer: true, key: certificate.key, cert: certificate.cert });
          secure.on("error", () => {});
          this.#serve(raw, secure);
          return;
        }
      }
    });
  }
  /** Answers true when the connection must now switch to TLS. */
  #handle(stream: net.Socket | tls.TLSSocket, line: string): boolean {
    this.commands.push(line);
    const [tag = "", verb = "", ...rest] = line.split(" ");
    const upper = verb.toUpperCase();
    const args = rest.join(" ");
    const custom = this.options.respond?.(upper === "UID" ? `UID ${(rest[0] ?? "").toUpperCase()}` : upper, tag, args);
    if (custom !== undefined) {
      stream.write(custom);
      return false;
    }
    const messages = this.options.messages ?? [];
    switch (upper) {
      case "CAPABILITY":
        stream.write(`* CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN${CRLF}${tag} OK done${CRLF}`);
        return false;
      case "STARTTLS":
        stream.write(`${tag} OK Begin TLS${CRLF}`);
        return this.options.certificate !== undefined;
      case "LOGIN": {
        const [user, pass] = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
          (m[1] ?? "").replace(/\\(.)/g, "$1"),
        );
        if (user === (this.options.user ?? "me@example.com") && pass === (this.options.pass ?? "app-secret-1"))
          stream.write(`${tag} OK logged in${CRLF}`);
        else stream.write(`${tag} NO [AUTHENTICATIONFAILED] SERVER-SECRET-TEXT rejected${CRLF}`);
        return false;
      }
      case "EXAMINE":
        stream.write(
          `* ${messages.length} EXISTS${CRLF}* OK [UIDVALIDITY ${this.options.uidValidity ?? 7}] ok${CRLF}${tag} OK [READ-ONLY] done${CRLF}`,
        );
        return false;
      case "UID": {
        const sub = (rest[0] ?? "").toUpperCase();
        if (sub === "SEARCH") {
          const unseen = args.toUpperCase().includes(" UNSEEN ");
          const uids = messages.filter((m) => !unseen || !m.flags.includes("\\Seen")).map((m) => m.uid);
          stream.write(`* SEARCH${uids.map((uid) => ` ${uid}`).join("")}${CRLF}${tag} OK done${CRLF}`);
        } else if (sub === "FETCH") {
          const wanted = new Set((rest[1] ?? "").split(",").map(Number));
          messages.forEach((m, index) => {
            if (!wanted.has(m.uid)) return;
            const head = Buffer.from(m.header, "utf8");
            const text = Buffer.from(m.text, "utf8").subarray(0, 400);
            stream.write(
              Buffer.concat([
                Buffer.from(
                  `* ${index + 1} FETCH (UID ${m.uid} FLAGS (${m.flags.join(" ")}) INTERNALDATE "${m.internalDate}" BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] {${head.length}}${CRLF}`,
                ),
                head,
                Buffer.from(` BODY[TEXT]<0> {${text.length}}${CRLF}`),
                text,
                Buffer.from(`)${CRLF}`),
              ]),
            );
          });
          stream.write(`${tag} OK done${CRLF}`);
        } else stream.write(`${tag} BAD unknown${CRLF}`);
        return false;
      }
      case "LOGOUT":
        stream.write(`* BYE bye${CRLF}${tag} OK logout${CRLF}`);
        stream.end();
        return false;
      default:
        stream.write(`${tag} BAD unknown${CRLF}`);
        return false;
    }
  }
}

const servers: FakeImap[] = [];
const temporaryRoots: string[] = [];
async function serve(options: FakeOptions = {}, host?: string): Promise<{ server: FakeImap; port: string }> {
  const server = new FakeImap(options);
  servers.push(server);
  return { server, port: String(await server.start(host)) };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PASSWORD = "app-secret-1";
function configuration(port: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: "127.0.0.1",
    port,
    security: "none",
    username: "me@example.com",
    mailbox: "INBOX",
    unseenOnly: "false",
    maxMessages: "50",
    notifyOnFlagChange: "false",
    since: "2026-07-17T10:00:00.000Z",
    ...extra,
  };
}
const now = () => Date.parse("2026-07-17T10:05:00.000Z");
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}
function spawnProgram(slug: string, input: string, environment: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [programPath(slug)], {
      env: { PATH: process.env.PATH ?? "", ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe.each(templates)("$slug program", (template) => {
  let program: Program;
  beforeAll(async () => {
    program = await loadProgram(template.slug);
  });

  it("turns messages into items with a decoded subject and the real sender as actor", async () => {
    const { server, port } = await serve({
      messages: [
        message(101, {
          flags: ["\\Seen"],
          header: header(
            `=?UTF-8?B?${base64("Ana Pérez")}?= <Ana.Perez@Example.COM>`,
            "=?UTF-8?Q?Price_=E2=82?=\r\n =?UTF-8?Q?=AC5?= review‮",
            `X-Other: skipped${CRLF}`,
          ),
          text: `Hello Ana,${CRLF}Please read.${CRLF}`,
        }),
        message(102, {
          header: header('"Boss <boss@corp.example>" <mallory@bad.example>', `=?UTF-8?B?${base64("Réunion demain")}?=`),
        }),
        message(103, { header: header("Ann <ann@example.com>, Bob <bob@example.com>", "Two senders") }),
        message(104, { header: header("no address here", "Nobody") }),
      ],
    });
    const result = await program.runWatcher(configuration(port), { password: PASSWORD, now });
    expect(result.hasNextPage).toBe(false);
    expect(result.cursor).toBeNull();
    expect(result.items.map((item) => item.id)).toEqual(["INBOX:7:104", "INBOX:7:103", "INBOX:7:102", "INBOX:7:101"]);
    const byUid = new Map(result.items.map((item) => [item.id.split(":")[2], item]));
    expect(byUid.get("101")).toEqual({
      id: "INBOX:7:101",
      revision: "mail-v1",
      actor: "ana.perez@example.com",
      from: "Ana Pérez <Ana.Perez@Example.COM>",
      to: "me@example.com",
      subject: "Price €5 review",
      date: "2026-07-17T09:44:25.000Z",
      messageId: "<id@example.com>",
      unread: false,
      preview: "Hello Ana, Please read.",
    });
    expect(byUid.get("102")?.actor).toBe("mallory@bad.example");
    expect(byUid.get("102")?.subject).toBe("Réunion demain");
    expect(byUid.get("102")?.unread).toBe(true);
    expect(byUid.get("103")?.actor).toBe("unknown");
    expect(byUid.get("104")?.actor).toBe("unknown");
    expect(server.verbs.at(-1)).toBe("LOGOUT");
  });

  it("asks only for unread mail when unseenOnly is true", async () => {
    const { server, port } = await serve({
      messages: [message(1, { flags: ["\\Seen"] }), message(2), message(3, { flags: ["\\Flagged"] })],
    });
    const unread = await program.runWatcher(configuration(port, { unseenOnly: "true" }), { password: PASSWORD, now });
    expect(unread.items.map((item) => item.id)).toEqual(["INBOX:7:3", "INBOX:7:2"]);
    expect(server.commandsStartingWith("UID SEARCH")).toEqual([
      expect.stringMatching(/ UID SEARCH UNSEEN SINCE 16-Jul-2026$/),
    ]);
    const all = await program.runWatcher(configuration(port, { unseenOnly: "false" }), { password: PASSWORD, now });
    expect(all.items).toHaveLength(3);
    expect(server.commandsStartingWith("UID SEARCH").at(-1)).toMatch(/ UID SEARCH SINCE 16-Jul-2026$/);
  });

  it("reads only the newest messages when more match than maxMessages", async () => {
    const all = Array.from({ length: 120 }, (_, index) => message(index + 1));
    const { server, port } = await serve({ messages: all });
    const capped = await program.runWatcher(configuration(port, { maxMessages: "3" }), { password: PASSWORD, now });
    expect(capped.items.map((item) => item.id)).toEqual(["INBOX:7:120", "INBOX:7:119", "INBOX:7:118"]);
    expect(server.commandsStartingWith("UID FETCH")).toEqual([expect.stringMatching(/ UID FETCH 120,119,118 /)]);
    const many = await program.runWatcher(configuration(port, { maxMessages: "120" }), { password: PASSWORD, now });
    expect(many.items).toHaveLength(120);
    expect(server.commandsStartingWith("UID FETCH").length).toBeGreaterThan(2);
  });

  it("rejects a maxMessages above 200 or below 1 without connecting", async () => {
    const { server, port } = await serve({ messages: [message(1)] });
    for (const maxMessages of ["201", "0", "abc", "1.5"])
      await expect(
        program.runWatcher(configuration(port, { maxMessages }), { password: PASSWORD, now }),
      ).rejects.toThrow(/maxMessages/);
    expect(server.connections).toBe(0);
  });

  it("keeps the revision fixed unless notifyOnFlagChange is true", async () => {
    const seen = await serve({ messages: [message(1, { flags: ["\\Seen", "\\Flagged"] })] });
    const unseen = await serve({ messages: [message(1)] });
    const revisions = async (port: string, notify: string) =>
      (
        await program.runWatcher(configuration(port, { notifyOnFlagChange: notify }), { password: PASSWORD, now })
      ).items.map((item) => item.revision);
    expect(await revisions(seen.port, "false")).toEqual(await revisions(unseen.port, "false"));
    expect(await revisions(seen.port, "true")).toEqual(["flags:\\Flagged,\\Seen"]);
    expect(await revisions(unseen.port, "true")).toEqual(["flags:"]);
  });

  it("uses the UIDVALIDITY and the mailbox name in the item id", async () => {
    const { server, port } = await serve({ messages: [message(5)], uidValidity: 4242 });
    const result = await program.runWatcher(configuration(port, { mailbox: "Projects/Café & Co" }), {
      password: PASSWORD,
      now,
    });
    expect(result.items.map((item) => item.id)).toEqual(["Projects/Café & Co:4242:5"]);
    expect(server.commandsStartingWith("EXAMINE")).toEqual([expect.stringContaining('"Projects/Caf&AOk- &- Co"')]);
  });

  it("falls back to the last day when the host sends no usable since", async () => {
    const { server, port } = await serve({ messages: [message(1)] });
    await program.runWatcher(configuration(port, { since: "not a date" }), { password: PASSWORD, now });
    expect(server.commandsStartingWith("UID SEARCH")[0]).toMatch(/SINCE 15-Jul-2026$/);
  });

  it("never sends a command that can change the mailbox", async () => {
    const { server, port } = await serve({ messages: [message(1), message(2, { flags: ["\\Seen"] })] });
    await program.runWatcher(configuration(port, { unseenOnly: "true" }), { password: PASSWORD, now });
    expect(server.verbs).toEqual(["CAPABILITY", "LOGIN", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"]);
    for (const line of server.commands)
      expect(line).not.toMatch(/\b(STORE|EXPUNGE|APPEND|COPY|MOVE|DELETE|SELECT|SETFLAGS)\b/i);
    const fetch = server.commandsStartingWith("UID FETCH")[0] ?? "";
    expect(fetch).toContain("BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)]");
    expect(fetch).toContain("BODY.PEEK[TEXT]<0.400>");
    expect(fetch).not.toMatch(/BODY\[|RFC822(?!\.)/);
  });

  describe("failures stay safe", () => {
    it("reports a refused login without the server text or the password", async () => {
      const { port } = await serve({ pass: "something-else" });
      const failure = await program
        .runWatcher(configuration(port), { password: PASSWORD, now })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("refused the login");
      expect(failure.message).toContain(template.variable);
      expect(failure.message).not.toContain(PASSWORD);
      expect(failure.message).not.toContain("SERVER-SECRET-TEXT");
    });

    it("reports a login failure from the real file with exit code 1 and an empty stdout", async () => {
      const { port } = await serve({ pass: "something-else" });
      const run = await spawnProgram(template.slug, JSON.stringify(configuration(port)), {
        [template.variable]: PASSWORD,
      });
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("refused the login");
      expect(run.stderr).not.toContain(PASSWORD);
      expect(run.stderr).not.toContain("SERVER-SECRET-TEXT");
    });

    it("rejects a line break or a non-ASCII character in the credentials before connecting", async () => {
      const { server, port } = await serve({ messages: [message(1)] });
      const badUsers = [
        "me@example.com\r\nA2 STORE 1 +FLAGS (\\Deleted)",
        "me\n@example.com",
        "me@example.com\r",
        "mé@example.com",
      ];
      for (const username of badUsers)
        await expect(
          program.runWatcher(configuration(port, { username }), { password: PASSWORD, now }),
        ).rejects.toThrow(/user name has a line break/);
      const badPasswords = ["pass\r\nSTORE", "pass\nword", "pass\rword", "pass\u0000word", "paéss"];
      for (const password of badPasswords) {
        const failure = await program.runWatcher(configuration(port), { password, now }).catch((error) => error);
        expect(failure.message).toMatch(/password has a line break/);
        expect(failure.message).not.toContain(password);
      }
      expect(server.connections).toBe(0);
    });

    it("escapes quotes and backslashes in credentials", async () => {
      const password = 'a"b\\c d';
      const { server, port } = await serve({ pass: password, messages: [message(1)] });
      const result = await program.runWatcher(configuration(port), { password, now });
      expect(result.items).toHaveLength(1);
      expect(server.commandsStartingWith("LOGIN")[0]).toContain('"a\\"b\\\\c d"');
    });

    it("rejects a missing password before connecting", async () => {
      const { server, port } = await serve();
      await expect(program.runWatcher(configuration(port), { password: "", now })).rejects.toThrow(
        new RegExp(`Missing ${template.variable}`),
      );
      expect(server.connections).toBe(0);
    });

    it("rejects an oversized line", async () => {
      const { port } = await serve({
        messages: [message(1)],
        respond: (verb, tag) =>
          verb === "UID SEARCH" ? `* SEARCH ${"1 ".repeat(300_000)}${CRLF}${tag} OK done${CRLF}` : undefined,
      });
      await expect(program.runWatcher(configuration(port), { password: PASSWORD, now })).rejects.toThrow(/too large/);
    });

    it("rejects an oversized literal", async () => {
      const { port } = await serve({
        messages: [message(1)],
        respond: (verb, tag) =>
          verb === "UID FETCH"
            ? `* 1 FETCH (UID 1 FLAGS () INTERNALDATE "17-Jul-2026 02:44:25 +0000" BODY[HEADER.FIELDS (FROM)] {99999999}${CRLF}${tag} OK done${CRLF}`
            : undefined,
      });
      await expect(program.runWatcher(configuration(port), { password: PASSWORD, now })).rejects.toThrow(/too large/);
    });

    it("rejects malformed answers", async () => {
      const cases: Record<string, (verb: string, tag: string) => string | undefined> = {
        "an unbalanced FETCH": (verb, tag) =>
          verb === "UID FETCH" ? `* 1 FETCH (UID 1 FLAGS (\\Seen)${CRLF}${tag} OK done${CRLF}` : undefined,
        "a FETCH without a header": (verb, tag) =>
          verb === "UID FETCH" ? `* 1 FETCH (UID 1 FLAGS ())${CRLF}${tag} OK done${CRLF}` : undefined,
        "a reply with the wrong tag": (verb) => (verb === "UID SEARCH" ? `Z9 OK done${CRLF}` : undefined),
        "a continuation request": (verb) => (verb === "UID SEARCH" ? `+ send more${CRLF}` : undefined),
        "a SEARCH with words in it": (verb, tag) =>
          verb === "UID SEARCH" ? `* SEARCH 1 x 2${CRLF}${tag} OK done${CRLF}` : undefined,
        "a missing UIDVALIDITY": (verb, tag) => (verb === "EXAMINE" ? `${tag} OK done${CRLF}` : undefined),
        "a BYE during the search": (verb, tag) =>
          verb === "UID SEARCH" ? `* BYE going away${CRLF}${tag} OK done${CRLF}` : undefined,
        "a disabled login": (verb, tag) =>
          verb === "CAPABILITY" ? `* CAPABILITY IMAP4rev1 LOGINDISABLED${CRLF}${tag} OK done${CRLF}` : undefined,
      };
      for (const [name, respond] of Object.entries(cases)) {
        const { port } = await serve({ messages: [message(1)], respond });
        const failure = await program
          .runWatcher(configuration(port), { password: PASSWORD, now })
          .catch((error) => error);
        expect(failure, name).toBeInstanceOf(Error);
        expect(failure.message, name).not.toContain(PASSWORD);
      }
    });

    it("rejects a greeting that is not OK", async () => {
      const { port } = await serve({ greeting: "* PREAUTH logged in already" });
      await expect(program.runWatcher(configuration(port), { password: PASSWORD, now })).rejects.toThrow(
        /did not greet/,
      );
    });

    it("gives up when the server never answers", async () => {
      const { port } = await serve({ silent: true });
      await expect(
        program.runWatcher(configuration(port), { password: PASSWORD, now, timeoutMs: 150 }),
      ).rejects.toThrow(/did not answer in time/);
    });

    it("reports a refused connection with a fixed message", async () => {
      const { server, port } = await serve();
      await server.stop();
      await expect(program.runWatcher(configuration(port), { password: PASSWORD, now })).rejects.toThrow(
        /refused the connection/,
      );
    });

    it("reports a mailbox that cannot be opened", async () => {
      const { port } = await serve({
        respond: (verb, tag) => (verb === "EXAMINE" ? `${tag} NO [NONEXISTENT] SERVER-SECRET-TEXT${CRLF}` : undefined),
      });
      const failure = await program
        .runWatcher(configuration(port), { password: PASSWORD, now })
        .catch((error) => error);
      expect(failure.message).toMatch(/mailbox could not be opened/);
      expect(failure.message).not.toContain("SERVER-SECRET-TEXT");
    });
  });

  describe("connection rules", () => {
    it("allows security none only for a server on this computer", async () => {
      const { server } = await serve();
      for (const host of ["mail.example.com", "192.0.2.10", "127.0.0.2"])
        await expect(
          program.runWatcher(configuration("143", { host, security: "none" }), { password: PASSWORD, now }),
        ).rejects.toThrow(/only for a server on this computer/);
      expect(server.connections).toBe(0);
    });

    it("accepts a self-signed certificate only for 127.0.0.1, ::1 and localhost", () => {
      for (const host of ["127.0.0.1", "::1", "localhost"]) expect(program.allowsSelfSigned(host)).toBe(true);
      for (const host of ["imap.gmail.com", "127.0.0.2", "192.168.1.5", "localhost.example.com", "10.0.0.1", ""])
        expect(program.allowsSelfSigned(host)).toBe(false);
    });

    it("rejects an unknown security mode, a bad port and a bad host", async () => {
      const bad: Record<string, string>[] = [
        { security: "ssl" },
        { port: "0" },
        { port: "70000" },
        { port: "99x" },
        { host: "a b" },
        { host: "a/b" },
      ];
      for (const extra of bad)
        await expect(program.runWatcher(configuration("143", extra), { password: PASSWORD, now })).rejects.toThrow();
    });

    it("rejects a missing user name and a non-object input", async () => {
      await expect(
        program.runWatcher(configuration("143", { username: "" }), { password: PASSWORD, now }),
      ).rejects.toThrow(/username/);
      await expect(program.runWatcher([], { password: PASSWORD, now })).rejects.toThrow(/JSON object/);
    });

    it("uses the template defaults for the server settings", async () => {
      // The defaults decide where an install without edits connects; keep them in sync with watcher.json.
      const spec = JSON.parse(await readFile(join(sourceRoot, "watchers", template.slug, "watcher.json"), "utf8"));
      const values = Object.fromEntries(
        spec.configuration.map((field: { name: string; value: string }) => [field.name, field.value]),
      );
      expect(values.host).toBe(template.defaults.host);
      expect(values.port).toBe(template.defaults.port);
      expect(values.security).toBe(template.defaults.security);
      expect(spec.variables.map((variable: { name: string }) => variable.name)).toEqual([template.variable]);
      const source = await readFile(programPath(template.slug), "utf8");
      expect(source).toContain(`const PASSWORD_VARIABLE = "${template.variable}";`);
      expect(source).toContain(`host: "${template.defaults.host}"`);
      expect(source).toContain(`port: "${template.defaults.port}"`);
      expect(source).toContain(`security: "${template.defaults.security}"`);
    });
  });

  describe("STARTTLS with a self-signed certificate", () => {
    async function certificate(): Promise<{ key: string; cert: string }> {
      const directory = await mkdtemp(join(tmpdir(), "openbot-mail-cert-"));
      temporaryRoots.push(directory);
      execFileSync(
        "openssl",
        [
          ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
          ...["-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "2"],
          ...["-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
        ],
        { stdio: "ignore" },
      );
      return {
        key: await readFile(join(directory, "key.pem"), "utf8"),
        cert: await readFile(join(directory, "cert.pem"), "utf8"),
      };
    }

    it("upgrades the connection and reads mail from a server on 127.0.0.1", async () => {
      const { server, port } = await serve({ certificate: await certificate(), messages: [message(9)] });
      const result = await program.runWatcher(configuration(port, { security: "starttls" }), {
        password: PASSWORD,
        now,
      });
      expect(result.items.map((item) => item.id)).toEqual(["INBOX:7:9"]);
      expect(server.verbs.slice(0, 3)).toEqual(["STARTTLS", "CAPABILITY", "LOGIN"]);
    });

    it.skipIf(process.platform !== "linux")("refuses the same certificate on any other address", async () => {
      const { server, port } = await serve({ certificate: await certificate(), messages: [message(9)] }, "0.0.0.0");
      await expect(
        program.runWatcher(configuration(port, { host: "127.0.0.2", security: "starttls" }), {
          password: PASSWORD,
          now,
        }),
      ).rejects.toThrow(/certificate is not trusted/);
      expect(server.commandsStartingWith("LOGIN")).toEqual([]);
    });
  });

  describe("the process contract", () => {
    it("reads one JSON object on stdin and prints exactly one JSON value", async () => {
      const { port } = await serve({ messages: [message(1), message(2)] });
      const run = await spawnProgram(template.slug, JSON.stringify(configuration(port, { cursor: "" })), {
        [template.variable]: PASSWORD,
      });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      const result: MailResult = JSON.parse(run.stdout);
      expect(Object.keys(result).sort()).toEqual(["cursor", "hasNextPage", "items"]);
      expect(result.hasNextPage).toBe(false);
      expect(result.cursor).toBeNull();
      expect(result.items.map((item) => item.id)).toEqual(["INBOX:7:2", "INBOX:7:1"]);
      for (const item of result.items) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.revision).toBe("string");
        expect(item.actor).toBe("ana@example.com");
      }
      expect(run.stdout.trim()).toBe(run.stdout);
    });

    it("fails with exit code 1 and a safe message for bad input or a missing password", async () => {
      const notJson = await spawnProgram(template.slug, "{not json", { [template.variable]: PASSWORD });
      expect(notJson.code).toBe(1);
      expect(notJson.stdout).toBe("");
      expect(notJson.stderr).toContain("Invalid watcher input JSON");
      const { port } = await serve();
      const noPassword = await spawnProgram(template.slug, JSON.stringify(configuration(port)), {});
      expect(noPassword.code).toBe(1);
      expect(noPassword.stdout).toBe("");
      expect(noPassword.stderr).toContain(`Missing ${template.variable}`);
    });
  });
});

describe("header helpers", () => {
  let program: Program;
  beforeAll(async () => {
    program = await loadProgram("gmail-inbox");
  });

  it("decodes encoded words and joins neighbours of one character set", () => {
    expect(program.decodeWords("=?utf-8?q?a=C3?= =?utf-8?q?=A9b?=")).toBe("aéb");
    expect(program.decodeWords(`plain =?ISO-8859-1?Q?caf=E9_ok?= tail`)).toBe("plain café ok tail");
    expect(program.decodeWords(`=?utf-8?B?${base64("one")}?= =?iso-8859-1?B?${base64("two")}?=`)).toBe("onetwo");
    expect(program.decodeWords("=?no-such-charset?Q?abc?=")).toBe("abc");
    expect(program.decodeWords("not =? an encoded word")).toBe("not =? an encoded word");
  });

  it("reads the sender address from the raw header, never from a display name", () => {
    expect(program.senderAddress("Ana <Ana@Example.com>")).toBe("ana@example.com");
    expect(program.senderAddress("bob@example.com")).toBe("bob@example.com");
    expect(program.senderAddress('"x <victim@example.com>" <real@example.com>')).toBe("real@example.com");
    expect(program.senderAddress("=?utf-8?q?x=3Cvictim=40example=2Ecom=3E?= <real@example.com>")).toBe(
      "real@example.com",
    );
    expect(program.senderAddress("a@example.com, b@example.com")).toBe("unknown");
    expect(program.senderAddress("A <a@example.com>, B <b@example.com>")).toBe("unknown");
    expect(program.senderAddress("")).toBe("unknown");
    expect(program.senderAddress("undisclosed-recipients:;")).toBe("unknown");
  });
});

describe("the two mail programs", () => {
  it("are identical except for the password variable and the server defaults", async () => {
    const [gmail, proton] = await Promise.all(
      templates.map((template) => readFile(programPath(template.slug), "utf8")),
    );
    const normalize = (source: string | undefined) =>
      (source ?? "")
        .replace(/const PASSWORD_VARIABLE = "[A-Z_]+";/, "const PASSWORD_VARIABLE = X;")
        .replace(/host: "[^"]+",\n {2}port: "\d+",\n {2}security: "[a-z]+",/, "SERVER_DEFAULTS");
    expect(normalize(gmail)).toBe(normalize(proton));
    expect(normalize(gmail)).toContain("SERVER_DEFAULTS");
  });
});

describe("the catalog", () => {
  it("resolves both templates with the same install proof as the real build", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-mail-catalog-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "watchers"), { recursive: true });
    await writeFile(
      join(root, "catalog.json"),
      JSON.stringify({ schemaVersion: 1, catalogVersion: "v1", order: templates.map((template) => template.slug) }),
    );
    for (const template of templates)
      await cp(join(sourceRoot, "watchers", template.slug), join(root, "watchers", template.slug), { recursive: true });
    const { templates: resolved, files } = await loadWatcherCatalog(root);
    expect(resolved.map((entry) => entry.slug)).toEqual(["gmail-inbox", "protonmail-inbox"]);
    expect(files.map((file) => file.path).sort()).toEqual([
      "catalog.json",
      "programs/gmail-inbox.mjs",
      "programs/protonmail-inbox.mjs",
    ]);
    for (const entry of resolved) {
      const template = templates.find((candidate) => candidate.slug === entry.slug);
      expect(entry.variables.map((variable) => variable.name)).toEqual([template?.variable]);
      expect(entry.app).toBeNull();
      expect(entry.actorPointer).toBe("/actor");
      expect(entry.selection).toEqual({ itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" });
      expect(entry.intervalSeconds).toBeGreaterThanOrEqual(30);
      expect(entry.instruction).toMatch(/untrusted/);
      expect(entry.configuration.find((field) => field.name === "username")?.required).toBe(true);
    }
  });
});
