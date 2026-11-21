// The Meta Ad Library watcher against a local fake Graph API: pacing between requests, one item per
// ad across terms, the new and proven revisions, the offer domain, no token in a snapshot link, and the
// error codes. Run: bun scripts/meta-ad-library-watcher-e2e.ts
import { spawn } from "node:child_process";
import { join } from "node:path";

const PROGRAM = join(import.meta.dir, "../marketplace/watcher-catalog/watchers/meta-ad-library/program.mjs");
const DAY = 86_400_000;
const requests: { at: number; url: URL; auth: string | null }[] = [];

const ads = (term: string) => [
  {
    id: "111",
    page_id: "p1",
    page_name: "Inglés Ya",
    ad_creative_bodies: [`Aprende ${term} en 30 días`],
    ad_creative_link_titles: ["Curso de inglés"],
    ad_creative_link_captions: ["pay.hotmart.com"],
    ad_delivery_start_time: new Date(Date.now() - 40 * DAY).toISOString(),
    ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=111&access_token=SECRET",
    languages: ["es"],
  },
  {
    id: "222",
    page_id: "p2",
    page_name: "Abogados Bilingües",
    ad_creative_bodies: ["Inglés jurídico"],
    ad_delivery_start_time: new Date(Date.now() - 2 * DAY).toISOString(),
    languages: ["es"],
  },
];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    requests.push({ at: Date.now(), url, auth: request.headers.get("authorization") });
    if (request.headers.get("authorization") !== "Bearer good-token")
      return Response.json({ error: { code: 190, message: "bad token" } }, { status: 400 });
    if (!url.pathname.endsWith("/ads_archive")) return Response.json({ error: { code: 100 } }, { status: 404 });
    return Response.json({ data: ads(url.searchParams.get("search_terms") ?? "") });
  },
});

function run(configuration: Record<string, string>, token = "good-token") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [PROGRAM], {
      env: { META_ACCESS_TOKEN: token, META_GRAPH_BASE_URL: `http://127.0.0.1:${server.port}` },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(configuration));
  });
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}\n`);
}

const result = await run({
  searchTerms: "inglés para abogados, curso de inglés",
  countries: "es",
  longRunningDays: "14",
});
check("exits 0", result.code === 0, result.stderr);
const output = JSON.parse(result.stdout || "{}");
const items: { id: string; revision: string; terms: string[]; offer: string | null; snapshotUrl: string | null }[] =
  output.items ?? [];
check("one item per ad across terms", items.length === 2 && items[0]?.terms.length === 2, items);
check(
  "proven after 14 days, else new",
  items.find((item) => item.id === "ad:111")?.revision === "proven" &&
    items.find((item) => item.id === "ad:222")?.revision === "new",
);
check("offer domain kept", items.find((item) => item.id === "ad:111")?.offer === "pay.hotmart.com");
check("no token in a snapshot link", !result.stdout.includes("SECRET"));
const gap = (requests[1]?.at ?? 0) - (requests[0]?.at ?? 0);
check("requests are 3.5 s apart", gap >= 3400, gap);
check("countries sent as a JSON list", requests[0]?.url.searchParams.get("ad_reached_countries") === '["ES"]');
check(
  "token is a header, never in the address",
  requests.every((request) => !request.url.search.includes("good-token")),
);

const refused = await run({ searchTerms: "x", countries: "ES" }, "bad-token");
check("refused token is auth", refused.code !== 0 && refused.stderr.includes("openbot-error: auth"), refused.stderr);
const config = await run({ searchTerms: "", countries: "ES" });
check("missing terms is config", config.code !== 0 && config.stderr.includes("openbot-error: config"), config.stderr);

server.stop(true);
if (failures > 0) {
  process.stderr.write(`${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("meta-ad-library watcher checks passed\n");
