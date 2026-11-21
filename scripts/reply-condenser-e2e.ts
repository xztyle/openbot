// Runs the reply condenser end to end on the real modules: the real decision, prompt and check of
// `reply-condenser.ts` on a model that answers as the gate model does, and the real Team API codecs
// carrying a condensed answer as a host sends it (conversation page, conversation event, workspace
// channel page, workspace settings). No provider or account is used by default.
//
// `bun scripts/reply-condenser-e2e.ts [--samples=<file.json>] [--live]`
// `--samples` names a JSON list of `{ bucket, agent, text, person }` (real answers, such as the ones
// `agent-voice-metrics.py` measures); each one is run through the condenser. Without `--live` a fake
// model answers; with it, the local `claude` CLI runs the workspace gate model (`claude-haiku-5-5`),
// the same model and toolless call the host uses.
// Writes .openbot-build/reply-condenser-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ChannelMessage,
  type ConversationMessage,
  type ConversationPage,
  DEFAULT_WORKSPACE_CONDENSE,
  DEFAULT_WORKSPACE_SETTINGS,
  decodeWorkspaceSettings,
  isChannelMessage,
  isConversationMessage,
  withKeptAgentChannelDefaults,
} from "@openbot/contracts/ipc";
import { CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/channels-v1";
import {
  decodeTeamProtocolV8CurrentHttpResponse,
  encodeTeamProtocolV8CurrentHttpResponse,
} from "@openbot/contracts/team-protocol/v8-adapter";
import {
  decodeTeamProtocolV8BaseCurrentEvent,
  encodeTeamProtocolV8BaseCurrentEvent,
} from "@openbot/contracts/team-protocol/v8-base-adapter";
import {
  WORKSPACE_CODECS,
  WORKSPACE_ROUTES,
  withWorkspaceChannels,
} from "@openbot/contracts/team-protocol/workspace-v1";
import { Effect } from "effect";
import {
  type CondenseModel,
  type CondenseResult,
  condenseAnswer,
  condensePrompt,
  condenseSignals,
  condenseTrigger,
} from "../src/backend/agent/reply-condenser";

const OUT = resolve(import.meta.dirname, "../.openbot-build/reply-condenser-e2e");
const PAGE_PATH = "/v1/agents/agent-1/conversation-page";
const settings = DEFAULT_WORKSPACE_CONDENSE;
const args = process.argv.slice(2);
const samplesPath = args.find((arg) => arg.startsWith("--samples="))?.slice("--samples=".length);
const live = args.includes("--live");

const steps: Array<{ step: string; result: unknown }> = [];
async function step(name: string, run: () => unknown): Promise<void> {
  try {
    steps.push({ step: name, result: (await run()) ?? "ok" });
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    steps.push({ step: name, result: { failed: error instanceof Error ? error.message : String(error) } });
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A model that answers `text` after `delayMs`, or fails. */
function fake(answer: string | Error, delayMs = 0): CondenseModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    label: "fake/condenser",
    prompts,
    generate: (prompt) => {
      prompts.push(prompt);
      return Effect.sleep(delayMs).pipe(
        Effect.andThen(answer instanceof Error ? Effect.fail(answer) : Effect.succeed(answer)),
      );
    },
  };
}

const run = (request: { text: string; personMessage?: string }, model: CondenseModel, timeoutMs?: number) =>
  Effect.runPromise(condenseAnswer(request, settings, model, timeoutMs));

const MOTION = "https://motion.delynith.com/w/cocina/COC-30";
const REPORT = [
  "Ya dejé el copy rehaciéndose y la regla grabada. Aún no hay texto nuevo; el Creativo lo rehace hoy.",
  "",
  "**Diagnóstico:** el copy anterior abría con el producto y no con el problema, y no tenía gancho en la primera línea.",
  "",
  "**Esto es lo que quedó grabado:**",
  "- **Guía:** gancho en la primera línea, una sola promesa, prueba social con número (ver `brief-copy.md`).",
  "- **Skill:** `copy-anuncios-meta`, instalada en el Creativo, el Media Buyer y el Líder de Nicho.",
  "- **Perfiles y rol:** el Creativo firma el copy; Cumplimiento lo revisa antes de publicar (commit 6fce514a).",
  "",
  `El Creativo rehace las tres versiones antes de las 18:00 y te las paso para que elijas; todo está en ${MOTION}.`,
  "Los límites de gasto siguen igual: 56 USD en COC-34 hasta que digas otra cosa.",
  "@[Creativo de Anuncios](agent:agent-creativo)",
].join("\n");
const SHORT_REWRITE = `Ya está la regla grabada en todos los que hacen copy, y el Creativo rehace las tres versiones antes de las 18:00 para que elijas una (${MOTION}). @[Creativo de Anuncios](agent:agent-creativo) El gasto sigue en 56 USD hasta que digas otra cosa.`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await step("the detectors of agent-voice-metrics.py see the report shape", () => {
  const signals = condenseSignals(REPORT);
  assert.ok(signals.boldLabels >= 2, "bold labels");
  assert.ok(signals.plumbing >= 3, "code spans, keys and hashes");
  assert.equal(condenseTrigger(signals, settings.words), "words");
  const short = condenseSignals(
    "Sí, ya está publicada. Te paso el enlace cuando Infra termine de revisarla, hoy antes de las seis.",
  );
  assert.equal(condenseTrigger(short, settings.words), null);
  return signals;
});

await step("a long report answer to a person is rewritten, and the original is kept by the caller", async () => {
  const model = fake(SHORT_REWRITE);
  const result = await run(
    { text: REPORT, personMessage: "el copy es muy malo, investiga y que quede grabado" },
    model,
  );
  assert.equal(result.kind, "condensed");
  assert(result.kind === "condensed");
  assert.equal(result.text, SHORT_REWRITE);
  assert.ok(model.prompts[0]?.includes("<person_message>"), "the prompt quotes the person");
  assert.ok(model.prompts[0]?.includes(REPORT), "the prompt holds the whole answer");
  return { words: condenseSignals(result.text).words };
});

await step("KEEP from the model leaves the answer", async () => {
  const result = await run({ text: REPORT }, fake("KEEP"));
  assert.deepEqual(result, { kind: "kept", reason: "keep" });
});

await step("a model that is late or fails leaves the answer", async () => {
  const late = await run({ text: REPORT }, fake(SHORT_REWRITE, 2_000), 200);
  assert.deepEqual(late, { kind: "kept", reason: "timeout" });
  const failed = await run({ text: REPORT }, fake(new Error("provider down")));
  assert.deepEqual(failed, { kind: "kept", reason: "error" });
});

await step(
  "a rewrite that drops a link or mention, invents a link or a name, adds a yes or no, echoes the prompt or keeps the report shape is refused",
  async () => {
    const noLink = await run({ text: REPORT }, fake(SHORT_REWRITE.replace(` (${MOTION})`, "")));
    assert.deepEqual(noLink, { kind: "kept", reason: "lost-link" });
    const noMention = await run(
      { text: REPORT },
      fake(SHORT_REWRITE.replace("@[Creativo de Anuncios](agent:agent-creativo) ", "")),
    );
    assert.deepEqual(noMention, { kind: "kept", reason: "lost-link" });
    const invented = await run({ text: REPORT }, fake(`${SHORT_REWRITE} Más en https://example.com/inventado`));
    assert.deepEqual(invented, { kind: "kept", reason: "new-link" });
    const named = await run({ text: REPORT }, fake(SHORT_REWRITE.replace("El gasto", "Carlos, el gasto")));
    assert.deepEqual(named, { kind: "kept", reason: "new-name" });
    const echoed = await run({ text: REPORT }, fake(`Como teammate te cuento: ${SHORT_REWRITE}`));
    assert.deepEqual(echoed, { kind: "kept", reason: "prompt-echo" });
    const affirmed = await run({ text: REPORT }, fake(`Sí, ${SHORT_REWRITE}`));
    assert.deepEqual(affirmed, { kind: "kept", reason: "new-answer" });
    const denied = await run({ text: REPORT }, fake(`No. ${SHORT_REWRITE}`));
    assert.deepEqual(denied, { kind: "kept", reason: "new-answer" });
    const kept = await run({ text: `Sí, ${REPORT}` }, fake(`Sí, ${SHORT_REWRITE}`));
    assert.equal(kept.kind, "condensed", "a yes that the answer opens with stays");
    const labelled = await run({ text: REPORT }, fake(`**Estado:** ${SHORT_REWRITE}`));
    assert.deepEqual(labelled, { kind: "kept", reason: "still-report" });
    const longer = await run({ text: REPORT }, fake(`${REPORT}\nY algo más.`));
    assert.deepEqual(longer, { kind: "kept", reason: "not-shorter" });
  },
);

await step("a person who asks for the detail, a text or code gets the whole answer, without a model call", async () => {
  const cases: Array<[string, string]> = [
    ["dame el detalle completo de lo que hizo el scout", "detail-asked"],
    ["give me the full report", "detail-asked"],
    ["explain in depth why the build failed", "detail-asked"],
    ["escríbeme el copy de los tres anuncios", "artifact-asked"],
    ["write me the landing copy", "artifact-asked"],
  ];
  for (const [personMessage, reason] of cases) {
    const model = fake(SHORT_REWRITE);
    const result = await run({ text: REPORT, personMessage }, model);
    assert.deepEqual(result, { kind: "skipped", reason }, personMessage);
    assert.equal(model.prompts.length, 0);
  }
  const code = `Aquí está:\n\n\`\`\`ts\n${"const value = compute(input);\n".repeat(30)}\`\`\`\n\nLo probé en local y pasa.`;
  assert.deepEqual(await run({ text: code }, fake(SHORT_REWRITE)), { kind: "skipped", reason: "code" });
  assert.deepEqual(
    await Effect.runPromise(condenseAnswer({ text: REPORT }, { enabled: false, words: 90 }, fake(SHORT_REWRITE))),
    { kind: "skipped", reason: "off" },
  );
});

// The wire: a condensed answer as a host sends it to the current client.
const condensedMessage: ConversationMessage = {
  id: "answer-1",
  turnId: "turn-1",
  author: "assistant",
  text: SHORT_REWRITE,
  createdAt: "2026-11-20T22:48:52.384Z",
  status: "completed",
  itemType: "agentMessage",
  condensed: { original: REPORT },
};
const page: ConversationPage = {
  agentId: "agent-1",
  threadId: "thread-1",
  activeTurnId: null,
  revision: 3,
  messages: [condensedMessage],
  references: { quoted: { ...condensedMessage, id: "quoted" } },
  pageInfo: { hasOlder: false, olderCursor: null },
};

await step("protocol 8: a conversation page and a conversation event carry the original", () => {
  const encoded = encodeTeamProtocolV8CurrentHttpResponse("GET", PAGE_PATH, 200, page, { preserveSemanticTags: true });
  const decoded = decodeTeamProtocolV8CurrentHttpResponse("GET", PAGE_PATH, 200, JSON.parse(encoded));
  assert(decoded && typeof decoded === "object" && !Array.isArray(decoded));
  const [message] = Array.isArray(decoded.messages) ? decoded.messages : [];
  assert.ok(isConversationMessage(message));
  assert.equal(message.text, SHORT_REWRITE);
  assert.deepEqual(message.condensed, { original: REPORT });
  const references = decoded.references;
  assert(references && typeof references === "object" && !Array.isArray(references));
  assert.ok(isConversationMessage(references.quoted) && references.quoted.condensed?.original === REPORT);

  const event = encodeTeamProtocolV8BaseCurrentEvent(
    { type: "conversation-page", page },
    { preserveSemanticTags: true },
  );
  assert.ok(event);
  const read = decodeTeamProtocolV8BaseCurrentEvent(JSON.parse(event));
  assert(read.kind === "known" && read.event.type === "conversation-page");
  assert.deepEqual(read.event.page.messages[0]?.condensed, { original: REPORT });

  const bad = { ...page, messages: [{ ...condensedMessage, condensed: { original: "" } }] };
  assert.throws(() => encodeTeamProtocolV8CurrentHttpResponse("GET", PAGE_PATH, 200, bad));
  return { pageBytes: encoded.length, eventBytes: event.length };
});

await step("workspace wire: a channel page carries the original beside the frozen message", () => {
  const entry: ChannelMessage = {
    id: "answer-1",
    channelId: "channel-1",
    sequence: 7,
    author: { kind: "agent", id: "agent-1", name: "CSO - Director de Ventas" },
    taskId: "task-1",
    superseded: false,
    message: condensedMessage,
    condensed: { original: REPORT },
  };
  assert.ok(isChannelMessage(entry));
  const projected = withWorkspaceChannels(
    CHANNEL_ROUTES.read,
    { messages: [{ id: entry.id }] },
    { channel: {}, messages: [entry] },
  );
  assert(projected && typeof projected === "object" && !Array.isArray(projected));
  const [message] = Array.isArray(projected.messages) ? projected.messages : [];
  assert(message && typeof message === "object" && !Array.isArray(message));
  assert.deepEqual(message.condensed, { original: REPORT });
});

await step("workspace settings: the condenser setting saves, decodes and is kept by an older client", () => {
  const codec = WORKSPACE_CODECS.get(WORKSPACE_ROUTES.settingsUpdate);
  assert.ok(codec);
  const next = { ...DEFAULT_WORKSPACE_SETTINGS, condense: { enabled: false, words: 150 } };
  const wire = codec.request(JSON.parse(JSON.stringify(next)));
  const decoded = decodeWorkspaceSettings(wire);
  assert.deepEqual(decoded.condense, { enabled: false, words: 150 });
  const fromOlderClient = decodeWorkspaceSettings(JSON.parse(JSON.stringify(DEFAULT_WORKSPACE_SETTINGS)));
  assert.deepEqual(withKeptAgentChannelDefaults(decoded, fromOlderClient).condense, { enabled: false, words: 150 });
  assert.throws(() => decodeWorkspaceSettings({ ...next, condense: { enabled: true, words: 5 } }));
});

/** One rewrite on the local Claude CLI, as the host's toolless gate call runs it. */
function claudeModel(): CondenseModel {
  return {
    label: "claude/claude-haiku-5-5 (local CLI)",
    generate: (prompt) =>
      Effect.tryPromise(
        () =>
          new Promise<string>((done, fail) => {
            const env = { ...process.env };
            delete env.CLAUDECODE;
            const child = spawn("claude", ["-p", "--model", "claude-haiku-5-5", "--effort", "low", "--tools", ""], {
              env,
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk) => {
              out += String(chunk);
            });
            child.stderr.on("data", (chunk) => {
              err += String(chunk);
            });
            child.on("error", fail);
            child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(err || `exit ${code}`))));
            child.stdin.end(prompt);
          }),
      ),
  };
}

