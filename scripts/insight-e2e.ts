// End-to-end check of the insight service (goals, money, costs, briefing, "Why is this slow?") with
// the real store, the real helper launcher and fake Meta Ads and Hotmart helpers in a temp folder.
// It also round-trips every report and action through the IPC decoders and the workspace-insight-v1
// wire codec. With OPENBOT_INSIGHT_DB=<path to openbot.db> it also runs the insight reads, the cost
// computation and one timeline against that database, opened read-only, and prints only counts.
// `bun scripts/insight-e2e.ts`. Writes .openbot-build/insight-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ChannelMessage,
  decodeWorkspaceInsight,
  decodeWorkspaceWhySlow,
  parseWorkspaceInsightAction,
  type Routine,
  type WorkspaceInsightAction,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  WORKSPACE_INSIGHT_CODECS,
  WORKSPACE_INSIGHT_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-insight-v1";
import { Effect } from "effect";
import { InsightQueries } from "../src/backend/database/insight-queries";
import { computeCosts, reportDays, usageWindow } from "../src/backend/insight/insight-costs";
import { InsightService } from "../src/backend/insight/insight-service";
import { InsightStore } from "../src/backend/insight/insight-store";
import { whySlow } from "../src/backend/insight/insight-why-slow";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/insight-e2e");
const checks: string[] = [];
const DAY = 86_400_000;

function today(offset = 0): string {
  return new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
}

/** A fake meta-ads helper: 40 USD a day, and a check that it got the token and the home folder. */
const FAKE_META = `
const args = process.argv.slice(2);
if (process.env.META_ACCESS_TOKEN !== "meta-token-e2e") { console.log(JSON.stringify({ error: { message: "bad token" } })); process.exit(1); }
if (args[0] !== "insights" || !args.includes("--home")) process.exit(2);
const since = args[args.indexOf("--since") + 1];
const until = args[args.indexOf("--until") + 1];
const data = [];
for (let d = new Date(since + "T12:00:00Z"); d.toISOString().slice(0, 10) <= until; d.setUTCDate(d.getUTCDate() + 1))
  data.push({ date_start: d.toISOString().slice(0, 10), spend: "40.00", purchases: 0 });
console.log(JSON.stringify({ currency: "USD", data, totals: {} }));
`;

/** A fake hotmart helper: no sale at all, so the spend-no-sales alert must rise. */
const FAKE_HOTMART = `
const args = process.argv.slice(2);
if (!process.env.HOTMART_CLIENT_ID || !process.env.HOTMART_BASIC) process.exit(1);
if (args[0] !== "summary") process.exit(2);
const sold = require("node:fs").existsSync(args[args.indexOf("--home") + 1] + "/sales.flag");
console.log(JSON.stringify({ data: [{ status: "APPROVED,COMPLETE", by_currency: sold ? { USD: { count: 2, value: 54 } } : {} }] }));
`;

