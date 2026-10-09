import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventCheckTemplateList, type EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import { decodeEventCheckInput } from "@openbot/contracts/event-checks";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { EventCheckTemplates } from "../src/backend/event-check-templates";

const logger = createOpenBotLogger("build-watcher-catalog");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const secretPattern =
  /(ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:live|test|proj)-[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|lin_api_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY)/u;

export interface WatcherCatalogPaths {
  sourceRoot: string;
  outputRoot: string;
}
export function defaultWatcherCatalogPaths(root: string = projectRoot): WatcherCatalogPaths {
  return {
    sourceRoot: join(root, "marketplace", "watcher-catalog"),
    outputRoot: join(root, "resources", "watcher-catalog"),
  };
}
interface GeneratedFile {
  path: string;
  content: string | Buffer;
}

/** Reads the source, validates every template the way an install would, and answers the files to ship. */
export async function loadWatcherCatalog(
  sourceRoot: string,
): Promise<{ templates: EventCheckTemplate[]; files: GeneratedFile[] }> {
  const spec = JSON.parse(await readFile(join(sourceRoot, "catalog.json"), "utf8"));
  if (
    !isDynamicRecord(spec) ||
    spec.schemaVersion !== 1 ||
    !Array.isArray(spec.order) ||
    !spec.order.every((slug): slug is string => isString(slug) && slugPattern.test(slug)) ||
    new Set(spec.order).size !== spec.order.length
  )
    throw new Error("Watcher catalog metadata is invalid.");
  const order: string[] = spec.order;
  const directories = (await readdir(join(sourceRoot, "watchers"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const unknown = directories.filter((slug) => !order.includes(slug));
  if (unknown.length > 0)
    throw new Error(`Watcher catalog has directories outside catalog.json order: ${unknown.join(", ")}.`);
  const missing = order.filter((slug) => !directories.includes(slug));
  if (missing.length > 0) throw new Error(`Watcher catalog order lists missing directories: ${missing.join(", ")}.`);
  const raw: unknown[] = [];
  const files: GeneratedFile[] = [];
  for (const slug of order) {
    const source = JSON.parse(await readFile(join(sourceRoot, "watchers", slug, "watcher.json"), "utf8"));
    if (
      !isDynamicRecord(source) ||
      source.slug !== slug ||
      !isString(source.program) ||
      !isDynamicRecord(source.arguments)
    )
      throw new Error(`Watcher ${slug} is invalid.`);
    if (secretPattern.test(JSON.stringify(source))) throw new Error(`Watcher ${slug} holds a secret-looking value.`);
    const program = await readFile(join(sourceRoot, "watchers", slug, source.program));
    if (secretPattern.test(program.toString("utf8")))
      throw new Error(`Watcher ${slug} program holds a secret-looking value.`);
    const file = `${slug}${extname(source.program)}`;
    const { arguments: args, program: _name, ...rest } = source;
    raw.push({
      ...rest,
      program: { file, digest: createHash("sha256").update(program).digest("hex") },
      argumentsJson: JSON.stringify(args),
    });
    files.push({ path: `programs/${file}`, content: program });
  }
  const templates = decodeEventCheckTemplateList(raw);
  await proveInstallable(templates, files);
  files.push({ path: "catalog.json", content: `${JSON.stringify(templates, null, 2)}\n` });
  return { templates, files };
}

/** Installs every template into a scratch folder and decodes the result, so a template the host would refuse fails here. */
async function proveInstallable(templates: EventCheckTemplate[], files: GeneratedFile[]): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "watcher-catalog-"));
  try {
    const catalog = join(scratch, "catalog");
    const programs = join(scratch, "programs");
    await mkdir(join(catalog, "programs"), { recursive: true });
    await mkdir(programs);
    for (const file of files) await writeFile(join(catalog, file.path), file.content);
    await writeFile(join(catalog, "catalog.json"), JSON.stringify(templates));
    const host = new EventCheckTemplates(catalog, programs);
    for (const template of templates) {
      const input = host.install(
        host.get(template.slug),
        {
          slug: template.slug,
          agentId: "agent",
          name: template.name,
          accountLabel: "account",
          instruction: template.instruction,
          timezone: "UTC",
          intervalSeconds: template.intervalSeconds,
          accountActorIds: [],
          configuration: Object.fromEntries(
            template.configuration.map((field) => [field.name, field.value || "sample"]),
          ),
        },
        new Date(),
      );
      decodeEventCheckInput(JSON.parse(JSON.stringify(input)));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function buildWatcherCatalog(options?: {
  check?: boolean;
  paths?: WatcherCatalogPaths;
}): Promise<{ watchers: number }> {
  const paths = options?.paths ?? defaultWatcherCatalogPaths();
  const { templates, files } = await loadWatcherCatalog(paths.sourceRoot);
  if (options?.check) {
    const stale: string[] = [];
    for (const file of files) {
      const actual = await readFile(join(paths.outputRoot, file.path)).catch(() => null);
      if (!actual?.equals(Buffer.from(file.content))) stale.push(`resources/watcher-catalog/${file.path}`);
    }
    const shipped = new Set(files.map((file) => file.path));
    const present = await readdir(join(paths.outputRoot, "programs")).catch(() => []);
    for (const name of present)
      if (!shipped.has(`programs/${name}`)) stale.push(`resources/watcher-catalog/programs/${name}`);
    if (stale.length > 0)
      throw new Error(
        `Generated watcher catalog is stale: ${stale.join(", ")}. Run bun run marketplace:build:watchers.`,
      );
    return { watchers: templates.length };
  }
  await rm(paths.outputRoot, { recursive: true, force: true });
  for (const file of files) {
    const target = join(paths.outputRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  await mkdir(join(paths.outputRoot, "programs"), { recursive: true });
  return { watchers: templates.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new Error("Usage: bun scripts/build-watcher-catalog.ts [-- --check]");
  buildWatcherCatalog({ check: args[0] === "--check" })
    .then((summary) => process.stdout.write(`Built watcher catalog with ${summary.watchers} templates.\n`))
    .catch((error) => {
      logger.error("Watcher catalog generation failed.", toLogValue(error));
      process.exitCode = 1;
    });
}
