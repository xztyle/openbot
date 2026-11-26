import { createMemo, For, Show } from "solid-js";
import { useText } from "../../text";

const ROW_LIMIT = 2_000;
const COLUMN_LIMIT = 100;

/** Splits CSV (or TSV) text into rows, with quoted fields and doubled quotes, as RFC 4180 writes them. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > ROW_LIMIT) break;
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A CSV or TSV file as a table: the first row is the header. */
export function CsvTablePreview(props: { text: string; name: string }) {
  const { t, format } = useText();
  const rows = createMemo(() => {
    const delimiter = /\.tsv$/iu.test(props.name) ? "\t" : guessDelimiter(props.text);
    return parseDelimited(props.text, delimiter).map((row) => row.slice(0, COLUMN_LIMIT));
  });
  const header = () => rows()[0] ?? [];
  const body = () => rows().slice(1, ROW_LIMIT + 1);
  return (
    <div class="csv-preview">
      <table class="csv-preview-table">
        <thead>
          <tr>
            <For each={header()}>{(cell) => <th scope="col">{cell}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={body()}>
            {(row) => (
              <tr>
                <For each={row}>{(cell) => <td>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={rows().length > ROW_LIMIT}>
        <p class="file-preview-truncated">{t("preview.csv.truncated", { limit: format.number(ROW_LIMIT) })}</p>
      </Show>
    </div>
  );
}

function guessDelimiter(text: string): string {
  const end = text.indexOf("\n");
  const line = text.slice(0, end < 0 ? 2_000 : end);
  const counts = [",", ";", "\t", "|"].map((candidate) => [candidate, line.split(candidate).length] as const);
  return counts.reduce((best, current) => (current[1] > best[1] ? current : best))[0];
}