async function serviceFlow(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "insight-e2e-"));
  try {
    const helpers = join(dir, "skills");
    await mkdir(join(helpers, "openbot-meta-ads"), { recursive: true });
    await mkdir(join(helpers, "openbot-hotmart"), { recursive: true });
    await writeFile(join(helpers, "openbot-meta-ads/meta-ads.mjs"), FAKE_META);
    await writeFile(join(helpers, "openbot-hotmart/hotmart.cjs"), FAKE_HOTMART);
    await writeFile(join(helpers, "openbot-hotmart/hotmart.mjs"), 'import "./hotmart.cjs";\n');
    const shared = join(dir, "Spaces/uo/Shared");
    await mkdir(join(shared, "meta-ads"), { recursive: true });
    await mkdir(join(shared, "hotmart"), { recursive: true });
    await writeFile(join(shared, "meta-ads/settings.json"), JSON.stringify({ adAccountId: "act_1" }));
    await writeFile(join(shared, "hotmart/settings.json"), JSON.stringify({ timezone: "UTC" }));

    const spaces = [
      { id: "general", name: "General", slug: "general", icon: null, hue: null, position: 0 },
      { id: "uo", name: "Universidad Online", slug: "uo", icon: null, hue: null, position: 1 },
    ];
    const agents = [
      { id: "agent-a", name: "Ana", spaceId: "uo" },
      { id: "agent-b", name: "Beto", spaceId: "uo" },
    ];
    const channels = new Map<string, { id: string; name: string; archived: boolean }>();
    const posted: { channelId: string; name: string; text: string }[] = [];
    const routines: Routine[] = [
      {
        id: "routine-report",
        agentId: "agent-a",
        name: "Reporte CSO – mañana",
        instruction: "report",
        active: true,
        timezone: "UTC",
        trigger: {
          id: "trigger-report",
          routineId: "routine-report",
          schedule: { kind: "daily", time: "07:00" },
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const decisions: ChannelMessage[] = [];
    let prompt = "";
    let generated = "Ayer todo bien. Revisa [esto](https://evil.example).";
    const queries = {
      usage: () => [],
      answeredTurns: () => new Set<string>(),
      deliveriesSince: () => [
        {
          deliveryId: "d1",
          messageId: "m1",
          agentId: "agent-a",
          status: "completed",
          turnId: "t1",
          createdAt: new Date().toISOString(),
          senderAgentId: null,
        },
      ],
      agentDeliveries: () => [],
      channelRequestDeliveries: () => [],
      queuedBefore: () => 0,
      turn: () => null,
      waits: () => [],
    };
    const store = new InsightStore(join(dir, "insight.json"));
    const service = new InsightService({
      store,
      queries,
      agents: () => agents.map((agent) => ({ id: agent.id, name: agent.name, reportsToAgentId: null })),
      spaces: () => spaces,
      agentSpaceId: (agentId) => agents.find((agent) => agent.id === agentId)?.spaceId ?? "general",
      channelSpaceId: () => "uo",
      sharedDirectory: (space) => (space.id === "uo" ? shared : join(dir, "Spaces/general/Shared")),
      placeChannel: () => undefined,
      channels: {
        exists: (id) => channels.has(id),
        get: (id) => {
          const channel = channels.get(id);
          if (!channel) throw new Error("no channel");
          return channel;
        },
        ids: () => [...channels.keys()],
        decisions: () => decisions,
        createPrivate: ({ channelId, name }) =>
          Effect.sync(() => {
            channels.set(channelId, { id: channelId, name, archived: false });
          }),
        postNotice: (channelId, name, text) => {
          posted.push({ channelId, name, text });
          return true;
        },
      },
      attention: () => [],
      usageLimit: () => null,
      routines: {
        list: (agentId) => routines.filter((routine) => routine.agentId === agentId),
        setActive: (_agentId, routineId, active) => {
          const routine = routines.find((item) => item.id === routineId);
          if (routine) routine.active = active;
        },
      },
      artifacts: () => [],
      owner: () => ({ id: "owner-1", name: "Alejandro Castro" }),
      // One decision from the space's log, which no channel shows.
      loggedDecisions: () =>
        Effect.succeed([
          {
            id: "decision-1",
            spaceId: "general",
            agentId: null,
            decision: "Bajar el curso a 49 USD",
            why: "Tres competidores cobran menos",
            createdAt: new Date().toISOString(),
          },
        ]),
      generate: (text) =>
        Effect.sync(() => {
          prompt = text;
          return generated;
        }),
      helpers: {
        root: helpers,
        node: process.execPath,
        secret: (name) =>
          ({ META_ACCESS_TOKEN: "meta-token-e2e", HOTMART_CLIENT_ID: "id", HOTMART_CLIENT_SECRET: "secret" })[name] ??
          null,
      },
      motion: null,
      hostTimeZone: () => "UTC",
    });
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
    const act = async (action: WorkspaceInsightAction) => {
      // Every action goes through the same decoders as the routes.
      const wire = WORKSPACE_INSIGHT_CODECS.get(WORKSPACE_INSIGHT_ROUTES.action);
      assert.ok(wire);
      const decoded = parseWorkspaceInsightAction(wire.request(action));
      const report = await run(service.apply(decoded));
      return decodeWorkspaceInsight(wire.response(200, JSON.parse(JSON.stringify(report))));
    };

    let report = decodeWorkspaceInsight(
      await run(service.read({ days: 7, timeZone: "America/Bogota", language: "es" })),
    );
    assert.equal(report.briefing.settings.timeZone, "America/Bogota");
    assert.equal(report.briefing.settings.language, "es");
    assert.deepEqual(
      report.briefing.routines.map((routine) => routine.routineId),
      ["routine-report"],
    );
    checks.push("read: the first reader's zone and language become the briefing's; report routines are listed");

    report = await act({
      kind: "goal-save",
      goal: {
        spaceId: "uo",
        title: "Ventas de noviembre",
        metric: "ventas",
        target: 30,
        deadline: today(-10),
        source: "hotmart-sales",
      },
    });
    report = await act({
      kind: "goal-save",
      goal: { spaceId: "uo", title: "Landings", metric: "landings", target: 4, deadline: null, source: "manual" },
    });
    const manual = report.goals.find((goal) => goal.source === "manual");
    assert.ok(manual);
    report = await act({ kind: "goal-progress", goalId: manual.id, value: 2 });
    assert.equal(report.goals.find((goal) => goal.id === manual.id)?.current, 2);
    assert.equal(report.goals.find((goal) => goal.id === manual.id)?.history.at(-1)?.value, 2);
    checks.push("goals: create two, set the manual one's progress, history keeps one point a day");

    const lines = service.goalLines("agent-a");
    assert.equal(lines.length, 2);
    assert.ok(
      lines.every((line) => !line.includes("2 /")),
      "the instructions hold no progress",
    );
    const listed = await run(service.goalTool("agent-a", { action: "list" }));
    assert.equal(listed.goals.length, 2);
    await assert.rejects(
      run(service.goalTool("agent-a", { action: "progress", goalId: report.goals[0]?.id ?? "", value: 3 })),
      /read from hotmart-sales/,
    );
    const moved = await run(
      service.goalTool("agent-b", { action: "progress", goalId: manual.id, value: 3, note: "landing 3" }),
    );
    assert.equal(moved.goals.find((goal) => goal.id === manual.id)?.current, 3);
    assert.equal((await run(service.goalTool("other", { action: "list" }))).goals.length, 0);
    checks.push("agents: one line per goal of their space, the tool lists them and moves only a manual goal");

    report = await act({ kind: "money-sync" });
    const spend = report.money.filter((entry) => entry.kind === "spend");
    assert.equal(spend.length, 7);
    assert.ok(spend.every((entry) => entry.amount === 40 && entry.currency === "USD" && entry.source === "meta"));
    assert.equal(report.sources.find((source) => source.kind === "meta")?.state, "ready");
    assert.equal(report.sources.find((source) => source.kind === "hotmart")?.state, "ready");
    const noSales = report.alerts.find((alert) => alert.kind === "spend-no-sales");
    assert.ok(noSales, "40 USD a day and no sale raises the alert");
    assert.match(noSales.text, /120 USD/u);
    checks.push("money: the Meta and Hotmart helpers run with the shared keys; spend with no sale raises an alert");

    await writeFile(join(shared, "hotmart/sales.flag"), "1");
    report = await act({ kind: "money-sync" });
    assert.equal(
      report.alerts.find((alert) => alert.kind === "spend-no-sales"),
      undefined,
    );
    const sales = report.goals.find((goal) => goal.source === "hotmart-sales");
    assert.ok(sales && sales.current >= 2, "the Hotmart goal follows the synced sales");
    assert.equal(report.money.filter((entry) => entry.kind === "spend").length, 7, "a second sync replaces its days");
    checks.push("money: a sale clears the alert, the Hotmart goal follows it, a sync again replaces its rows");

    report = await act({
      kind: "money-add",
      entry: { spaceId: "uo", date: today(), kind: "spend", amount: 12.5, currency: "eur" },
    });
    const added = report.money.find((entry) => entry.source === "manual");
    assert.equal(added?.currency, "EUR");
    await assert.rejects(run(service.apply({ kind: "money-remove", entryId: spend[0]?.id ?? "" })), /synced row/);
    report = await act({ kind: "money-remove", entryId: added?.id ?? "" });
    assert.equal(report.money.filter((entry) => entry.source === "manual").length, 0);
    checks.push("money: a manual row is added and removed; a synced row cannot be removed");

    report = await act({
      kind: "briefing-save",
      settings: { ...report.briefing.settings, replaceRoutineIds: ["routine-report"] },
    });
    assert.equal(routines[0]?.active, false, "the replaced routine is paused");
    report = await act({ kind: "briefing-send" });
    assert.equal(posted.length, 1);
    assert.ok(posted[0]?.text.startsWith("@[Alejandro Castro](member:owner-1) "), "the briefing mentions the owner");
    assert.ok(!posted[0]?.text.includes("evil.example"), "a link that the facts did not have is refused");
    assert.match(prompt, /Spanish/u);
    assert.match(prompt, /Ventas de noviembre/u);
    assert.match(prompt, /Bajar el curso a 49 USD \(Tres competidores cobran menos\)/u, "the decision log reaches the briefing");
    assert.ok(report.briefing.channelId, "the briefing channel is made once");
    generated =
      "Ayer: 1 tarea terminada y gasto de 40 USD en Universidad Online.\n- Meta Ventas de noviembre en camino";
    await act({ kind: "briefing-send" });
    assert.equal(posted.length, 2);
    assert.equal(posted[1]?.channelId, posted[0]?.channelId, "the same channel takes the next briefing");
    assert.ok(posted[1]?.text.includes("1 tarea terminada"), "the model's text goes out when it passes the check");
    report = await act({
      kind: "briefing-save",
      settings: { ...report.briefing.settings, replaceRoutineIds: [] },
    });
    assert.equal(routines[0]?.active, true, "an unchecked routine is resumed");
    checks.push(
      "briefing: replaces a routine report by pausing it, posts once a day in its channel with a mention, falls back to plain text",
    );

    const reopened = new InsightStore(join(dir, "insight.json"));
    await run(reopened.load());
    assert.equal(reopened.state.goals.length, 2);
    assert.ok(reopened.state.money.length >= 7);
    const raw = JSON.parse(await readFile(join(dir, "insight.json"), "utf8"));
    assert.ok(!JSON.stringify(raw).includes("meta-token-e2e"), "no key is stored");
    checks.push("store: everything survives a reload, and no key is written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The insight reads against a real database, read-only. Prints counts, never row contents. */
function liveDatabase(path: string) {
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    const queries = new InsightQueries({ connection });
    const now = Date.now();
    const days = reportDays(7, "America/Bogota", now);
    const window = usageWindow(reportDays(15, "America/Bogota", now));
    const started = performance.now();
    const rows = queries.usage(window.since, window.until);
    const answered = queries.answeredTurns(window.since);
    const costs = computeCosts({ rows, answered, days, timeZone: "America/Bogota", now, spaceOf: () => "general" });
    const costMs = Math.round(performance.now() - started);
    assert.ok(costs.totalUsd >= 0 && costs.agents.length > 0);
    const deliveries = queries.deliveriesSince(new Date(now - DAY).toISOString());
    const busiest = costs.agents[0]?.agentId ?? "";
    const timeline = decodeWorkspaceWhySlow(
      whySlow(
        {
          queries,
          attention: () => [],
          usageLimit: () => null,
          agentName: () => null,
          now: () => now,
        },
        { agentId: busiest },
      ),
    );
    const channelRow = connection
      .prepare(
        "SELECT a.channel_id AS channel, json_extract(a.assignment_json, '$.requestMessageId') AS message, json_extract(a.assignment_json, '$.agentId') AS agent FROM projection_channel_assignments a ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    const channelTimeline =
      isDynamicRecord(channelRow) &&
      typeof channelRow.channel === "string" &&
      typeof channelRow.message === "string" &&
      typeof channelRow.agent === "string"
        ? whySlow(
            { queries, attention: () => [], usageLimit: () => null, agentName: () => null, now: () => now },
            { agentId: channelRow.agent, channelId: channelRow.channel, messageId: channelRow.message },
          )
        : null;
    checks.push("live database: usage, answers, deliveries and timelines read read-only");
    return {
      usageRows: rows.length,
      costMs,
      agentsWithCost: costs.agents.length,
      weekUsd: costs.weekUsd,
      previousWeekUsd: costs.previousWeekUsd,
      idleUsd: costs.idleUsd,
      sideUsd: costs.sideUsd,
      deliveriesLastDay: deliveries.length,
      timelineSegments: timeline.segments.map((segment) => segment.kind),
      channelTimelineSegments: channelTimeline?.segments.map((segment) => segment.kind) ?? null,
    };
  } finally {
    connection.close();
  }
}

await serviceFlow();
const live = process.env.OPENBOT_INSIGHT_DB ? liveDatabase(process.env.OPENBOT_INSIGHT_DB) : null;
await mkdir(OUT, { recursive: true });
const result = { passed: true, checks, live };
await writeFile(join(OUT, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
