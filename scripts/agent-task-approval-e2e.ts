// Runs an approval of an agent task end to end in this worktree's running dev app, through the real
// preload bridge, IPC, agent service and provider. It changes the data of the profile, so start the app
// with `bun run dev` (never `--shared`), and pass the id of an agent whose provider is signed in:
// `bun scripts/agent-task-approval-e2e.ts --allow-mutations --agent=<agent id>`.
//
// The agent gets Workspace only access, so a write outside its workspace asks the user. Each task asks
// the agent to write a file in the home folder. The script checks that the approval has the task's
// thread, that the task chip and the task panel show it, that Deny leaves no file and that Allow writes
// it. At the end it stops and closes its tasks, deletes the file and gives the agent its access back.
// Writes .openbot-build/agent-task-approval-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentApproval,
  type AgentTask,
  type AgentTasksSnapshot,
  type ClientAgentSummary,
  DEFAULT_AGENT_ACCESS,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

// The page functions below run in the app window, where the preload bridge sets this.
declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
    taskApprovalE2e?: AgentApproval[];
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-task-approval-e2e");
const argument = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const agentArgument = argument("agent");
assert.ok(agentArgument, "Pass --agent=<agent id> of an agent whose provider is signed in.");
const agentId: string = agentArgument;
const WAIT_MS = 180_000;

interface Decision {
  taskId: string;
  approvalThreadMatches: boolean;
  stateWhileWaiting: string;
  spinnerHidden: boolean;
  stateAfter: string;
  fileExists: boolean;
}

interface Report {
  agentId: string;
  provider?: string;
  deny?: Decision;
  allow?: Decision;
  restored?: { access: string };
  passed: boolean;
}

const report: Report = { agentId, passed: false };
const started: string[] = [];
const files: string[] = [];

