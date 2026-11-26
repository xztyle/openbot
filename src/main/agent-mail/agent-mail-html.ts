// Markdown mail for people: an agent writes Markdown (Motion's dialect: GFM tables, `> [!NOTE]` and
// `> [!💡]` callouts, `- [ ]` checklists, `<details>` toggles), and the host sends it as an HTML part
// that looks like a Motion page, with a plain-text part beside it (multipart/alternative).
//
// Mail clients ignore most CSS, so the HTML is table-based with inline styles. Motion's design
// tokens (`motion/DESIGN.md`, `web/src/app/globals.css`) are mirrored below. A `<style>` block adds
// only what inline styles cannot: a narrower layout on phones and the dark surfaces where the client
// supports `prefers-color-scheme` (Apple Mail).
//
// Safety: the agent's text is never passed through as HTML. Every text is escaped, raw HTML tags are
// dropped (script and style contents with them), links keep only https, http and mailto targets, and
// images are not loaded (their alt text shows): no scripts, remote trackers or remote fonts.

import { Lexer, type Token, type Tokens } from "marked";

export type MailFormat = "text" | "markdown";

/** Motion's light tokens, and the dark ones the `<style>` block swaps in. */
const M = {
  wall: "#f4f5f7",
  stock: "#ffffff",
  ink: "#1c1d21",
  ink2: "#5b5f69",
  ink3: "#676c76",
  edge: "#e2e4e9",
  edgeStrong: "#cdd0d7",
  muted: "#eef0f3",
  rule: "#e5484d",
  skyInk: "#1b6fc2",
  mint: "#2f9e60",
  coral: "#ff6b4a",
  sticky: "#ffd84d",
} as const;

const DARK = {
  wall: "#15171c",
  stock: "#1e2128",
  ink: "#ecedf0",
  ink2: "#b1b5be",
  ink3: "#8f949e",
  edge: "#2b2f38",
  muted: "#262a32",
  rule: "#f0676b",
  skyInk: "#7cbef5",
} as const;

/** Tag plates: callout fills (light, dark). */
const PLATES = {
  default: ["#eaecf0", "#2a2e36"],
  blue: ["#cfe6ff", "#16314d"],
  green: ["#ccf0d9", "#163a26"],
  purple: ["#e2d9ff", "#2c2452"],
  orange: ["#ffd9b3", "#4a2d12"],
  red: ["#fbd3da", "#4a1c24"],
  yellow: ["#fff0a3", "#433a12"],
} as const;
type Plate = keyof typeof PLATES;

/** GitHub alerts as Motion imports them (docs/block-format.md): emoji and plate. */
const ALERTS: Record<string, { emoji: string; plate: Plate }> = {
  note: { emoji: "ℹ️", plate: "blue" },
  tip: { emoji: "💡", plate: "green" },
  important: { emoji: "❗", plate: "purple" },
  warning: { emoji: "⚠️", plate: "orange" },
  caution: { emoji: "🛑", plate: "red" },
};

const SANS = "Figtree,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = `'Bricolage Grotesque',${SANS}`;
const MONO = "'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";

/** Elements whose content is dropped with the tags. */
const DROPPED = /<(script|style|iframe|object|embed|template|noscript|svg|math|head|title)\b[\s\S]*?<\/\1\s*>/giu;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Named and numeric entities that Markdown text may hold, as characters. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[body.toLowerCase()] ?? match;
  });
}

/** The text of an HTML fragment: dropped elements removed, tags stripped, entities decoded. */
function htmlText(value: string): string {
  return decodeEntities(
    value
      .replace(DROPPED, "")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<[^>]*>/gu, ""),
  );
}

