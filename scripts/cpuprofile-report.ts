// Summarizes a V8 `.cpuprofile`, such as one from `POST /v1/debug/cpu-profile` of the server control
// socket or from `node --cpu-prof`: the functions with the most self time and total time, and the long
// tasks (busy stretches of the main thread without an idle sample) with the functions that filled them.
//
// Run: bun scripts/cpuprofile-report.ts <file.cpuprofile> [--top=40] [--long-ms=100] [--tasks=15]
//      [--task-top=14] [--focus=<function name>]   (callers and callees of one function)
// Prints text. Reads only the file.
import { readFileSync } from "node:fs";

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

const argument = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!file) {
  process.stderr.write("Usage: bun scripts/cpuprofile-report.ts <file.cpuprofile> [--top=40] [--long-ms=100]\n");
  process.exit(2);
}
const top = Number(argument("top") ?? 40);
const longMs = Number(argument("long-ms") ?? 100);
const taskCount = Number(argument("tasks") ?? 15);
const taskTop = Number(argument("task-top") ?? 14);
const focus = argument("focus");

const profile: CpuProfile = JSON.parse(readFileSync(file, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

function label(frame: CallFrame): string {
  const name = frame.functionName || "(anonymous)";
  if (!frame.url) return name;
  const url = frame.url.replace(/^file:\/\//u, "");
  const short = url.includes("node_modules/")
    ? url.slice(url.lastIndexOf("node_modules/") + "node_modules/".length)
    : url.split("/").slice(-2).join("/");
  return `${name} ${short}:${frame.lineNumber + 1}`;
}

const IDLE = new Set(["(idle)"]);
const SPECIAL = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);

/** The stack of a sample, leaf first, as labels. */
const stackCache = new Map<number, string[]>();
function stack(nodeId: number): string[] {
  const cached = stackCache.get(nodeId);
  if (cached) return cached;
  const labels: string[] = [];
  for (let id: number | undefined = nodeId; id !== undefined; id = parent.get(id)) {
    const node = nodes.get(id);
    if (!node || node.callFrame.functionName === "(root)") continue;
    labels.push(label(node.callFrame));
  }
  stackCache.set(nodeId, labels);
  return labels;
}

// The time of a sample is the delta to the next one.
const durations = profile.samples.map((_, index) => (profile.timeDeltas[index + 1] ?? 0) / 1000);
const totalMs = (profile.endTime - profile.startTime) / 1000;
const self = new Map<string, number>();
const total = new Map<string, number>();
let idleMs = 0;
let gcMs = 0;
let programMs = 0;
profile.samples.forEach((nodeId, index) => {
  const ms = durations[index] ?? 0;
  const node = nodes.get(nodeId);
  const name = node?.callFrame.functionName ?? "";
  if (IDLE.has(name)) idleMs += ms;
  if (name === "(garbage collector)") gcMs += ms;
  if (name === "(program)") programMs += ms;
  const labels = stack(nodeId);
  const leaf = labels[0];
  if (leaf) self.set(leaf, (self.get(leaf) ?? 0) + ms);
  for (const entry of new Set(labels)) total.set(entry, (total.get(entry) ?? 0) + ms);
});

const ms = (value: number) => `${value.toFixed(0).padStart(7)} ms`;
const pct = (value: number, of: number) => `${((100 * value) / Math.max(of, 1)).toFixed(1).padStart(5)}%`;
const busyMs = totalMs - idleMs;
const out: string[] = [];
out.push(`Profile: ${file}`);
out.push(
  `Wall ${totalMs.toFixed(0)} ms, busy ${busyMs.toFixed(0)} ms (${pct(busyMs, totalMs).trim()}), GC ${gcMs.toFixed(0)} ms, (program) ${programMs.toFixed(0)} ms, ${profile.samples.length} samples`,
);

function table(title: string, values: Map<string, number>): void {
  out.push("", `${title} (share of busy time):`);
  for (const [name, value] of [...values.entries()]
    .filter(([name]) => !SPECIAL.has(name))
    .sort((left, right) => right[1] - left[1])
    .slice(0, top)) {
    out.push(`${ms(value)} ${pct(value, busyMs)}  ${name}`);
  }
}
table("Self time", self);
table("Total time", total);

// Long tasks: runs of samples with no idle sample between them.
interface Task {
  start: number;
  ms: number;
  samples: number[];
}
const tasks: Task[] = [];
let current: Task | null = null;
let at = 0;
for (const [index, nodeId] of profile.samples.entries()) {
  const duration = durations[index] ?? 0;
  const idle = IDLE.has(nodes.get(nodeId)?.callFrame.functionName ?? "");
  if (idle) {
    if (current && current.ms >= longMs) tasks.push(current);
    current = null;
  } else {
    current ??= { start: at, ms: 0, samples: [] };
    current.ms += duration;
    current.samples.push(index);
  }
  at += duration;
}
if (current && current.ms >= longMs) tasks.push(current);
const longTotal = tasks.reduce((sum, task) => sum + task.ms, 0);
out.push(
  "",
  `Long tasks of ${longMs} ms or more: ${tasks.length}, ${longTotal.toFixed(0)} ms in all, longest ${Math.max(0, ...tasks.map((task) => task.ms)).toFixed(0)} ms`,
);
const longSelf = new Map<string, number>();
const longTotalByName = new Map<string, number>();
for (const task of tasks)
  for (const index of task.samples) {
    const labels = stack(profile.samples[index] ?? 0);
    const duration = durations[index] ?? 0;
    if (labels[0]) longSelf.set(labels[0], (longSelf.get(labels[0]) ?? 0) + duration);
    for (const entry of new Set(labels)) longTotalByName.set(entry, (longTotalByName.get(entry) ?? 0) + duration);
  }
out.push("", "Inside long tasks, total time:");
for (const [name, value] of [...longTotalByName.entries()]
  .filter(([name]) => !SPECIAL.has(name))
  .sort((left, right) => right[1] - left[1])
  .slice(0, top))
  out.push(`${ms(value)} ${pct(value, longTotal)}  ${name}`);
out.push("", "Inside long tasks, self time:");
for (const [name, value] of [...longSelf.entries()]
  .filter(([name]) => !SPECIAL.has(name))
  .sort((left, right) => right[1] - left[1])
  .slice(0, top))
  out.push(`${ms(value)} ${pct(value, longTotal)}  ${name}`);

for (const task of [...tasks].sort((left, right) => right.ms - left.ms).slice(0, taskCount)) {
  out.push("", `Task at ${(task.start / 1000).toFixed(2)} s, ${task.ms.toFixed(0)} ms:`);
  const inTask = new Map<string, number>();
  for (const index of task.samples) {
    for (const entry of new Set(stack(profile.samples[index] ?? 0)))
      inTask.set(entry, (inTask.get(entry) ?? 0) + (durations[index] ?? 0));
  }
  for (const [name, value] of [...inTask.entries()]
    .filter(([name]) => !SPECIAL.has(name))
    .sort((left, right) => right[1] - left[1])
    .slice(0, taskTop))
    out.push(`  ${ms(value)} ${pct(value, task.ms)}  ${name}`);
}

if (focus) {
  const callers = new Map<string, number>();
  const callees = new Map<string, number>();
  profile.samples.forEach((nodeId, index) => {
    const labels = stack(nodeId);
    const position = labels.findIndex((entry) => entry.startsWith(`${focus} `) || entry === focus);
    if (position < 0) return;
    const duration = durations[index] ?? 0;
    const caller = labels.slice(position + 1, position + 4).join(" < ");
    callers.set(caller, (callers.get(caller) ?? 0) + duration);
    const callee = position > 0 ? (labels[position - 1] ?? "") : "(self)";
    callees.set(callee, (callees.get(callee) ?? 0) + duration);
  });
  out.push("", `Callers of ${focus}:`);
  for (const [name, value] of [...callers.entries()].sort((left, right) => right[1] - left[1]).slice(0, top))
    out.push(`${ms(value)}  ${name}`);
  out.push("", `Callees of ${focus}:`);
  for (const [name, value] of [...callees.entries()].sort((left, right) => right[1] - left[1]).slice(0, top))
    out.push(`${ms(value)}  ${name}`);
}
process.stdout.write(`${out.join("\n")}\n`);