const instances = readDevInstanceRecords().filter(
  (record) => record.service === "app" && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.equal(instances.length, 1, "Start one dev app for this worktree first.");
const instance = instances[0];
assert.ok(instance);
assertMutationAllowed({
  command: "agent-task-approval-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const session = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("agent-task-approval-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const page = session.page;
mkdirSync(OUT, { recursive: true });

function listTasks(): Promise<AgentTasksSnapshot> {
  return page.evaluate((id) => window.openbot.agent.listTasks(id), agentId);
}

function readAgent(): Promise<ClientAgentSummary> {
  return page.evaluate(async (id) => {
    const agent = (await window.openbot.agent.listAgents()).find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }, agentId);
}

const taskIn = (snapshot: AgentTasksSnapshot, taskId: string): AgentTask => {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task, `Task ${taskId} is not in the list.`);
  return task;
};

/**
 * Waits in the page until none of these tasks runs. It listens for `agent-tasks-changed` before it
 * reads the list, so a change between the two is not lost.
 */
function waitForTasksStopped(label: string, taskIds: readonly string[]): Promise<AgentTasksSnapshot> {
  return page.evaluate(
    ({ id, ids, name, timeout }) =>
      new Promise<AgentTasksSnapshot>((resolveSnapshot, reject) => {
        const stopped = (snapshot: AgentTasksSnapshot) =>
          ids.every((taskId) => snapshot.tasks.find((task) => task.id === taskId)?.state !== "running");
        const deadline = setTimeout(() => finish(new Error(`Timed out: ${name}.`)), timeout);
        const unsubscribe = window.openbot.agent.onEvent((event) => {
          if (event.type === "agent-tasks-changed" && event.snapshot.agentId === id && stopped(event.snapshot)) {
            finish(event.snapshot);
          }
        });
        window.openbot.agent.listTasks(id).then((snapshot) => {
          if (stopped(snapshot)) finish(snapshot);
        }, finish);
        function finish(result: AgentTasksSnapshot | Error) {
          clearTimeout(deadline);
          unsubscribe();
          if (result instanceof Error) reject(result);
          else resolveSnapshot(result);
        }
      }),
    { id: agentId, ids: taskIds, name: label, timeout: WAIT_MS },
  );
}

/**
 * Waits in the page for the approval event of the task's thread. A task list event that shows the task
 * ended first fails the wait, because the provider did not ask.
 */
function waitForApproval(task: AgentTask): Promise<AgentApproval> {
  return page.evaluate(
    ({ id, threadId, taskId, timeout }) =>
      new Promise<AgentApproval>((resolveApproval, reject) => {
        const ofTask = (approval: AgentApproval) => approval.agentId === id && approval.threadId === threadId;
        const seen = window.taskApprovalE2e?.find(ofTask);
        if (seen) {
          resolveApproval(seen);
          return;
        }
        const deadline = setTimeout(() => finish(new Error(`No approval arrived for task ${taskId}.`)), timeout);
        const unsubscribe = window.openbot.agent.onEvent((event) => {
          if (event.type === "approval" && ofTask(event.approval)) finish(event.approval);
          if (event.type === "agent-tasks-changed" && event.snapshot.agentId === id) {
            const current = event.snapshot.tasks.find((candidate) => candidate.id === taskId);
            if (current && current.state !== "running" && current.state !== "queued") {
              finish(new Error(`The task ended with no approval: ${JSON.stringify(current)}`));
            }
          }
        });
        function finish(result: AgentApproval | Error) {
          clearTimeout(deadline);
          unsubscribe();
          if (result instanceof Error) reject(result);
          else resolveApproval(result);
        }
      }),
    { id: agentId, threadId: task.threadId, taskId: task.id, timeout: WAIT_MS },
  );
}

/** Starts a task that writes outside the workspace, answers its approval in the task panel, and reads the result. */
async function decide(decision: "Deny" | "Allow"): Promise<Decision> {
  const file = join(homedir(), `openbot-task-approval-${randomUUID()}.txt`);
  files.push(file);
  const task = await page.evaluate(
    ({ id, prompt }) =>
      window.openbot.agent.startTask({ agentId: id, text: prompt, clientMessageId: crypto.randomUUID() }),
    {
      id: agentId,
      prompt: `Create the file ${file} with the text ok. Run the shell command with escalated permissions so that I get an approval request.`,
    },
  );
  started.push(task.id);
  const approval = await waitForApproval(task);
  const waiting = taskIn(await listTasks(), task.id);

  const chip = page.getByRole("button", { name: `Open task ${waiting.title}, Waiting for your approval` });
  await chip.waitFor({ timeout: WAIT_MS });
  await chip.click();
  const panel = page.getByRole("complementary", { name: `Task ${waiting.title}`, exact: true });
  const card = panel.getByRole("region", { name: "Agent approval", exact: true });
  await card.waitFor({ timeout: WAIT_MS });
  const spinnerHidden = (await panel.getByText("Making the requested changes").count()) === 0;
  await panel.screenshot({ path: resolve(OUT, `${decision.toLowerCase()}-waiting.png`) });
  await card.getByRole("button", { name: decision, exact: true }).click();
  await card.waitFor({ state: "detached", timeout: WAIT_MS });

  const ended = await waitForTasksStopped("the task leaves running", [task.id]);
  await panel.screenshot({ path: resolve(OUT, `${decision.toLowerCase()}-after.png`) });
  return {
    taskId: task.id,
    approvalThreadMatches: approval.threadId === task.threadId,
    stateWhileWaiting: waiting.state,
    spinnerHidden,
    stateAfter: taskIn(ended, task.id).state,
    fileExists: existsSync(file),
  };
}

const before = await readAgent();
report.provider = before.provider;
const originalAccess = before.access ?? DEFAULT_AGENT_ACCESS;

try {
  await page.evaluate((id) => window.openbot.agent.updateAgent({ agentId: id, access: "workspace" }), agentId);
  await page.evaluate(() => {
    window.taskApprovalE2e = [];
    window.openbot.agent.onEvent((event) => {
      if (event.type === "approval") window.taskApprovalE2e?.push(event.approval);
    });
  });
  // The task chips show under the agent's own chat.
  const chats = page.getByRole("navigation", { name: "Chat list" });
  await chats.getByRole("button").filter({ hasText: before.name }).first().click();
  await page
    .getByRole("main", { name: "Conversation" })
    .getByRole("heading", { level: 1, name: before.name, exact: true })
    .waitFor();

  report.deny = await decide("Deny");
  assert.ok(report.deny.approvalThreadMatches);
  assert.equal(report.deny.stateWhileWaiting, "running");
  assert.ok(report.deny.spinnerHidden, "The panel showed the progress spinner while the approval waited.");
  assert.equal(report.deny.fileExists, false, "Deny still wrote the file.");

  report.allow = await decide("Allow");
  assert.ok(report.allow.approvalThreadMatches);
  assert.equal(report.allow.stateWhileWaiting, "running");
  assert.ok(report.allow.spinnerHidden, "The panel showed the progress spinner while the approval waited.");
  assert.equal(report.allow.fileExists, true, "Allow did not write the file.");
  report.passed = true;
} finally {
  for (const taskId of started) {
    await page
      .evaluate(({ id, task }) => window.openbot.agent.stopTask({ agentId: id, taskId: task }), {
        id: agentId,
        task: taskId,
      })
      .catch(() => undefined);
  }
  if (started.length > 0) {
    await waitForTasksStopped("the started tasks stop", started).catch(() => undefined);
  }
  for (const taskId of started) {
    await page
      .evaluate(({ id, task }) => window.openbot.agent.closeTask({ agentId: id, taskId: task }), {
        id: agentId,
        task: taskId,
      })
      .catch(() => undefined);
  }
  for (const file of files) rmSync(file, { force: true });
  const restored = await page.evaluate(({ id, access }) => window.openbot.agent.updateAgent({ agentId: id, access }), {
    id: agentId,
    access: originalAccess,
  });
  report.restored = { access: restored.access ?? DEFAULT_AGENT_ACCESS };
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await session.close();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