/** A link target that is safe in a mail, or null. */
export function safeMailHref(href: string): string | null {
  const value = href.trim();
  if (!/^(https?:\/\/|mailto:)/iu.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function style(rules: Record<string, string | number>): string {
  return Object.entries(rules)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

const P_STYLE = style({
  margin: "0 0 14px",
  "font-family": SANS,
  "font-size": "16px",
  "line-height": "1.7",
  color: M.ink,
});
const HEADING_SIZES = ["26px", "21px", "18px"] as const;

/** Whether a mail text reads as Markdown: a heading, table, checklist, callout or several marks. */
export function looksLikeMarkdown(text: string): boolean {
  const strong = [
    /^#{1,6} \S/mu,
    /^\|.+\|\s*$\n^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/mu,
    /^\s*[-*] \[[ xX]\] /mu,
    /^> \[!\S+\]/mu,
  ];
  if (strong.some((pattern) => pattern.test(text))) return true;
  const weak = [
    /\*\*[^*\n]+\*\*/u,
    /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/u,
    /^\s*[-*] \S/mu,
    /^\s*\d+\. \S/mu,
    /`[^`\n]+`/u,
  ];
  return weak.filter((pattern) => pattern.test(text)).length >= 2;
}

// --- Inline ---

interface InlineState {
  /** Inside a dropped element (`<script>` …) that inline HTML opened. */
  dropping: string | null;
}

function inlineHtml(tokens: Token[] | undefined, state: InlineState = { dropping: null }): string {
  let out = "";
  for (const token of tokens ?? []) {
    if (state.dropping) {
      if (token.type === "html" && new RegExp(`^</${state.dropping}\\s*>`, "iu").test(token.text))
        state.dropping = null;
      continue;
    }
    switch (token.type) {
      case "text":
      case "escape":
        out +=
          "tokens" in token && token.tokens ? inlineHtml(token.tokens, state) : escapeHtml(decodeEntities(token.text));
        break;
      case "strong":
        out += `<strong style="font-weight:700">${inlineHtml(token.tokens, state)}</strong>`;
        break;
      case "em":
        out += `<em>${inlineHtml(token.tokens, state)}</em>`;
        break;
      case "del":
        out += `<s style="color:${M.ink3}">${inlineHtml(token.tokens, state)}</s>`;
        break;
      case "codespan":
        out += `<code style="${style({ "font-family": MONO, "font-size": "0.86em", background: M.muted, "border-radius": "4px", padding: "1px 5px", color: M.ink })}">${escapeHtml(decodeEntities(token.text))}</code>`;
        break;
      case "br":
        out += "<br>";
        break;
      case "link": {
        const href = safeMailHref(token.href);
        const label = inlineHtml(token.tokens, state);
        out += href
          ? `<a class="m-link" href="${escapeHtml(href)}" style="color:${M.skyInk};text-decoration:underline">${label}</a>`
          : label;
        break;
      }
      case "image":
        out += token.text ? escapeHtml(`[${token.text}]`) : "";
        break;
      case "html": {
        const open = /^<(script|style|iframe|object|embed|template|noscript|svg|math)\b/iu.exec(token.text);
        if (open?.[1] && !/\/>\s*$/u.test(token.text)) state.dropping = open[1];
        else if (/^<br\s*\/?>$/iu.test(token.text.trim())) out += "<br>";
        else out += escapeHtml(htmlText(token.text));
        break;
      }
      default:
        if ("text" in token && typeof token.text === "string") out += escapeHtml(decodeEntities(token.text));
    }
  }
  return out;
}

/** The one link of a paragraph that holds nothing else (bold allowed): a primary action. */
function soleLink(tokens: Token[] | undefined): Tokens.Link | null {
  const meaningful = (tokens ?? []).filter((token) => !(token.type === "text" && token.text.trim() === ""));
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  if (isToken(only, "link")) return only;
  if (isToken(only, "strong")) return soleLink(only.tokens);
  return null;
}

function button(link: Tokens.Link): string | null {
  const href = safeMailHref(link.href);
  if (!href) return null;
  const label = inlineHtml(link.tokens);
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px"><tr>`,
    `<td class="m-btn" style="${style({ background: M.ink, "border-radius": "8px" })}">`,
    `<a class="m-btn-a" href="${escapeHtml(href)}" style="${style({ display: "inline-block", padding: "10px 18px", "font-family": SANS, "font-size": "15px", "font-weight": 600, "line-height": "20px", color: M.stock, "text-decoration": "none", "border-radius": "8px" })}">${label}&nbsp;&rarr;</a>`,
    "</td></tr></table>",
  ].join("");
}

// --- Blocks ---

function heading(depth: number, inner: string): string {
  const size = HEADING_SIZES[Math.min(Math.max(depth, 1), 3) - 1] ?? "18px";
  const top = depth <= 1 ? "26px" : depth === 2 ? "22px" : "18px";
  return `<h${Math.min(depth, 6)} class="m-t" style="${style({ margin: `${top} 0 10px`, "font-family": DISPLAY, "font-size": depth > 3 ? "16px" : size, "font-weight": 700, "line-height": "1.25", "letter-spacing": "-0.015em", color: M.ink })}">${inner}</h${Math.min(depth, 6)}>`;
}

function table(token: Tokens.Table): string {
  const cell = (item: Tokens.TableCell, header: boolean) => {
    const align = item.align ?? "left";
    const rules = {
      border: `1px solid ${M.edge}`,
      padding: "8px 10px",
      "font-family": SANS,
      "font-size": "14px",
      "line-height": "1.45",
      "text-align": align,
      "vertical-align": "top",
      color: M.ink,
      ...(header ? { background: M.wall, "font-weight": 600 } : { background: M.stock }),
      ...(align === "right"
        ? { "font-variant-numeric": "tabular-nums", ...(header ? {} : { "white-space": "nowrap" }) }
        : {}),
    };
    const tag = header ? "th" : "td";
    return `<${tag} class="${header ? "m-th" : "m-td"}" style="${style(rules)}"${header ? ' scope="col"' : ""}>${inlineHtml(item.tokens)}</${tag}>`;
  };
  return [
    `<div style="overflow-x:auto;margin:6px 0 18px">`,
    `<table class="m-table" role="table" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;border:1px solid ${M.edge}">`,
    `<thead><tr>${token.header.map((item) => cell(item, true)).join("")}</tr></thead>`,
    `<tbody>${token.rows.map((row) => `<tr>${row.map((item) => cell(item, false)).join("")}</tr>`).join("")}</tbody>`,
    "</table></div>",
  ].join("");
}

function checkbox(checked: boolean): string {
  return checked
    ? `<span style="${style({ display: "inline-block", width: "16px", height: "16px", "line-height": "16px", "border-radius": "4px", background: M.mint, color: "#ffffff", "font-size": "12px", "font-weight": 700, "text-align": "center", "font-family": SANS })}">&#10003;</span>`
    : `<span class="m-box" style="${style({ display: "inline-block", width: "13px", height: "13px", "border-radius": "4px", border: `1.5px solid ${M.ink3}`, background: M.stock })}">&nbsp;</span>`;
}

function listItemBody(item: Tokens.ListItem): string {
  const parts: string[] = [];
  for (const token of item.tokens) {
    if (token.type === "checkbox") continue;
    if (token.type === "text") parts.push(inlineHtml(token.tokens ?? [token]));
    else if (token.type === "paragraph") parts.push(inlineHtml(token.tokens));
    else parts.push(blocks([token], true));
  }
  return parts.join("");
}

function list(token: Tokens.List): string {
  const start = token.ordered ? Number(token.start) || 1 : 1;
  const rows = token.items.map((item, index) => {
    const marker = item.task
      ? checkbox(item.checked === true)
      : token.ordered
        ? `<span class="m-t2" style="color:${M.ink2};font-variant-numeric:tabular-nums;font-weight:600">${start + index}.</span>`
        : `<span class="m-t2" style="color:${M.ink2}">&bull;</span>`;
    const done = item.task && item.checked === true;
    const text = `<td class="${done ? "m-t3" : "m-t"}" style="${style({ padding: "3px 0", "font-family": SANS, "font-size": "16px", "line-height": "1.6", color: done ? M.ink3 : M.ink, ...(done ? { "text-decoration": "line-through" } : {}) })}">${listItemBody(item)}</td>`;
    return `<tr><td valign="top" style="${style({ width: token.ordered ? "28px" : "22px", padding: item.task ? "7px 0 3px" : "3px 0", "font-family": SANS, "font-size": "16px", "line-height": "1.6", "vertical-align": "top" })}">${marker}</td>${text}</tr>`;
  });
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:2px 0 14px;border-collapse:collapse">${rows.join("")}</table>`;
}

/** `> [!IMPORTANT]` or `> [!💡] Title`: the callout's look and the rest of its first paragraph. */
function calloutOf(token: Tokens.Blockquote): { emoji: string; plate: Plate; first: Token[] } | null {
  const first = token.tokens[0];
  if (!isToken(first, "paragraph")) return null;
  const head = first.tokens[0];
  if (!isToken(head, "text")) return null;
  const match = /^\[!([^\]\s]{1,24})\][ \t]*\n?/u.exec(head.text);
  if (!match?.[1]) return null;
  const marker = match[1];
  const alert = ALERTS[marker.toLowerCase()];
  const rest = head.text.slice(match[0].length);
  const restTokens: Token[] = [
    ...(rest ? [{ type: "text", raw: rest, text: rest } satisfies Tokens.Text] : []),
    ...first.tokens.slice(1),
  ];
  return { emoji: alert?.emoji ?? marker, plate: alert?.plate ?? "default", first: restTokens };
}

function blockquote(token: Tokens.Blockquote): string {
  const callout = calloutOf(token);
  if (!callout) {
    return `<div class="m-quote" style="${style({ margin: "4px 0 16px", padding: "2px 0 2px 16px", "border-left": `1px solid ${M.ink}`, color: M.ink2 })}">${blocks(token.tokens, true, M.ink2)}</div>`;
  }
  const first = inlineHtml(callout.first);
  const body = [
    first ? `<p style="${P_STYLE};margin:0 0 6px">${first}</p>` : "",
    blocks(token.tokens.slice(1), true, M.ink, true),
  ].join("");
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 18px;border-collapse:separate"><tr>`,
    `<td class="m-plate-${callout.plate}" style="${style({ background: PLATES[callout.plate][0], "border-radius": "8px", padding: "12px 16px" })}">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>`,
    `<td valign="top" style="width:30px;padding-top:2px;font-size:18px;line-height:24px">${escapeHtml(callout.emoji)}</td>`,
    `<td valign="top" class="m-callout" style="font-family:${SANS};font-size:16px;line-height:1.7;color:${M.ink}">${body}</td>`,
    "</tr></table></td></tr></table>",
  ].join("");
}

