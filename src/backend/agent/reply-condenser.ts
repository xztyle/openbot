import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import type { WorkspaceCondenseSettings } from "@openbot/contracts/ipc";
import { Effect, Option, Result } from "effect";

/**
 * The reply condenser: a cheap post-pass on an agent's answer to people. An answer that is long or
 * shaped like a report (bold labels, status sections, long lists, hashes and code) is rewritten by
 * the workspace gate model the way a colleague texts it, and the message keeps the agent's own text
 * in `condensed.original`. The detectors are the ones of `agent-voice-metrics.py`, which measures
 * the same shapes in production.
 *
 * This module owns the decision, the prompt and the check of the rewrite. It reads no store and
 * changes no message: `AgentService` gives it the answer and applies what it returns.
 */

/** The longest a rewrite may take, from the end of the turn. The original shows until then. */
export const CONDENSE_TIMEOUT_MS = 15_000;
/** An answer with fewer words than this is never condensed, whatever its shape. */
const CONDENSE_MIN_WORDS = 30;
/** The most characters of an answer that the condenser reads. A longer one stays as it is. */
const CONDENSE_MAX_CHARACTERS = 12_000;
/** The most characters of the person's message that the prompt quotes. */
const PERSON_MESSAGE_CHARACTERS = 1_500;
/** The share of an answer in fenced code past which it is code that the person asked for. */
const CODE_SHARE_LIMIT = 0.3;

