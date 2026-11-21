import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Schema } from "effect";

/** The longest one helper run may take, and the most output it may write. */
const HELPER_TIMEOUT_MS = 90_000;
const HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;

/** A source that could not be read. `detail` is the host's own text, safe to show; never a key. */
export class MoneySourceFailed extends Schema.TaggedError<MoneySourceFailed>()("MoneySourceFailed", {
  detail: Schema.String,
}) {}

/** One day of a source: the spend of an ad account, or the commissions of a Hotmart account. */
export interface MoneyDay {
  date: string;
  amount: number;
  currency: string;
  sales: number | null;
}

/** What a sync reads: the helpers of the managed skills, run with the host's shared keys. */
export interface MoneyHelpers {
  /** The folder of the managed skills (`resources/managed-skills`). */
  root: string;
  /** The Node.js that runs a helper. */
  node: string;
  /** A shared key of the agent key store, or null. Never logged. */
  secret: (name: string) => string | null;
}

/** A space's helper folder, when its agents set the helper up there. */
export function helperHome(sharedDirectory: string, helper: "meta-ads" | "hotmart"): string | null {
  const home = join(sharedDirectory, helper);
  return existsSync(join(home, "settings.json")) ? home : null;
}

/** The JSON object in `text`, or null for anything else. */
function jsonRecord(text: string): DynamicRecord | null {
  try {
    const value = JSON.parse(text);
    return isDynamicRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readSettings(home: string): DynamicRecord {
  try {
    return jsonRecord(readFileSync(join(home, "settings.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** The reason a helper run failed, from its JSON error, without anything it echoed of a request. */
function failureDetail(stdout: string, stderr: string, code: number | null): string {
  for (const text of [stdout, stderr]) {
    // Output that is not JSON says nothing: the exit code says enough.
    const value = jsonRecord(text);
    if (value && isDynamicRecord(value.error) && typeof value.error.message === "string")
      return value.error.message.slice(0, 180);
    if (value && typeof value.error === "string") return value.error.slice(0, 180);
  }
  return code === 4 ? "Rate limited; it will be read again later." : `The helper failed (exit ${code ?? "signal"}).`;
}

function runHelper(
  helpers: MoneyHelpers,
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): Effect.Effect<unknown, MoneySourceFailed> {
  return Effect.callback<unknown, MoneySourceFailed>((resume) => {
    const child = spawn(helpers.node, [join(helpers.root, script), ...args], {
      shell: false,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: process.env.HOME ?? "/tmp", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), HELPER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > HELPER_OUTPUT_BYTES) child.kill("SIGKILL");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resume(Effect.fail(new MoneySourceFailed({ detail: "The helper could not start." })));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      if (code !== 0) {
        resume(
          Effect.fail(
            new MoneySourceFailed({ detail: failureDetail(stdout, Buffer.concat(err).toString("utf8"), code) }),
          ),
        );
        return;
      }
      try {
        resume(Effect.succeed(JSON.parse(stdout)));
      } catch {
        resume(Effect.fail(new MoneySourceFailed({ detail: "The helper answered something that is not JSON." })));
      }
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}

function money(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : 0;
}

/** Why a source cannot be read now, or null when it can. */
export function metaMissing(helpers: MoneyHelpers, home: string | null) {
  if (!home) return "No meta-ads settings in this space's shared folder.";
  if (!helpers.secret("META_ACCESS_TOKEN")) return "No shared key META_ACCESS_TOKEN in Secrets.";
  const settings = readSettings(home);
  if (typeof settings.adAccountId !== "string" || settings.adAccountId === "")
    return "No ad account: meta-ads config set adAccountId act_<id>.";
  return null;
}

export function hotmartMissing(helpers: MoneyHelpers, home: string | null) {
  if (!home) return "No hotmart settings in this space's shared folder.";
  if (!helpers.secret("HOTMART_CLIENT_ID") || !helpers.secret("HOTMART_CLIENT_SECRET"))
    return "No shared keys HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET in Secrets.";
  return null;
}

/** The ad spend of each day from `since` to `until` (account days), read with the meta-ads helper. */
export function readMetaSpend(
  helpers: MoneyHelpers,
  home: string,
  since: string,
  until: string,
): Effect.Effect<MoneyDay[], MoneySourceFailed> {
  const token = helpers.secret("META_ACCESS_TOKEN") ?? "";
  return runHelper(
    helpers,
    "openbot-meta-ads/meta-ads.mjs",
    [
      "insights",
      "--level",
      "account",
      "--since",
      since,
      "--until",
      until,
      "--time-increment",
      "1",
      "--fields",
      "spend,actions,action_values,date_start",
      "--home",
      home,
      "--actor",
      "Atelier insight",
    ],
    { META_ACCESS_TOKEN: token, META_ADS_HOME: home },
  ).pipe(
    Effect.map((value) => {
      if (!isDynamicRecord(value) || !Array.isArray(value.data)) return [];
      const currency = typeof value.currency === "string" && value.currency ? value.currency.toUpperCase() : "USD";
      return value.data.flatMap((row): MoneyDay[] =>
        isDynamicRecord(row) && typeof row.date_start === "string"
          ? [
              {
                date: row.date_start.slice(0, 10),
                amount: money(row.spend),
                currency,
                sales: typeof row.purchases === "number" ? row.purchases : null,
              },
            ]
          : [],
      );
    }),
  );
}

/** Basic is the Base64 of `client_id:client_secret`, as Hotmart's developer page shows it. */
function hotmartBasic(helpers: MoneyHelpers): string {
  const saved = helpers.secret("HOTMART_BASIC");
  if (saved) return saved;
  return Buffer.from(
    `${helpers.secret("HOTMART_CLIENT_ID") ?? ""}:${helpers.secret("HOTMART_CLIENT_SECRET") ?? ""}`,
  ).toString("base64");
}

/** The approved commissions of one day, per currency, read with the hotmart helper. */
export function readHotmartDay(
  helpers: MoneyHelpers,
  home: string,
  date: string,
): Effect.Effect<MoneyDay[], MoneySourceFailed> {
  return runHelper(
    helpers,
    "openbot-hotmart/hotmart.mjs",
    ["summary", "--since", date, "--until", date, "--home", home, "--max-wait", "20"],
    {
      HOTMART_CLIENT_ID: helpers.secret("HOTMART_CLIENT_ID") ?? "",
      HOTMART_CLIENT_SECRET: helpers.secret("HOTMART_CLIENT_SECRET") ?? "",
      HOTMART_BASIC: hotmartBasic(helpers),
      HOTMART_HOME: home,
    },
  ).pipe(
    Effect.map((value) => {
      const results = isDynamicRecord(value) && Array.isArray(value.data) ? value.data : [];
      const first = results[0];
      const byCurrency = isDynamicRecord(first) && isDynamicRecord(first.by_currency) ? first.by_currency : {};
      return Object.entries(byCurrency).flatMap(([currency, total]): MoneyDay[] =>
        isDynamicRecord(total) && /^[A-Z]{3,8}$/u.test(currency)
          ? [{ date, amount: money(total.value), currency, sales: Math.max(0, Math.round(money(total.count))) }]
          : [],
      );
    }),
  );
}