function details(summary: string, inner: Block[]): string {
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 18px;border-collapse:separate"><tr>`,
    `<td class="m-details" style="${style({ border: `1px solid ${M.edge}`, "border-radius": "8px", padding: "12px 16px", background: M.stock })}">`,
    `<div class="m-t2" style="${style({ margin: "0 0 8px", "font-family": SANS, "font-size": "13.5px", "font-weight": 600, color: M.ink2 })}">&#9662;&nbsp;${escapeHtml(summary)}</div>`,
    blocks(inner, true),
    "</td></tr></table>",
  ].join("");
}

/** A `<details><summary>…</summary> … </details>` run, pulled out of the block tokens. */
interface DetailsBlock {
  type: "details";
  summary: string;
  tokens: Block[];
}
type Block = Token | DetailsBlock;

interface KnownTokens {
  heading: Tokens.Heading;
  paragraph: Tokens.Paragraph;
  text: Tokens.Text;
  table: Tokens.Table;
  list: Tokens.List;
  blockquote: Tokens.Blockquote;
  code: Tokens.Code;
  html: Tokens.HTML;
  link: Tokens.Link;
  strong: Tokens.Strong;
}

/** Marked's `Token` includes a generic member, so its `type` alone does not narrow it. */
function isToken<K extends keyof KnownTokens>(token: Block | undefined, type: K): token is KnownTokens[K] {
  return token?.type === type && !isDetails(token);
}