const SECRETISH =
  /\b(?:pass(?:word)?|token|secret|clave|contraseña)\b\s*[:=]?\s*\S+|\b[A-Za-z0-9_-]*pass[A-Za-z0-9_-]*\d+\b/giu;
const redact = (text: string | undefined) => text?.replace(SECRETISH, "[redacted]");

const samples: Array<{ bucket: string; agent: string; text: string; person?: string | null }> = samplesPath
  ? JSON.parse(await readFile(samplesPath, "utf8"))
  : [];
interface Pair {
  bucket: string;
  agent: string;
  person: string | undefined;
  before: string | undefined;
  beforeWords: number;
  outcome: string;
  ms: number;
  after?: string | undefined;
  afterWords?: number;
}
const pairs: Pair[] = [];
if (samples.length > 0)
  await step(
    `${samples.length} real answers through the condenser (${live ? "live gate model" : "fake model"})`,
    async () => {
      const model = live ? claudeModel() : fake("KEEP");
      const outcomes: Record<string, number> = {};
      for (const sample of samples) {
        const started = Date.now();
        const request = {
          text: sample.text,
          writer: sample.agent,
          ...(sample.person ? { personMessage: sample.person } : {}),
        };
        const result: CondenseResult = await Effect.runPromise(
          condenseAnswer(request, settings, model, live ? 30_000 : undefined),
        );
        const key = result.kind === "condensed" ? "condensed" : result.reason;
        outcomes[key] = (outcomes[key] ?? 0) + 1;
        pairs.push({
          bucket: sample.bucket,
          agent: sample.agent,
          person: redact(sample.person ?? undefined),
          before: redact(sample.text),
          beforeWords: condenseSignals(sample.text).words,
          outcome: key,
          ms: Date.now() - started,
          ...(result.kind === "condensed"
            ? { after: redact(result.text), afterWords: condenseSignals(result.text).words }
            : {}),
        });
      }
      return outcomes;
    },
  );

await writeFile(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ passed: true, live, steps, prompt: condensePrompt({ text: "<the answer>", personMessage: "<the person's message>" }, settings), pairs }, null, 2)}\n`,
);
process.stdout.write(`report: ${resolve(OUT, "report.json")}\n`);
