import net from "node:net";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

// Template settings. The Gmail and Proton Mail templates differ only in this block.
const PASSWORD_VARIABLE = "PROTONMAIL_BRIDGE_PASSWORD";
const DEFAULTS = {
  host: "127.0.0.1",
  port: "1143",
  security: "starttls",
  unseenOnly: "true",
  mailbox: "INBOX",
  maxMessages: "50",
  notifyOnFlagChange: "false",
};

const SESSION_TIMEOUT_MS = 20000;
const LOGOUT_WAIT_MS = 2000;
const MAX_INPUT_BYTES = 32768;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_LITERAL_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_TOKENS = 4096;
const MAX_MESSAGES = 200;
const FETCH_BATCH = 50;
const PREVIEW_BYTES = 400;
const PREVIEW_CHARS = 300;
const FIELD_CHARS = 200;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Read-only by construction: the client refuses to send any other command.
const ALLOWED_COMMANDS = /^(?:CAPABILITY|STARTTLS|LOGIN|EXAMINE|UID SEARCH|UID FETCH|LOGOUT)(?: |$)/;
const FETCH_ITEMS = `(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT]<0.${PREVIEW_BYTES}>)`;
const TOO_LARGE = "The mail server sent a response that is too large.";
const SURPRISE = "The mail server sent a response this check does not understand.";
// Explicit uncertainty marker, never a user identity.
export const UNKNOWN_ACTOR = "unknown";

class WatcherError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new WatcherError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Self-signed certificates are accepted only for a server on this same computer. */
export function allowsSelfSigned(host) {
  return LOCAL_HOSTS.has(host);
}

function setting(input, name) {
  const value = input[name];
  if (value === undefined || value === null || value === "") return DEFAULTS[name];
  requireCondition(typeof value === "string" || typeof value === "number", `Invalid ${name}.`);
  return String(value).trim() || DEFAULTS[name];
}

function flag(input, name) {
  const value = setting(input, name).toLowerCase();
  requireCondition(value === "true" || value === "false", `${name} must be true or false.`);
  return value === "true";
}

function readConfiguration(input) {
  requireCondition(isRecord(input), "Expected a JSON object.");
  const host = setting(input, "host").replace(/^\[(.*)\]$/, "$1");
  requireCondition(/^[A-Za-z0-9._:-]{1,253}$/.test(host), "Invalid host.");
  const portText = setting(input, "port");
  const port = Number(portText);
  requireCondition(/^\d{1,5}$/.test(portText) && port >= 1 && port <= 65535, "port must be a number from 1 to 65535.");
  const security = setting(input, "security").toLowerCase();
  requireCondition(["tls", "starttls", "none"].includes(security), "security must be tls, starttls or none.");
  requireCondition(
    security !== "none" || allowsSelfSigned(host),
    "security none is allowed only for a server on this computer.",
  );
  const username = input.username;
  requireCondition(typeof username === "string" && username.length > 0, "Missing or invalid username.");
  const mailbox = setting(input, "mailbox");
  requireCondition(mailbox.length <= FIELD_CHARS, "Invalid mailbox.");
  const maxMessages = Number(setting(input, "maxMessages"));
  requireCondition(
    Number.isInteger(maxMessages) && maxMessages >= 1 && maxMessages <= MAX_MESSAGES,
    `maxMessages must be a whole number from 1 to ${MAX_MESSAGES}.`,
  );
  return {
    host,
    port,
    security,
    username,
    mailbox,
    maxMessages,
    unseenOnly: flag(input, "unseenOnly"),
    notifyOnFlagChange: flag(input, "notifyOnFlagChange"),
  };
}

