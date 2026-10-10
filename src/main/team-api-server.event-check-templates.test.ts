// @vitest-environment node
// Failure modes: a member or an unauthenticated caller listing choices, a typed private value coming
// back in an answer or an error, program text reaching a client, and an older client losing the template list.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import { Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { EventCheckApiReader } from "../backend/event-check-api-reader";
import { EventCheckEnvironment } from "../backend/event-check-environment";
import { EventCheckScheduler } from "../backend/event-check-scheduler";
import { EventCheckStore } from "../backend/event-check-store";
import { EventCheckTemplates } from "../backend/event-check-templates";
import { OpenBotDatabase } from "../backend/openbot-database";
import { RoutineTimer } from "../backend/routine-timer";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

const PROGRAM = `let raw=''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (input.discover === true) {
  const token = process.env.FIXTURE_API_TOKEN ?? '';
  if (!token.startsWith('good-')) {
    process.stderr.write('Failed with ' + token + '\\nopenbot-error: rate_limited\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ options: [{ id: 'C1AAA', label: '#general', group: 'channel' }] }));
  process.exit(0);
}
process.stdout.write('{"items":[],"hasNextPage":false}');`;

const shipped: EventCheckTemplate = {
  slug: "fixture",
  name: "Fixture",
  tagline: "A fixture",
  description: "A fixture template",
  version: "1.0.0",
  creatorName: "OpenBot",
  iconUrl: null,
  websiteUrl: null,
  app: null,
  program: { file: "fixture.mjs", digest: createHash("sha256").update(PROGRAM).digest("hex") },
  accountLabelHint: "Work",
  variables: [{ name: "FIXTURE_API_TOKEN", label: "API key", hint: "", docsUrl: null }],
  configuration: [
    {
      name: "rules",
      label: "Rules",
      description: "",
      value: "",
      required: false,
      type: "text",
      picker: {
        optionsFrom: "program",
        modes: [
          { value: "all", label: "All" },
          { value: "mentions", label: "Mentions" },
        ],
      },
    },
  ],
  argumentsJson: "{}",
  cursorArgument: "cursor",
  nextCursorPointer: "/cursor",
  selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
  actorPointer: "/actor",
  intervalSeconds: 60,
  instruction: "Look.",
};

it("lists choices through the host route for an administrator only, with fixed error text and no echo of typed values", async () => {
  const fixture = await createTeamApiFixture("event-check-templates", { configure: true });
  const database = new OpenBotDatabase(fixture.root);
  await runCauseEffect(database.initialize());
  const store = new EventCheckStore(database),
    programs = join(fixture.root, "programs"),
    catalog = join(fixture.root, "catalog");
  await mkdir(programs);
  await mkdir(join(catalog, "programs"), { recursive: true });
  await writeFile(join(catalog, "catalog.json"), JSON.stringify([shipped]));
  await writeFile(join(catalog, "programs", "fixture.mjs"), PROGRAM);
  const environment = new EventCheckEnvironment(join(fixture.root, "env"), {
    encrypt: (value) => Buffer.from(value).toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  const checks = new EventCheckScheduler({
    store,
    scope: () => Scope.makeUnsafe(),
    timer: new RoutineTimer(
      () => [],
      () => false,
      () => {},
    ),
    agentExists: (id) => id === "chief",
    running: () => true,
    apiReader: new EventCheckApiReader(
      environment,
      programs,
      (check) => store.current(check.id, check.revision) !== null,
      process.execPath,
    ),
    templates: new EventCheckTemplates(catalog, programs),
    deliver: () => {
      throw new Error("Quiet tests must not deliver.");
    },
  });
  const { base } = await fixture.start({ eventChecks: checks }),
    owner = await fixture.signIn();
  const invite = await runCauseEffect(fixture.store.createInvite("member"));
  const member = await runCauseEffect(fixture.store.acceptInvite(invite.token, "member", "member password"));
  const send = (path: string, body: unknown, token = owner, capability = "fork-host-v1") =>
    fetch(`${base}/v1/event-check-templates/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "3",
        "OpenBot-Capabilities": capability,
      },
      body: JSON.stringify(body),
    });
  const typed = "good-typed-value-0042";
  const draft = (variables: Record<string, string>) => ({
    slug: "fixture",
    field: "rules",
    configuration: {},
    variables,
  });
  try {
    for (const path of ["discover", "discover-check"]) {
      expect((await send(path, {}, "invalid")).status).toBe(401);
      expect((await send(path, {}, member.sessionToken)).status).toBe(403);
      expect((await send(path, {}, owner, "")).status).toBe(400);
    }

    // The list of templates still reads for a client that knows nothing of pickers: the field stays text.
    const listed = await (await send("list", {})).json();
    expect(listed[0].configuration[0]).toMatchObject({ name: "rules", type: "text" });

    const answer = await send("discover", draft({ FIXTURE_API_TOKEN: typed }));
    expect(answer.status).toBe(200);
    const body = await answer.text();
    expect(JSON.parse(body)).toEqual({ options: [{ id: "C1AAA", label: "#general", group: "channel" }] });
    expect(body).not.toContain(typed);

    // The program writes the typed value in its failure. The client gets the fixed text of the code only.
    const bad = "bad-typed-value-0043";
    const refused = await send("discover", draft({ FIXTURE_API_TOKEN: bad }));
    expect(refused.status).toBe(400);
    const refusedText = await refused.text();
    expect(refusedText).toContain("The app limited the requests.");
    expect(refusedText).not.toContain(bad);

    // A malformed request is refused without echoing what was typed.
    const malformed = await send("discover", { ...draft({ FIXTURE_API_TOKEN: bad }), field: 7 });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain(bad);
    const unknown = await send("discover", { ...draft({ FIXTURE_API_TOKEN: bad }), slug: "nothing" });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain(bad);

    // A refusal of install, adopt or update is an expected error: 400 with its fixed text, never 500.
    const install = {
      slug: "fixture",
      agentId: "chief",
      name: "Fixture check",
      accountLabel: "Work",
      instruction: "Look.",
      timezone: "UTC",
      intervalSeconds: 60,
      accountActorIds: [],
      configuration: {},
    };
    const unknownInstall = await send("install", { ...install, slug: "nothing" });
    expect(unknownInstall.status).toBe(400);
    expect(await unknownInstall.text()).toContain("This host does not have that event check template.");
    const installed = await send("install", install);
    expect(installed.status).toBe(200);
    const { id } = await installed.json();
    const target = { agentId: "chief", id };
    const current = await send("update", target);
    expect(current.status).toBe(400);
    expect(await current.text()).toContain("This event check already uses the latest version of its template.");
    const unknownAdopt = await send("adopt", { ...target, slug: "nothing" });
    expect(unknownAdopt.status).toBe(400);
    expect(await unknownAdopt.text()).toContain("This host does not have that event check template.");
    const linked = store.get("chief", id);
    if (linked.source.kind !== "api") throw new Error("The installed check must read an API program.");
    store.save({ ...linked, source: { ...linked.source, template: undefined } }, new Date());
    const notLinked = await send("update", target);
    expect(notLinked.status).toBe(400);
    expect(await notLinked.text()).toContain("This event check did not come from a template.");
  } finally {
    database.close();
  }
});
