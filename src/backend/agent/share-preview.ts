/**
 * The pages that `share_preview` draws for a file that is not an image: a chart and the first rows of
 * a CSV file. The page has no script and loads nothing, so the preview window draws it at once.
 */

const ROW_LIMIT = 500;
const SERIES_LIMIT = 3;
const TABLE_ROWS = 6;
const TABLE_COLUMNS = 6;
const CHART_WIDTH = 680;
const CHART_HEIGHT = 260;
const COLORS = ["#2563eb", "#16a34a", "#dc2626"] as const;

/** The rows of a CSV text: quoted fields, doubled quotes, commas or semicolons, at most 500 rows. */
export function parseCsv(text: string): string[][] {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const firstLine = body.slice(0, body.indexOf("\n") === -1 ? body.length : body.indexOf("\n"));
  const separator = (firstLine.match(/;/gu)?.length ?? 0) > (firstLine.match(/,/gu)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < body.length && rows.length < ROW_LIMIT + 1; index += 1) {
    const character = body[index];
    if (quoted) {
      if (character === '"' && body[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === separator) {
      row.push(field.trim());
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && body[index + 1] === "\n") index += 1;
      row.push(field.trim());
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += character;
  }
  if (field !== "" || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

/** A number of a cell: 1,234.5, 1.234,5, $12, 45% and -3 read as numbers; anything else is not one. */
function cellNumber(cell: string): number | null {
  let text = cell.replace(/[\s$€£%]/gu, "");
  if (!text) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/u.test(text)) text = text.replaceAll(".", "").replace(",", ".");
  else if (/^-?\d+,\d+$/u.test(text)) text = text.replace(",", ".");
  else text = text.replaceAll(",", "");
  const value = Number(text);
  return Number.isFinite(value) && /^-?[\d.]+(e-?\d+)?$/iu.test(text) ? value : null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function compact(value: number): string {
  const size = Math.abs(value);
  if (size >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (size >= 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

interface Series {
  name: string;
  values: (number | null)[];
}

/** The numeric columns of the rows, after the first one, which names the points. */
function numericSeries(header: string[], rows: string[][]): Series[] {
  const series: Series[] = [];
  for (let column = 1; column < header.length && series.length < SERIES_LIMIT; column += 1) {
    const values = rows.map((row) => cellNumber(row[column] ?? ""));
    const numbers = values.filter((value) => value !== null).length;
    if (numbers >= Math.max(2, rows.length * 0.6)) series.push({ name: header[column] || `#${column + 1}`, values });
  }
  return series;
}

function chartSvg(labels: string[], series: Series[]): string {
  const left = 52;
  const bottom = 28;
  const top = 12;
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const all = series.flatMap((entry) => entry.values.filter((value): value is number => value !== null));
  const min = Math.min(0, ...all);
  const max = Math.max(...all, min + 1);
  const plotWidth = width - left - 8;
  const plotHeight = height - top - bottom;
  const y = (value: number) => top + plotHeight - ((value - min) / (max - min)) * plotHeight;
  const count = labels.length;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((share) => {
      const value = min + (max - min) * share;
      const position = y(value).toFixed(1);
      return `<line x1="${left}" x2="${width - 8}" y1="${position}" y2="${position}" stroke="#e5e7eb"/><text x="${left - 6}" y="${position}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="#6b7280">${compact(value)}</text>`;
    })
    .join("");
  const step = Math.max(1, Math.ceil(count / 8));
  const xLabels = labels
    .map((label, index) => {
      if (index % step !== 0) return "";
      const x = left + (count === 1 ? plotWidth / 2 : (index / Math.max(1, count - 1)) * plotWidth);
      return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(label.slice(0, 14))}</text>`;
    })
    .join("");
  const bars = count <= 16;
  const marks = series
    .map((entry, seriesIndex) => {
      const color = COLORS[seriesIndex % COLORS.length];
      if (bars) {
        const slot = plotWidth / count;
        const barWidth = Math.max(2, (slot * 0.7) / series.length);
        return entry.values
          .map((value, index) => {
            if (value === null) return "";
            const x = left + index * slot + slot * 0.15 + seriesIndex * barWidth;
            const barTop = Math.min(y(value), y(0));
            const size = Math.abs(y(value) - y(0));
            return `<rect x="${x.toFixed(1)}" y="${barTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${size.toFixed(1)}" rx="2" fill="${color}"/>`;
          })
          .join("");
      }
      const points = entry.values
        .map((value, index) =>
          value === null
            ? null
            : `${(left + (index / Math.max(1, count - 1)) * plotWidth).toFixed(1)},${y(value).toFixed(1)}`,
        )
        .filter((point): point is string => point !== null)
        .join(" ");
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
    })
    .join("");
  // The bars of the labels lie between the grid lines, so the labels move to the middle of each slot.
  const barLabels = bars
    ? labels
        .map((label, index) => {
          if (index % step !== 0) return "";
          const x = left + (index + 0.5) * (plotWidth / count);
          return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(label.slice(0, 14))}</text>`;
        })
        .join("")
    : xLabels;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${grid}${marks}${barLabels}</svg>`;
}

/**
 * A page that shows a CSV file: a chart of its numeric columns by its first column (bars up to 16
 * rows, lines above), a legend, and its first rows. A file with no numeric column shows its rows.
 */
export function csvPreviewHtml(title: string, text: string): string | null {
  const rows = parseCsv(text);
  const [header, ...data] = rows;
  if (!header || data.length === 0) return null;
  const series = numericSeries(header, data);
  const labels = data.map((row) => row[0] ?? "");
  const legend = series
    .map(
      (entry, index) =>
        `<span class="key"><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(entry.name)}</span>`,
    )
    .join("");
  const columns = header.slice(0, TABLE_COLUMNS);
  const table = `<table><thead><tr>${columns.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${data
    .slice(0, TABLE_ROWS)
    .map((row) => `<tr>${columns.map((_, index) => `<td>${escapeHtml(row[index] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
  const more = data.length > TABLE_ROWS ? `<p class="more">${data.length} rows</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px 20px;font:13px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif;color:#111827;background:#fff}
h1{font-size:15px;margin:0 0 8px}.legend{display:flex;gap:14px;margin:0 0 6px;color:#374151}
.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
table{border-collapse:collapse;margin-top:10px;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
th{color:#6b7280;font-weight:600}.more{color:#6b7280;margin:6px 0 0}
</style></head><body><h1>${escapeHtml(title)}</h1>${series.length ? `<div class="legend">${legend}</div>${chartSvg(labels, series)}` : ""}${table}${more}</body></html>`;
}