/** An IMAP quoted string. Printable ASCII only, so a value can never end the command or start a literal. */
function quote(value, label) {
  requireCondition(
    typeof value === "string" && /^[\x20-\x7e]*$/.test(value),
    `The ${label} has a line break or a character that is not printable ASCII.`,
  );
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** Modified UTF-7 (RFC 3501 section 5.1.3) for a mailbox name. */
function encodeMailbox(name) {
  let out = "";
  let run = "";
  const flush = () => {
    if (!run) return;
    const bytes = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) bytes.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${bytes.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
    run = "";
  };
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    requireCondition(code >= 0x20 && code !== 0x7f, "Invalid mailbox.");
    if (code <= 0x7e) {
      flush();
      out += code === 0x26 ? "&-" : name[i];
    } else run += name[i];
  }
  flush();
  return out;
}

function connectionError(error) {
  if (error instanceof WatcherError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "ECONNREFUSED")
    return new WatcherError(
      "The mail server refused the connection. Check the host and the port, and that the server is running.",
    );
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new WatcherError("The mail server host name was not found.");
  if (["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code))
    return new WatcherError("Cannot reach the mail server.");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|^ERR_TLS/.test(code))
    return new WatcherError("The mail server certificate is not trusted.");
  return new WatcherError("Cannot talk to the mail server.");
}

function tlsOptions(config) {
  return {
    host: config.host,
    servername: net.isIP(config.host) ? undefined : config.host,
    rejectUnauthorized: !allowsSelfSigned(config.host),
    minVersion: "TLSv1.2",
  };
}

function openSocket(config) {
  if (config.security === "tls") return tls.connect({ ...tlsOptions(config), port: config.port });
  return net.connect({ host: config.host, port: config.port });
}

/**
 * A strict IMAP client. It reads one complete response at a time (a line, or a line with literals) and
 * fails closed on anything it does not expect. Only the commands in ALLOWED_COMMANDS can be sent.
 */
class Connection {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #error = null;
  #closed = false;
  #wake = null;
  #tag = 0;
  #bytes = 0;
  #timer;

  constructor(timeoutMs) {
    this.#timer = setTimeout(() => this.#fail(new WatcherError("The mail server did not answer in time.")), timeoutMs);
  }

  attach(socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      this.#bytes += chunk.length;
      if (this.#bytes > MAX_SESSION_BYTES) return this.#fail(new WatcherError(TOO_LARGE));
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#notify();
    });
    socket.on("error", (error) => this.#fail(connectionError(error)));
    socket.on("close", () => {
      this.#closed = true;
      this.#notify();
    });
  }

  upgradeToTls(options) {
    // Bytes the server sent before the handshake could be forged by a network attacker.
    requireCondition(this.#buffer.length === 0, SURPRISE);
    const raw = this.#socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");
    raw.on("error", () => {});
    this.attach(tls.connect({ ...options, socket: raw }));
  }

  close() {
    clearTimeout(this.#timer);
    this.#socket?.destroy();
  }

  #notify() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #fail(error) {
    this.#error ??= error;
    this.#socket?.destroy();
    this.#notify();
  }

  /** Answers the parts of one response: text, literal, text, ... or null when more bytes are needed. */
  #parse() {
    const parts = [];
    let pos = 0;
    for (;;) {
      const eol = this.#buffer.indexOf("\r\n", pos);
      if (eol < 0) {
        requireCondition(this.#buffer.length - pos <= MAX_LINE_BYTES, TOO_LARGE);
        return null;
      }
      requireCondition(eol - pos <= MAX_LINE_BYTES, TOO_LARGE);
      const line = this.#buffer.toString("latin1", pos, eol);
      const literal = /\{(\d{1,10})\}$/.exec(line);
      if (!literal) {
        parts.push(line);
        this.#buffer = this.#buffer.subarray(eol + 2);
        return parts;
      }
      const size = Number(literal[1]);
      requireCondition(size <= MAX_LITERAL_BYTES, TOO_LARGE);
      const start = eol + 2;
      if (this.#buffer.length < start + size) return null;
      parts.push(line.slice(0, literal.index), Buffer.from(this.#buffer.subarray(start, start + size)));
      pos = start + size;
    }
  }

  async #readResponse() {
    for (;;) {
      if (this.#error) throw this.#error;
      const parts = this.#parse();
      if (parts) return parts;
      requireCondition(this.#buffer.length <= MAX_PENDING_BYTES, TOO_LARGE);
      if (this.#closed) throw new WatcherError("The mail server closed the connection.");
      await new Promise((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  async greeting() {
    const parts = await this.#readResponse();
    requireCondition(
      parts.length === 1 && /^\* OK(?: |$)/i.test(parts[0]),
      "The mail server did not greet as expected.",
    );
  }

  /** Sends one command and answers its tagged status (OK, NO or BAD). Untagged responses go to `onUntagged`. */
  async command(text, onUntagged, { allowBye = false } = {}) {
    requireCondition(ALLOWED_COMMANDS.test(text) && !/[\r\n]/.test(text), "Internal error: command not allowed.");
    const tag = `A${++this.#tag}`;
    this.#socket.write(`${tag} ${text}\r\n`);
    for (;;) {
      const parts = await this.#readResponse();
      if (parts[0].startsWith("* ")) {
        requireCondition(allowBye || !/^\* BYE(?: |$)/i.test(parts[0]), "The mail server ended the session.");
        onUntagged?.(parts);
        continue;
      }
      const status = /^(A\d+) (OK|NO|BAD)(?: |$)/i.exec(parts[0]);
      requireCondition(status && status[1] === tag && parts.length === 1, SURPRISE);
      return status[2].toUpperCase();
    }
  }

  async logout() {
    let timer;
    const wait = new Promise((resolve) => {
      timer = setTimeout(resolve, LOGOUT_WAIT_MS);
    });
    try {
      await Promise.race([this.command("LOGOUT", undefined, { allowBye: true }), wait]);
    } catch {
      // The data is already read. A server that is slow to say goodbye changes nothing.
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Splits a response into tokens. A literal stays a Buffer; `[...]` stays inside its atom. */
function tokenize(parts) {
  const tokens = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      tokens.push({ literal: part });
      continue;
    }
    let pos = 0;
    while (pos < part.length) {
      const char = part[pos];
      if (char === " ") pos++;
      else if (char === "(" || char === ")") {
        tokens.push(char);
        pos++;
      } else if (char === '"') {
        let value = "";
        pos++;
        for (;;) {
          requireCondition(pos < part.length, SURPRISE);
          const next = part[pos++];
          if (next === '"') break;
          if (next === "\\") {
            requireCondition(pos < part.length, SURPRISE);
            value += part[pos++];
          } else value += next;
        }
        tokens.push({ text: value });
      } else {
        let end = pos;
        while (end < part.length && !' ()"'.includes(part[end])) {
          if (part[end] === "[") {
            const close = part.indexOf("]", end);
            requireCondition(close >= 0, SURPRISE);
            end = close + 1;
          } else end++;
        }
        tokens.push({ atom: part.slice(pos, end) });
        pos = end;
      }
      requireCondition(tokens.length <= MAX_TOKENS, TOO_LARGE);
    }
  }
  return tokens;
}

function parseValue(tokens, state, depth) {
  const token = tokens[state.index++];
  requireCondition(token !== undefined && token !== ")", SURPRISE);
  if (token === "(") {
    requireCondition(depth < 6, SURPRISE);
    const list = [];
    while (tokens[state.index] !== ")") {
      requireCondition(state.index < tokens.length, SURPRISE);
      list.push(parseValue(tokens, state, depth + 1));
    }
    state.index++;
    return list;
  }
  if (token.literal) return token.literal;
  if (token.text !== undefined) return token.text;
  return token.atom.toUpperCase() === "NIL" ? null : token.atom;
}

function parseImapDate(value) {
  const match = /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  const month = match ? MONTHS.findIndex((name) => name.toLowerCase() === match[2].toLowerCase()) : -1;
  if (!match || month < 0) return null;
  const [, day, , year, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60000 * (sign === "-" ? -1 : 1);
  const time = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)) - offset;
  return Number.isFinite(time) ? time : null;
}

function asBuffer(value) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  requireCondition(typeof value === "string" && value.length <= MAX_LITERAL_BYTES, SURPRISE);
  return Buffer.from(value, "latin1");
}

/** One `* n FETCH (...)` response, or null when it carries no UID (a flag update the server pushed). */
function parseFetch(parts) {
  const prefix = /^\* \d+ FETCH /i.exec(parts[0]);
  if (!prefix) return undefined;
  const tokens = tokenize([parts[0].slice(prefix[0].length), ...parts.slice(1)]);
  const state = { index: 0 };
  const list = parseValue(tokens, state, 0);
  requireCondition(Array.isArray(list) && state.index === tokens.length && list.length % 2 === 0, SURPRISE);
  const fields = new Map();
  for (let i = 0; i < list.length; i += 2) {
    requireCondition(typeof list[i] === "string", SURPRISE);
    fields.set(list[i].toUpperCase(), list[i + 1]);
  }
  const uidText = fields.get("UID");
  if (uidText === undefined) return null;
  requireCondition(typeof uidText === "string" && /^\d{1,10}$/.test(uidText), SURPRISE);
  const flagsValue = fields.get("FLAGS") ?? [];
  requireCondition(
    Array.isArray(flagsValue) && flagsValue.length <= 64 && flagsValue.every((f) => typeof f === "string"),
    SURPRISE,
  );
  const dateValue = fields.get("INTERNALDATE");
  requireCondition(dateValue === undefined || dateValue === null || typeof dateValue === "string", SURPRISE);
  const keyed = (prefixText) => [...fields].find(([key]) => key.startsWith(prefixText));
  const header = keyed("BODY[HEADER");
  requireCondition(header !== undefined, SURPRISE);
  return {
    uid: Number(uidText),
    flags: flagsValue.filter((f) => /^\\?[A-Za-z0-9$_.-]{1,64}$/.test(f)),
    internalDate: typeof dateValue === "string" ? parseImapDate(dateValue) : null,
    header: asBuffer(header[1]),
    text: asBuffer(keyed("BODY[TEXT]")?.[1]),
  };
}

/** Control, invisible and text-direction characters. */
function isHiddenCharacter(code) {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x61c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Plain one-line text for the agent: no control or direction characters, bounded length. */
function clean(value, max) {
  const characters = Array.from(String(value), (char) => (isHiddenCharacter(char.codePointAt(0)) ? " " : char));
  const text = characters.join("").replace(/\s+/g, " ").trim();
  const shown = Array.from(text);
  return shown.length > max ? `${shown.slice(0, max - 1).join("")}…` : text;
}

function decodeBytes(charset, bytes) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQ(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "_") bytes.push(0x20);
    else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words. Neighbouring words of one character set decode together, so split characters survive. */
export function decodeWords(value) {
  const input = value.slice(0, 4000);
  const out = [];
  let pending = null;
  let last = 0;
  const flush = () => {
    if (pending) out.push(decodeBytes(pending.charset, Buffer.concat(pending.chunks)));
    pending = null;
  };
  for (const match of input.matchAll(/=\?([A-Za-z0-9._-]+)(?:\*[A-Za-z-]+)?\?([BbQq])\?([^?\s]*)\?=/g)) {
    const between = input.slice(last, match.index);
    if (!pending || between.trim() !== "") {
      flush();
      out.push(between);
    }
    const charset = match[1].toLowerCase();
    const bytes = match[2].toLowerCase() === "b" ? Buffer.from(match[3], "base64") : decodeQ(match[3]);
    if (pending && pending.charset === charset) pending.chunks.push(bytes);
    else {
      flush();
      pending = { charset, chunks: [bytes] };
    }
    last = match.index + match[0].length;
  }
  flush();
  out.push(input.slice(last));
  return out.join("");
}

function parseHeaders(text) {
  const headers = new Map();
  for (const line of text.replace(/\r?\n(?=[ \t])/g, "").split(/\r?\n/)) {
    const match = /^([A-Za-z-]{1,40}):[ \t]*(.*)$/.exec(line);
    const name = match?.[1].toLowerCase();
    if (match && !headers.has(name)) headers.set(name, match[2].trim());
  }
  return headers;
}

/**
 * The one address in a From header, lowercased, or "unknown". It reads the raw header, never decoded
 * text, so a display name cannot fake an address. The sender is not verified: From can be forged.
 */
export function senderAddress(raw) {
  const stripped = raw
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=/g, " ")
    .replace(/\([^)]*\)/g, " ");
  const angles = [...stripped.matchAll(/<([^<>]*)>/g)];
  const candidate = angles.length === 1 ? angles[0][1] : angles.length === 0 ? stripped : "";
  const address = candidate.trim();
  return address.length <= 254 && /^[^\s<>()[\]\\,;:@"]+@[^\s<>()[\]\\,;:@"]+$/.test(address)
    ? address.toLowerCase()
    : UNKNOWN_ACTOR;
}

function previewText(bytes) {
  let text = bytes.toString("utf8").replace(/�+$/, "").replace(/\r\n/g, "\n");
  // A multipart body starts with a boundary and the headers of its first part.
  if (/^--\S+\n/.test(text)) {
    const blank = text.indexOf("\n\n");
    text = blank >= 0 ? text.slice(blank + 2) : "";
  }
  if (/=\n/.test(text) || (text.match(/=[0-9A-F]{2}/g)?.length ?? 0) >= 2) {
    const raw = Buffer.from(text);
    const decoded = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0x3d && raw[i + 1] === 0x0a) i += 1;
      else if (raw[i] === 0x3d && /^[0-9A-F]{2}$/.test(raw.toString("latin1", i + 1, i + 3))) {
        decoded.push(Number.parseInt(raw.toString("latin1", i + 1, i + 3), 16));
        i += 2;
      } else decoded.push(raw[i]);
    }
    text = Buffer.from(decoded).toString("utf8");
  }
  text = text
    .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, " ")
    .replace(/<[^>]*(?:>|$)/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
  // A block of base64 or similar encoded data is not a readable preview.
  if (text.length >= 40 && /^[A-Za-z0-9+/=\n]+$/.test(text)) return "";
  return clean(text, PREVIEW_CHARS);
}

function flagRevision(flags) {
  return `flags:${flags
    .filter((f) => f !== "\\Recent")
    .sort()
    .join(",")}`;
}

function buildItem(entry, config, uidValidity) {
  const headers = parseHeaders(entry.header.toString("utf8"));
  const from = headers.get("from") ?? "";
  return {
    id: `${config.mailbox}:${uidValidity}:${entry.uid}`,
    revision: config.notifyOnFlagChange ? flagRevision(entry.flags) : "mail-v1",
    actor: senderAddress(from),
    from: clean(decodeWords(from), FIELD_CHARS),
    to: clean(decodeWords(headers.get("to") ?? ""), FIELD_CHARS),
    subject: clean(decodeWords(headers.get("subject") ?? ""), FIELD_CHARS),
    date: entry.internalDate === null ? null : new Date(entry.internalDate).toISOString(),
    messageId: clean(headers.get("message-id") ?? "", FIELD_CHARS),
    unread: !entry.flags.some((f) => f.toLowerCase() === "\\seen"),
    preview: previewText(entry.text),
  };
}

function imapDate(milliseconds) {
  const date = new Date(milliseconds);
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

async function readMailbox(config, password, sinceMs, timeoutMs) {
  const connection = new Connection(timeoutMs);
  try {
    connection.attach(openSocket(config));
    await connection.greeting();
    if (config.security === "starttls") {
      requireCondition((await connection.command("STARTTLS")) === "OK", "The mail server does not offer STARTTLS.");
      connection.upgradeToTls(tlsOptions(config));
    }
    let capabilities = [];
    const capability = await connection.command("CAPABILITY", (parts) => {
      const match = /^\* CAPABILITY (.*)$/i.exec(parts[0]);
      if (match && parts.length === 1) capabilities = match[1].toUpperCase().split(" ");
    });
    requireCondition(
      capability === "OK" && !capabilities.includes("LOGINDISABLED"),
      "The mail server does not allow login on this connection.",
    );
    const login = await connection.command(
      `LOGIN ${quote(config.username, "user name")} ${quote(password, "password")}`,
    );
    requireCondition(
      login === "OK",
      `The mail server refused the login. Check the user name and the ${PASSWORD_VARIABLE} private variable.`,
    );
    let uidValidity = null;
    const examine = await connection.command(
      `EXAMINE ${quote(encodeMailbox(config.mailbox), "mailbox name")}`,
      (parts) => {
        const match = /^\* OK \[UIDVALIDITY (\d{1,10})\]/i.exec(parts[0]);
        if (match) uidValidity = match[1];
      },
    );
    requireCondition(examine === "OK", "The mailbox could not be opened. Check the mailbox name.");
    requireCondition(uidValidity !== null, SURPRISE);

    const found = new Set();
    // SINCE has day precision in the server's time zone, so ask for one extra day. The host drops repeats.
    const search = await connection.command(
      `UID SEARCH ${config.unseenOnly ? "UNSEEN " : ""}SINCE ${imapDate(sinceMs - 86400000)}`,
      (parts) => {
        if (!/^\* SEARCH(?: |$)/i.test(parts[0])) return;
        const match = /^\* SEARCH((?: \d{1,10})*)$/i.exec(parts[0]);
        requireCondition(match && parts.length === 1, SURPRISE);
        for (const id of match[1].split(" ").filter(Boolean)) found.add(Number(id));
      },
    );
    requireCondition(search === "OK", "The mail search failed.");
    // Only the newest messages are read; a larger match is cut to `maxMessages`.
    const wanted = [...found]
      .filter((uid) => uid > 0)
      .sort((a, b) => b - a)
      .slice(0, config.maxMessages);

    const entries = new Map();
    for (let i = 0; i < wanted.length; i += FETCH_BATCH) {
      const batch = new Set(wanted.slice(i, i + FETCH_BATCH));
      const fetch = await connection.command(`UID FETCH ${[...batch].join(",")} ${FETCH_ITEMS}`, (parts) => {
        const entry = parseFetch(parts);
        if (entry && batch.has(entry.uid)) entries.set(entry.uid, entry);
      });
      requireCondition(fetch === "OK", "The mail fetch failed.");
    }
    await connection.logout();
    return wanted.filter((uid) => entries.has(uid)).map((uid) => buildItem(entries.get(uid), config, uidValidity));
  } finally {
    connection.close();
  }
}

/**
 * One read-only pass over a mailbox. The IMAP server holds all state; nothing is written or marked read.
 * The host compares ids and revisions with its own baseline.
 */
export async function runWatcher(
  input,
  { password = process.env[PASSWORD_VARIABLE], now = () => Date.now(), timeoutMs = SESSION_TIMEOUT_MS } = {},
) {
  const config = readConfiguration(input);
  requireCondition(
    typeof password === "string" && password.length > 0,
    `Missing ${PASSWORD_VARIABLE} private variable.`,
  );
  quote(config.username, "user name");
  quote(password, "password");
  const current = now();
  const since = typeof input.since === "string" ? Date.parse(input.since) : Number.NaN;
  const sinceMs = Number.isFinite(since) && since <= current ? since : current - 86400000;
  const items = await readMailbox(config, password, sinceMs, timeoutMs);
  return { items, hasNextPage: false, cursor: null };
}

async function main() {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk.toString("utf8");
      requireCondition(Buffer.byteLength(stdin) <= MAX_INPUT_BYTES, "Watcher input exceeds the safe size limit.");
    }
    let input;
    try {
      input = JSON.parse(stdin);
    } catch {
      throw new WatcherError("Invalid watcher input JSON.");
    }
    process.stdout.write(JSON.stringify(await runWatcher(input)));
  } catch (error) {
    // Only locally written messages reach stderr; never server text or the password.
    process.stderr.write(`Mail inbox watcher: ${error instanceof WatcherError ? error.message : "Watcher failed."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