const CLEAN =
  /\((?:agent|attachment|channel|user|member):[^)]*\)|https?:\/\/\S+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const PATTERNS = {
  boldLabel: /(^|\n)\s*(?:[-*]\s*)?\*\*[^*\n]{1,60}\*\*/gu,
  heading: /^\s*#{1,6}\s/gmu,
  bullet: /^\s*[-*•]\s+\S/gmu,
  numbered: /^\s*\d{1,2}[.)]\s+\S/gmu,
  table: /^\s*\|.*\|\s*$/gmu,
  code: /`[^`\n]+`/gu,
  issueKey: /\b[A-Z]{2,5}-\d{1,4}\b/gu,
  hash: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gu,
  inventory:
    /(^|\n)\s*(?:[-*]\s*)?\*\*\s*(?:Ya listo|Listo|Hecho|Pendientes?|Faltan?|Falta de tu lado|Qué falta|Qué quedó|Siguiente|Próximos? pasos?|Bloque|En curso|Estado|Resumen|Done|Pending|Next|Blocked|Status|In progress|Still to do|Decisi|Riesgo|Lo que más me preocupa|Detalles menores|Choques)/giu,
} as const;
const WORD = /[\p{L}\p{N}_]+/gu;
const FENCE = /```[\s\S]*?(?:```|$)/gu;

/** A person who asks for the long version gets it. */
const DETAIL_ASK = [
  /\b(?:dame|danos|quiero|necesito|m[aá]ndame|p[aá]same|env[ií]ame)\b[^.?!\n]{0,30}\b(?:detalles?|completo|todo)\b/iu,
  /\b(?:en|con) detalle\b|\bdetallad[oa]s?\b|\bpaso a paso\b|\ba fondo\b|\ben profundidad\b|\bversi[oó]n (?:larga|completa)\b/iu,
  /\b(?:reporte|informe|resumen|listado|lista) completo\b/iu,
  /\bfull (?:report|details?|breakdown|list|version|picture|text)\b|\bin (?:depth|detail)\b|\bdetailed\b|\bstep[- ]by[- ]step\b/iu,
  /\b(?:all|every) (?:the )?details?\b|\blong version\b|\bwalk me through\b|\bexplain\b[^.?!\n]{0,30}\b(?:depth|detail|fully|everything)\b/iu,
];
/** A person who asks for a text, a list or code to have gets the whole thing. */
const ARTIFACT_ASK = [
  /\b(?:escr[ií]be(?:me|nos)?|redact[ae](?:me|nos)?|trad[uú]ce(?:me|lo|la)?|reescr[ií]be(?:me|lo|la)?|c[oó]pia(?:me)?|p[eé]ga(?:me)?)\b/iu,
  /\b(?:dame|hazme|haz|genera(?:me)?|prep[aá]rame|arma(?:me)?|m[aá]ndame|p[aá]same)\b[^.?!\n]{0,20}\b(?:copy|texto|textos|guion|gui[oó]n|borrador|correo|email|mensaje|post|anuncio|anuncios|c[oó]digo|script|tabla|lista|plantilla|prompt|descripci[oó]n)\b/iu,
  /\b(?:write|draft|compose|translate|rewrite|paste)\b/iu,
  /\b(?:give|send|show) me\b[^.?!\n]{0,20}\b(?:copy|text|script|draft|email|post|ad|code|table|list|template|prompt|description)\b/iu,
];

export interface CondenseSignals {
  words: number;
  boldLabels: number;
  headings: number;
  listItems: number;
  tableRows: number;
  inventories: number;
  /** Code spans, issue keys and commit hashes together. */
  plumbing: number;
}

/** The shape of an answer, measured as `agent-voice-metrics.py` measures it. */
export function condenseSignals(text: string): CondenseSignals {
  const clean = text.replace(CLEAN, "");
  const count = (pattern: RegExp) => clean.match(pattern)?.length ?? 0;
  return {
    words: clean.match(WORD)?.length ?? 0,
    boldLabels: count(PATTERNS.boldLabel),
    headings: count(PATTERNS.heading),
    listItems: count(PATTERNS.bullet) + count(PATTERNS.numbered),
    tableRows: count(PATTERNS.table),
    inventories: count(PATTERNS.inventory),
    plumbing: count(PATTERNS.code) + count(PATTERNS.issueKey) + count(PATTERNS.hash),
  };
}

/** What makes an answer read as a report rather than a chat message. */
export type CondenseTriggerKind = "words" | "labels" | "inventory" | "list" | "table" | "plumbing";

/** Why an answer is condensed, or null when it reads as a chat message already. */
export function condenseTrigger(signals: CondenseSignals, words: number): CondenseTriggerKind | null {
  if (signals.words < CONDENSE_MIN_WORDS) return null;
  if (signals.words > words) return "words";
  if (signals.boldLabels + signals.headings >= 2) return "labels";
  if (signals.inventories > 0) return "inventory";
  if (signals.listItems > 5) return "list";
  if (signals.tableRows >= 3) return "table";
  if (signals.plumbing > 2) return "plumbing";
  return null;
}

export interface CondenseRequest {
  /** The answer as the agent wrote it. */
  text: string;
  /** The message of a person that the turn answers, when a person started it. */
  personMessage?: string | undefined;
  /** The name of the agent that wrote the answer. */
  writer?: string | undefined;
}

export type CondensePlan = { condense: true; trigger: CondenseTriggerKind } | { condense: false; reason: string };

/**
 * Whether an answer is condensed. Not when it is short and plain, when the person asked for the
 * detail or for a text to have, when it is mostly code, or when it is too long to rewrite safely.
 */
export function planCondense(request: CondenseRequest, settings: WorkspaceCondenseSettings): CondensePlan {
  if (!settings.enabled) return { condense: false, reason: "off" };
  const text = request.text.trim();
  if (!text) return { condense: false, reason: "empty" };
  if (text.length > CONDENSE_MAX_CHARACTERS) return { condense: false, reason: "too-long" };
  const trigger = condenseTrigger(condenseSignals(text), settings.words);
  if (!trigger) return { condense: false, reason: "short" };
  const asked = request.personMessage?.trim() ?? "";
  if (asked && DETAIL_ASK.some((pattern) => pattern.test(asked))) return { condense: false, reason: "detail-asked" };
  if (asked && ARTIFACT_ASK.some((pattern) => pattern.test(asked)))
    return { condense: false, reason: "artifact-asked" };
  const fenced = text.match(FENCE)?.reduce((total, block) => total + block.length, 0) ?? 0;
  if (fenced / text.length > CODE_SHARE_LIMIT) return { condense: false, reason: "code" };
  return { condense: true, trigger };
}

/** The most words of a rewrite: the target, with room for a decision list. */
function wordLimit(settings: WorkspaceCondenseSettings): number {
  return Math.max(70, Math.round(settings.words * 1.2));
}

/** The prompt of one rewrite. The rule is the one of the agents' own instructions, as a strict edit. */
export function condensePrompt(request: CondenseRequest, settings: WorkspaceCondenseSettings): string {
  const person = request.personMessage?.trim().slice(0, PERSON_MESSAGE_CHARACTERS);
  return [
    "You edit one chat message that an AI teammate is about to send to a person in a work chat. Rewrite it the way a colleague texts a colleague: short, spoken, direct.",
    "",
    ...(request.writer?.trim() ? [`The writer is ${request.writer.trim().slice(0, 120)}.`, ""] : []),
    "Rules:",
    "- Write in the language of the message, as the writer speaking to the person. Keep who did what: name whoever did each thing, and use I only for the writer's own work.",
    "- The answer or the main news goes in the first sentence. After it, only what the person must do or decide, or what they would want to know now: a blocker, a risk, a deadline, money.",
    `- Aim for about 60 words, never more than ${wordLimit(settings)}. One to four sentences of plain prose.`,
    '- A decision or request of the person goes early, said plainly, with the teammate\'s default when the message gives one ("say ok and I go with X"). Only when there are two to five separate things the person must do or decide, put them in a numbered list of one short line each, under one lead line. No other lists.',
    "- No bold, headings, tables, status sections (Done/Pending, Hecho/Falta), code formatting, file paths, branch names, commit hashes or IDs. Keep at most one task key such as COC-30, and only where it is the place the person should look.",
    '- Leave out how the work was done, evidence and sources, who reviewed what, internal steps, plans the person need not act on, caveats they cannot act on, and reassurances such as "nothing needed from you" unless that is the whole answer.',
    "- Copy exactly, character for character: every link the person may open (Motion pages, files, any [text](target) link), every mention tag such as @[Name](agent:id), and every number, amount, date or time the person must act on.",
    "- Never add a fact, a promise, a link, a name or a number that is not in the message. Do not answer the message, comment on it, or greet.",
    "",
    "Reply with only the rewritten message.",
    "",
    ...(person ? ["<person_message>", person, "</person_message>", ""] : []),
    "<message>",
    request.text.trim(),
    "</message>",
  ].join("\n");
}

const CAPITALIZED = /\b\p{Lu}[\p{L}]{3,}\b/gu;

/**
 * Whether a rewrite names someone or something that the answer does not: a capitalized word in the
 * middle of a sentence, or one that opens a sentence to address someone ("Carlos, …"), whose first
 * four letters start no word of the answer. Rough on purpose: a rewrite it refuses only leaves the
 * original.
 */
function newNames(original: string, rewrite: string): boolean {
  const stems = new Set((original.match(WORD) ?? []).map((word) => word.slice(0, 4).toLocaleLowerCase()));
  for (const match of rewrite.matchAll(CAPITALIZED)) {
    const word = match[0];
    if (stems.has(word.slice(0, 4).toLocaleLowerCase())) continue;
    const at = match.index ?? 0;
    const opensSentence = /(?:^|[.!?:;\n(«"“—-])\s*$/u.test(rewrite.slice(Math.max(0, at - 4), at)) || at === 0;
    if (!opensSentence || rewrite[at + word.length] === ",") return true;
  }
  return false;
}

/** "Sí," "No." "Yes!": a yes or a no that opens a text as its own word. */
const ANSWER_WORD =
  /^[\s¡¿"«“*_]*(s[ií]|no|yes|yeah|yep|nope|claro|correcto|exacto|vale|ok|okay|sure|right|nah)(?=\s*[,.!:;—-]|\s*$)/iu;

/**
 * Whether a rewrite opens with a yes or a no that the answer does not open with, such as a leading
 * "Sí," on an answer that never said yes: it would answer a question that the agent did not answer.
 */
function newAnswerWord(original: string, rewrite: string): boolean {
  const added = ANSWER_WORD.exec(rewrite)?.[1];
  if (!added) return false;
  const own = ANSWER_WORD.exec(original)?.[1];
  const plain = (word: string) => word.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  return own === undefined || plain(own) !== plain(added);
}

/** Words of the prompt that a rewrite has only when it talks about the prompt. */
const PROMPT_WORDS = [
  /\bteammate\b/iu,
  /\bKEEP\b/u,
  /<\/?(?:message|person_message)>/iu,
  /\bprimera persona\b/iu,
  /\bfirst person\b/iu,
];

const URL = /https?:\/\/[^\s)<>\]"']+/giu;
const LINK_TARGET = /\]\(([^)\s]+)\)/gu;

/** The links and tags of a text that a rewrite must keep: tags, file links and Motion pages. */
function keptReferences(text: string): Set<string> {
  const kept = new Set<string>();
  for (const reference of chatTagReferences(text))
    if (reference.kind === "agent" || reference.kind === "member" || reference.kind === "channel")
      kept.add(text.slice(reference.start, reference.end));
  for (const match of text.matchAll(LINK_TARGET)) {
    const target = match[1] ?? "";
    if (/^(?:attachment|file|channel|member|agent):/iu.test(target)) kept.add(target);
  }
  for (const match of text.matchAll(URL)) if (/\bmotion\./iu.test(match[0])) kept.add(trimUrl(match[0]));
  return kept;
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

/** Every URL and tag of a text, to find one that a rewrite made up. */
function allReferences(text: string): Set<string> {
  const found = new Set<string>();
  for (const reference of chatTagReferences(text)) found.add(text.slice(reference.start, reference.end));
  for (const match of text.matchAll(URL)) found.add(trimUrl(match[0]));
  return found;
}

export type CondenseOutcome =
  | { kind: "condensed"; text: string }
  | {
      kind: "kept";
      reason:
        | "keep"
        | "empty"
        | "not-shorter"
        | "too-long"
        | "still-report"
        | "prompt-echo"
        | "new-answer"
        | "new-name"
        | "lost-link"
        | "new-link";
    };

/**
 * The rewrite that replaces the answer, or why the answer stays as it is: the model said KEEP, the
 * rewrite is not shorter, it dropped a link or a mention the person needs, or it named one that the
 * answer does not have.
 */
export function checkRewrite(original: string, output: string, settings: WorkspaceCondenseSettings): CondenseOutcome {
  let text = output.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/u.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  text = text
    .replace(/^<message>\s*/u, "")
    .replace(/\s*<\/message>$/u, "")
    .trim();
  if (/^["'«“]?KEEP[.!"'»”]?$/u.test(text)) return { kind: "kept", reason: "keep" };
  if (!text) return { kind: "kept", reason: "empty" };
  const words = condenseSignals(text).words;
  if (words >= condenseSignals(original).words) return { kind: "kept", reason: "not-shorter" };
  if (words > wordLimit(settings) * 1.25) return { kind: "kept", reason: "too-long" };
  const shape = condenseSignals(text);
  if (shape.boldLabels + shape.headings + shape.inventories > 0 || shape.plumbing > 2)
    return { kind: "kept", reason: "still-report" };
  if (newNames(original, text)) return { kind: "kept", reason: "new-name" };
  if (newAnswerWord(original, text)) return { kind: "kept", reason: "new-answer" };
  // A small model sometimes answers the instructions instead of only following them.
  for (const word of PROMPT_WORDS)
    if (word.test(text) && !word.test(original)) return { kind: "kept", reason: "prompt-echo" };
  for (const reference of keptReferences(original))
    if (!text.includes(reference)) return { kind: "kept", reason: "lost-link" };
  const known = allReferences(original);
  for (const reference of allReferences(text))
    if (!known.has(reference) && ![...known].some((value) => value.startsWith(reference)))
      return { kind: "kept", reason: "new-link" };
  return { kind: "condensed", text };
}

/** The cheap model: one toolless generation, as the channel answer gate runs it. */
export interface CondenseModel {
  label: string;
  generate(prompt: string, deadline: number): Effect.Effect<string, unknown>;
}

export type CondenseResult =
  | CondenseOutcome
  | { kind: "kept"; reason: "timeout" | "error" }
  | { kind: "skipped"; reason: string };

/**
 * Runs one rewrite within `timeoutMs`. It never fails: a model that fails, is late or writes an
 * unusable rewrite leaves the answer as the agent wrote it.
 */
export function condenseAnswer(
  request: CondenseRequest,
  settings: WorkspaceCondenseSettings,
  model: CondenseModel,
  timeoutMs = CONDENSE_TIMEOUT_MS,
): Effect.Effect<CondenseResult> {
  return Effect.gen(function* () {
    const plan = planCondense(request, settings);
    if (!plan.condense) return { kind: "skipped", reason: plan.reason } as const;
    const deadline = Date.now() + timeoutMs;
    const outcome = yield* Effect.result(model.generate(condensePrompt(request, settings), deadline)).pipe(
      Effect.timeoutOption(timeoutMs),
    );
    if (Option.isNone(outcome)) return { kind: "kept", reason: "timeout" } as const;
    if (Result.isFailure(outcome.value)) return { kind: "kept", reason: "error" } as const;
    return checkRewrite(request.text, outcome.value.success, settings);
  });
}
