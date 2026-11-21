// Checks that a provider history import keeps an answer that the reply condenser shortened as one
// answer. The live case: a Claude agent answered, the condenser replaced the answer's text and kept
// the agent's own text on it, and OpenBot restarted. The restart's history backfill
// (`BootRecovery` -> `mergeProviderHistoryMessages`) read the answer again from Claude's session
// under the session's message ID, found that its text did not start with the short text, and stored
// it beside the answer: the chat showed the original and the condensed text one under the other.
//
// - claude: the import of a condensed answer matches it by its original, and the answer keeps its
//   short text and its original.
// - claude-repair: a database that already holds that copy turns the copy into commentary, so the
//   chat shows one answer again.
// - codex-same-id: an import under the answer's own ID keeps the short text.
// - codex-other-id: an import under another ID is the repeat and goes.
//
// `bun scripts/condensed-history-merge-e2e.ts`. Writes .openbot-build/condensed-history-merge-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { mergeProviderHistoryMessages } from "../src/backend/conversation-snapshots";

const OUT = resolve(import.meta.dirname, "../.openbot-build/condensed-history-merge-e2e");
const TURN = "turn-7174";
const ORIGINAL =
  "Estoy en pausa: no he creado la página de Facebook ni fijado el tope.\n\nHasta ahora solo leí la cuenta por API.\n\nYa envié al CSO el resultado en tres líneas.";
const SHORT = "Sigo en pausa: no hay página ni tope. Ya envié el resultado al CSO.";

const prompt: ConversationMessage = {
  id: "delivery-1",
  turnId: TURN,
  author: "user",
  source: "user",
  text: "Atelier note",
  createdAt: "2026-11-21T00:33:00.000Z",
  status: "completed",
};
const condensedAnswer = (id: string): ConversationMessage => ({
  id,
  turnId: TURN,
  author: "assistant",
  itemType: "agentMessage",
  text: SHORT,
  condensed: { original: ORIGINAL },
  createdAt: "2026-11-21T00:37:59.000Z",
  status: "completed",
});
const importedAnswer = (id: string): ConversationMessage => ({
  id,
  turnId: TURN,
  author: "assistant",
  itemType: "agentMessage",
  text: ORIGINAL,
  createdAt: "2026-11-21T00:37:59.230Z",
  status: "completed",
});

/** The rows that the chat draws as answers: assistant text that is not commentary. */
function bubbles(messages: readonly ConversationMessage[]) {
  return messages.filter((message) => message.author === "assistant" && message.itemType !== "commentary");
}

function checkOneCondensedAnswer(messages: readonly ConversationMessage[]) {
  const answers = bubbles(messages);
  assert.equal(answers.length, 1, `The chat shows ${answers.length} answers: ${JSON.stringify(answers)}`);
  assert.equal(answers[0]?.text, SHORT, "The answer lost its condensed text.");
  assert.equal(answers[0]?.condensed?.original, ORIGINAL, "The answer lost its original.");
  return answers[0]?.id;
}

const report: { cases: Record<string, string | undefined>; passed: boolean } = { cases: {}, passed: false };
try {
  const claudeId = `${TURN}:assistant`;
  report.cases.claude = checkOneCondensedAnswer(
    mergeProviderHistoryMessages([prompt, condensedAnswer(claudeId)], [prompt, importedAnswer("uuid-1")], "claude"),
  );

  const repaired = mergeProviderHistoryMessages(
    [prompt, condensedAnswer(claudeId), importedAnswer("uuid-1")],
    [prompt, importedAnswer("uuid-1")],
    "claude",
  );
  report.cases["claude-repair"] = checkOneCondensedAnswer(repaired);
  assert.equal(repaired.find((message) => message.id === "uuid-1")?.itemType, "commentary");

  report.cases["codex-same-id"] = checkOneCondensedAnswer(
    mergeProviderHistoryMessages([prompt, condensedAnswer("item-1")], [prompt, importedAnswer("item-1")], "codex"),
  );
  report.cases["codex-other-id"] = checkOneCondensedAnswer(
    mergeProviderHistoryMessages([prompt, condensedAnswer("item-1")], [prompt, importedAnswer("item-2")], "codex"),
  );

  // An answer that nobody condensed still takes the provider's text, as before.
  const plain = mergeProviderHistoryMessages(
    [prompt, { ...importedAnswer(claudeId), text: "Estoy en pausa" }],
    [prompt, importedAnswer("uuid-1")],
    "claude",
  );
  assert.deepEqual(
    bubbles(plain).map((message) => [message.id, message.text]),
    [[claudeId, ORIGINAL]],
  );
  report.cases.plain = "kept";
  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
createOpenBotLogger("condensed-history-merge-e2e").info(
  `${report.passed ? "Passed" : "Failed"}: ${resolve(OUT, "report.json")}`,
);