function isDetails(token: Block): token is DetailsBlock {
  return token.type === "details" && "summary" in token && typeof token.summary === "string";
}

function groupDetails(tokens: Block[]): Block[] {
  const root: Block[] = [];
  const stack: { summary: string; tokens: Block[] }[] = [];
  const target = () => stack.at(-1)?.tokens ?? root;
  for (const token of tokens) {
    if (!isToken(token, "html")) {
      target().push(token);
      continue;
    }
    const opens = (token.text.match(/<details\b/giu) ?? []).length;
    const closes = (token.text.match(/<\/details\s*>/giu) ?? []).length;
    if (!opens && !closes) {
      target().push(token);
      continue;
    }
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/iu.exec(token.text)?.[1];
    for (let index = 0; index < opens; index += 1) stack.push({ summary: "", tokens: [] });
    const open = stack.at(-1);
    if (opens && open) {
      open.summary = htmlText(summary ?? "").trim() || "Detalles";
      const between = htmlText(
        token.text.replace(/<summary\b[^>]*>[\s\S]*?<\/summary\s*>/iu, "").replace(/<\/?details\b[^>]*>/giu, ""),
      ).trim();
      if (between)
        open.tokens.push({
          type: "paragraph",
          raw: between,
          text: between,
          tokens: [{ type: "text", raw: between, text: between }],
        });
    }
    for (let index = 0; index < closes; index += 1) {
      const done = stack.pop();
      if (done) target().push({ type: "details", summary: done.summary, tokens: done.tokens });
    }
  }
  while (stack.length) {
    const done = stack.pop();
    if (done) target().push({ type: "details", summary: done.summary, tokens: done.tokens });
  }
  return root;
}

