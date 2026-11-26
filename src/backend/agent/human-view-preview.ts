/**
 * The chat preview of a Motion page link (`share_preview`): Motion is not reachable for the window
 * that draws web pages, and the owner reads the human version of a page, not the agent text. So the
 * host draws the human version's Markdown as a small page with no script: headings, paragraphs,
 * lists, tables, bold and italic. A long page shows its start.
 */

/** Gives the human version of a Motion page link, or null for a link that is no Motion page. */
export interface MotionPagePreview {
  isMotionPage(url: string): boolean;
  humanVersion(url: string): Promise<{ title: string; markdown: string } | null>;
}

const PREVIEW_CHARS = 6_000;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1");
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());

/** The Markdown as HTML: block by block, line by line. */
export function markdownHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (line.trim().startsWith("|") && /^\s*\|?[\s:-]+\|/u.test(lines[index + 1] ?? "")) {
      closeList();
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        rows.push(cells(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      out.push(
        `<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    } else if (heading?.[1] && heading[2] !== undefined) {
      closeList();
      const level = Math.min(Math.max(heading[1].length, 2), 4);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet?.[1] !== undefined || numbered?.[1] !== undefined) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(bullet?.[1] ?? numbered?.[1] ?? "")}</li>`);
    } else if (line.trim() === "" || /^-{3,}$/u.test(line.trim())) closeList();
    else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

/** The preview page of a human version: its title and the start of its text. */
export function humanViewHtml(title: string, markdown: string): string {
  const cut = markdown.length > PREVIEW_CHARS;
  const text = cut ? `${markdown.slice(0, markdown.lastIndexOf("\n", PREVIEW_CHARS))}\n\n…` : markdown;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:28px 32px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1f2328;background:#fff}
h1{font-size:24px;margin:0 0 14px}h2{font-size:19px;margin:18px 0 8px}h3,h4{font-size:16px;margin:14px 0 6px}
p{margin:6px 0}ul,ol{margin:6px 0;padding-inline-start:22px}
table{border-collapse:collapse;margin:8px 0;font-size:14px}th,td{border:1px solid #d0d7de;padding:5px 9px;text-align:start}
th{background:#f6f8fa}
</style></head><body><h1>${inline(title)}</h1>
${markdownHtml(text)}
</body></html>`;
}