function blocks(tokens: Block[], nested = false, color: string = M.ink, compact = false): string {
  const out: string[] = [];
  const pStyle = compact ? `${P_STYLE};margin:0 0 6px` : P_STYLE;
  const paragraph = (inner: string) => `<p class="m-t" style="${pStyle};color:${color}">${inner}</p>`;
  for (const token of nested ? tokens : groupDetails(tokens)) {
    if (isDetails(token)) out.push(details(token.summary, token.tokens));
    else if (isToken(token, "heading")) out.push(heading(token.depth, inlineHtml(token.tokens)));
    else if (isToken(token, "paragraph")) {
      const link = soleLink(token.tokens);
      out.push((link ? button(link) : null) ?? paragraph(inlineHtml(token.tokens)));
    } else if (isToken(token, "text")) out.push(paragraph(inlineHtml(token.tokens ?? [token])));
    else if (isToken(token, "table")) out.push(table(token));
    else if (isToken(token, "list")) out.push(list(token));
    else if (isToken(token, "blockquote")) out.push(blockquote(token));
    else if (isToken(token, "code"))
      out.push(
        `<pre class="m-code" style="${style({ margin: "4px 0 16px", padding: "12px 14px", background: M.muted, "border-radius": "8px", "font-family": MONO, "font-size": "13.5px", "line-height": "1.55", color: M.ink, "white-space": "pre-wrap", "word-break": "break-word" })}">${escapeHtml(token.text)}</pre>`,
      );
    else if (token.type === "hr")
      out.push(
        `<div class="m-hr" style="height:1px;line-height:1px;font-size:1px;background:${M.edge};margin:22px 0">&nbsp;</div>`,
      );
    else if (isToken(token, "html")) {
      const text = htmlText(token.text).trim();
      if (text) out.push(paragraph(escapeHtml(text).replaceAll("\n", "<br>")));
    }
  }
  return out.join("");
}

// --- Plain text ---

function inlineText(tokens: Token[] | undefined): string {
  let out = "";
  let dropping: string | null = null;
  for (const token of tokens ?? []) {
    if (dropping) {
      if (token.type === "html" && new RegExp(`^</${dropping}\\s*>`, "iu").test(token.text)) dropping = null;
      continue;
    }
    if (token.type === "link") {
      const label = inlineText(token.tokens);
      const href = safeMailHref(token.href);
      out += href && href !== label && `mailto:${label}` !== href ? `${label} (${href})` : label;
    } else if (token.type === "image") out += token.text ? `[${token.text}]` : "";
    else if (token.type === "br") out += "\n";
    else if (token.type === "html") {
      const open = /^<(script|style|iframe|object|embed|template|noscript|svg|math)\b/iu.exec(token.text);
      if (open?.[1]) dropping = open[1];
      else out += /^<br\s*\/?>$/iu.test(token.text.trim()) ? "\n" : htmlText(token.text);
    } else if ("tokens" in token && token.tokens) out += inlineText(token.tokens);
    else if ("text" in token && typeof token.text === "string") out += decodeEntities(token.text);
  }
  return out;
}

function textTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => inlineText(cell.tokens));
  const rows = token.rows.map((row) => row.map((cell) => inlineText(cell.tokens)));
  const widths = header.map((cell, index) =>
    Math.min(40, Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join(" | ")
      .trimEnd();
  return [line(header), widths.map((width) => "-".repeat(Math.max(3, width))).join("-+-"), ...rows.map(line)].join(
    "\n",
  );
}

function textList(token: Tokens.List): string {
  const start = token.ordered ? Number(token.start) || 1 : 1;
  return token.items
    .map((item, index) => {
      const mark = item.task ? (item.checked ? "[x]" : "[ ]") : token.ordered ? `${start + index}.` : "-";
      const body = item.tokens
        .filter((part) => part.type !== "checkbox")
        .map((part) =>
          isToken(part, "text") || isToken(part, "paragraph")
            ? inlineText(part.tokens ?? [part])
            : textBlocks([part], true).join("\n").replace(/^/gmu, "   "),
        )
        .join("\n");
      return `${mark} ${body}`;
    })
    .join("\n");
}

function textBlocks(tokens: Block[], nested = false): string[] {
  const out: string[] = [];
  for (const token of nested ? tokens : groupDetails(tokens)) {
    if (isDetails(token)) out.push(`${token.summary}:`, ...textBlocks(token.tokens, true));
    else if (isToken(token, "heading")) {
      const text = inlineText(token.tokens);
      const rule = (token.depth === 1 ? "=" : "-").repeat(Math.min(60, Math.max(3, text.length)));
      out.push(token.depth <= 2 ? `${text}\n${rule}` : text);
    } else if (isToken(token, "paragraph")) out.push(inlineText(token.tokens));
    else if (isToken(token, "text")) out.push(inlineText(token.tokens ?? [token]));
    else if (isToken(token, "table")) out.push(textTable(token));
    else if (isToken(token, "list")) out.push(textList(token));
    else if (isToken(token, "blockquote")) {
      const callout = calloutOf(token);
      const inner = callout
        ? [inlineText(callout.first), ...textBlocks(token.tokens.slice(1), true)].filter(Boolean)
        : textBlocks(token.tokens, true);
      out.push(
        `${callout ? `${callout.emoji} ` : ""}${inner.join("\n\n")}`
          .split("\n")
          .map((line) => `> ${line}`.trimEnd())
          .join("\n"),
      );
    } else if (isToken(token, "code")) out.push(token.text);
    else if (token.type === "hr") out.push("----------");
    else if (isToken(token, "html")) {
      const text = htmlText(token.text).trim();
      if (text) out.push(text);
    }
  }
  return out.filter((part) => part.trim() !== "");
}

// --- The mail ---

export interface MailRenderInput {
  markdown: string;
  subject: string;
  /** Who sends it, for the header line: "CSO Aprendivo". */
  senderName: string | null;
  /** Lines under the card, such as the opt-out of a first contact. */
  footer?: string | null;
}

export interface RenderedMail {
  html: string;
  text: string;
}

function darkStyles(): string {
  const plates = Object.entries(PLATES)
    .map(([plate, [, dark]]) => `.m-plate-${plate}{background:${dark}!important}`)
    .join("");
  return [
    "@media (prefers-color-scheme:dark){",
    `.m-wall{background:${DARK.wall}!important}`,
    `.m-card{background:${DARK.stock}!important;border-color:${DARK.edge}!important}`,
    `.m-t,.m-t *,.m-callout,.m-callout *,.m-td{color:${DARK.ink}!important}`,
    `.m-t2{color:${DARK.ink2}!important}.m-t3{color:${DARK.ink3}!important}`,
    `.m-th{background:${DARK.wall}!important;color:${DARK.ink}!important;border-color:${DARK.edge}!important}`,
    `.m-td{background:${DARK.stock}!important;border-color:${DARK.edge}!important}`,
    `.m-table{border-color:${DARK.edge}!important}`,
    `.m-title{color:${DARK.ink}!important;border-color:${DARK.rule}!important}`,
    `.m-link{color:${DARK.skyInk}!important}`,
    `.m-btn{background:${DARK.ink}!important}.m-btn-a{color:${DARK.stock}!important}`,
    `.m-details{background:${DARK.stock}!important;border-color:${DARK.edge}!important}`,
    `.m-code,code{background:${DARK.muted}!important;color:${DARK.ink}!important}`,
    `.m-hr{background:${DARK.edge}!important}.m-box{background:${DARK.stock}!important}`,
    `.m-quote{border-color:${DARK.ink}!important}.m-quote *{color:${DARK.ink2}!important}`,
    plates,
    "}",
    "@media only screen and (max-width:520px){",
    ".m-pad{padding:20px 18px 22px!important}.m-outer{padding:12px 8px 20px!important}",
    ".m-title{font-size:26px!important}",
    ".m-th,.m-td{padding:7px 8px!important;font-size:13.5px!important}",
    "}",
  ].join("");
}

/**
 * The HTML and plain-text parts of a Markdown mail. The first heading of level 1 at the top becomes
 * the page title in the Motion-style header; without one, the subject does.
 */
export function renderMarkdownMail(input: MailRenderInput): RenderedMail {
  const tokens = new Lexer({ gfm: true, breaks: false }).lex(input.markdown.replace(/\r\n?/gu, "\n"));
  const firstIndex = tokens.findIndex((token) => token.type !== "space");
  const first = tokens[firstIndex];
  const titled = first?.type === "heading" && first.depth === 1;
  const title = titled ? inlineHtml(first.tokens) : escapeHtml(input.subject);
  const titleText = titled ? inlineText(first.tokens) : input.subject;
  const body = titled ? tokens.filter((_, index) => index !== firstIndex) : tokens;
  const sender = input.senderName?.trim() || "Atelier";
  const footerText = input.footer?.trim() ?? "";

  const header = [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px"><tr>`,
    `<td style="width:22px;vertical-align:middle">`,
    `<div style="${style({ width: "14px", height: "11px", background: M.stock, border: `1px solid ${M.edgeStrong}`, "border-bottom": `2px solid ${M.rule}`, "border-radius": "2px" })}">&nbsp;</div>`,
    "</td>",
    `<td class="m-t2" style="${style({ "font-family": SANS, "font-size": "13px", "line-height": "18px", color: M.ink2, "vertical-align": "middle" })}">`,
    `<span class="m-t" style="color:${M.ink};font-weight:600">${escapeHtml(sender)}</span>`,
    `<span class="m-t3" style="color:${M.ink3}">&nbsp;&nbsp;/&nbsp;&nbsp;${escapeHtml(input.subject)}</span>`,
    "</td></tr></table>",
  ].join("");

  const titleBlock = `<h1 class="m-title" style="${style({ margin: "0 0 22px", padding: "0 0 12px", "border-bottom": `2px solid ${M.rule}`, "font-family": DISPLAY, "font-size": "32px", "font-weight": 700, "line-height": "1.15", "letter-spacing": "-0.02em", color: M.ink })}">${title}</h1>`;

  const footer = footerText
    ? `<p class="m-t3" style="${style({ margin: "16px 4px 0", "font-family": SANS, "font-size": "12px", "line-height": "1.5", color: M.ink3 })}">${escapeHtml(footerText).replaceAll("\n", "<br>")}</p>`
    : "";

  const html = [
    "<!doctype html>",
    '<html lang="es"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(titleText)}</title>`,
    `<style>${darkStyles()}</style>`,
    "</head>",
    `<body class="m-wall" style="margin:0;padding:0;background:${M.wall};-webkit-text-size-adjust:100%">`,
    `<table role="presentation" class="m-wall" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${M.wall}"><tr>`,
    `<td class="m-outer" align="center" style="padding:24px 12px 32px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:680px;width:100%;table-layout:fixed"><tr><td>`,
    header,
    `<table role="presentation" class="m-card" cellpadding="0" cellspacing="0" border="0" width="100%" style="${style({ background: M.stock, border: `1px solid ${M.edge}`, "border-radius": "8px", "border-collapse": "separate", "table-layout": "fixed" })}"><tr>`,
    `<td class="m-pad" style="padding:30px 32px 26px;font-family:${SANS};color:${M.ink}">`,
    titleBlock,
    blocks(body),
    "</td></tr></table>",
    footer,
    "</td></tr></table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("");

  const textParts = textBlocks(body);
  const text = [
    `${titleText}\n${"=".repeat(Math.min(60, Math.max(3, titleText.length)))}`,
    ...textParts,
    ...(footerText ? [footerText] : []),
  ].join("\n\n");
  return { html, text };
}

/** Whether a call's text should go out as Markdown: the agent said so, or it reads as Markdown. */
export function mailIsMarkdown(text: string, format: MailFormat | undefined): boolean {
  if (format) return format === "markdown";
  return looksLikeMarkdown(text);
}
