# Forward GitHub and Linear webhooks to a routine

GitHub and Linear sign their webhooks with their own schemes. The OpenBot webhook route accepts only
the `X-OpenBot-*` scheme (see [Webhooks](webhooks.md)), so these services cannot post to it. Use a small
forwarder that runs next to the OpenBot host. It checks the sender's signature, makes a short summary,
and starts a routine through the [local script route](automation.md). An agent then reacts at once,
and nothing polls.

```text
GitHub / Linear --HTTPS--> reverse proxy --> forwarder (127.0.0.1:8787) --> OpenBot (127.0.0.1)
                                              checks the signature         runs the routine
```

The forwarder must run on the same computer as the OpenBot host and as the same OS user. It reads the
URL and the token that OpenBot writes in its `automation` folder. It does not change OpenBot, the
Signal relay or the released webhook contract.

## What you need

1. In the agent settings, turn on **Local scripts**.
2. Make a routine for the agent. It can be paused: a script run starts it also when it is paused. Write
   the task so that the agent reads the event, and so that it can stay quiet:

   > A GitHub or Linear event arrived. Read it. If it needs my attention or an action, do the work and
   > tell me. If it does not, answer exactly `[[no-update]]` and nothing else.

   A routine run that a script started shows its answer, like a Test run. When the routine task
   names `[[no-update]]` and the agent answers only that marker, the run leaves no message and no
   notification. A run whose answer has anything else stays visible.
3. Copy the agent ID and the routine ID. `GET /v1/agents` on the local route lists them. See
   [Local script runs](automation.md#routes).
4. In GitHub (repository or organization **Settings, Webhooks**) and in Linear (**Settings, API,
   Webhooks**), add a webhook with a secret that you make. Use the content type `application/json`
   in GitHub. Choose only the events that you need.
5. Put an HTTPS reverse proxy in front of the forwarder. Both services need a public HTTPS address.

## Limits that stay in place

- OpenBot starts at most 30 script runs an hour for each agent. Over that, the route answers 429. The
  forwarder then answers 503 and the sender can retry.
- A payload is at most 4,000 characters. The forwarder sends a short summary, never the whole event.
- OpenBot starts at most 20 event runs an hour for each routine. Later events wait and go out as one
  run that has all of them. A restart ends the wait, and each waiting run then starts on its own.
- The event text comes from outside. OpenBot marks it as data, not as instructions. Send only the
  fields that the agent needs, and do not send free text that a stranger can write when you can avoid it.

## The forwarder

Save it as `openbot-forwarder.mjs`. It needs Node.js 20 or later and no package.

```js
// Checks a GitHub or Linear webhook signature and starts an OpenBot routine through the local route.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";

const env = process.env;
const AUTOMATION = env.OPENBOT_AUTOMATION_DIR; // The "automation" folder in the OpenBot data folder.
const PORT = Number(env.FORWARDER_PORT ?? 8787);
const MAX_BODY = 1024 * 1024;
const MAX_PAYLOAD = 3500; // The route accepts 4,000 characters.
const IGNORED = new Set((env.IGNORED_ACTORS ?? "").split(",").map((name) => name.trim()).filter(Boolean));
const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
const LINEAR_MAX_AGE_MS = 60 * 1000;

if (!AUTOMATION) throw new Error("Set OPENBOT_AUTOMATION_DIR.");

/** One entry for each sender: where it posts, its secret, and the routine that it starts. */
const SOURCES = {
  "/github": {
    secret: env.GITHUB_WEBHOOK_SECRET,
    agentId: env.GITHUB_AGENT_ID,
    routineId: env.GITHUB_ROUTINE_ID,
    signature: (headers) => headers["x-hub-signature-256"]?.replace(/^sha256=/, ""),
    deliveryId: (headers) => headers["x-github-delivery"],
    fresh: () => true, // GitHub has no timestamp. The delivery ID stops a repeat.
    summarize: summarizeGitHub,
  },
  "/linear": {
    secret: env.LINEAR_WEBHOOK_SECRET,
    agentId: env.LINEAR_AGENT_ID,
    routineId: env.LINEAR_ROUTINE_ID,
    signature: (headers) => headers["linear-signature"],
    deliveryId: (headers) => headers["linear-delivery"],
    fresh: (event) => Math.abs(Date.now() - Number(event.webhookTimestamp)) <= LINEAR_MAX_AGE_MS,
    summarize: summarizeLinear,
  },
};
for (const [path, source] of Object.entries(SOURCES))
  if (!source.secret || !source.agentId || !source.routineId)
    throw new Error(`Set the secret, the agent ID and the routine ID for ${path}.`);

const seen = new Map(); // delivery ID -> time. A sender retries, and OpenBot must not run twice.

function verify(secret, raw, signature) {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const text = (value, max = 200) => (typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, max) : undefined);

function summarizeGitHub(event, headers) {
  const issue = event.pull_request ?? event.issue ?? event.check_run ?? event.workflow_run ?? event.release;
  return {
    source: "github",
    event: headers["x-github-event"],
    action: event.action,
    repository: event.repository?.full_name,
    actor: event.sender?.login,
    ref: event.ref,
    number: issue?.number,
    title: text(issue?.title ?? issue?.name),
    state: text(issue?.state ?? issue?.conclusion ?? issue?.status),
    url: text(issue?.html_url ?? event.compare, 400),
  };
}

function summarizeLinear(event, headers) {
  const data = event.data ?? {};
  return {
    source: "linear",
    event: headers["linear-event"] ?? event.type,
    action: event.action,
    actor: event.actor?.name,
    identifier: data.identifier,
    title: text(data.title),
    state: text(data.state?.name),
    assignee: text(data.assignee?.name),
    url: text(event.url ?? data.url, 400),
  };
}

/** Posts the summary to the local route. The URL and the token are read each time: they change at each OpenBot start. */
async function startRoutine(source, payload) {
  const base = new URL((await readFile(join(AUTOMATION, "url"), "utf8")).trim());
  const token = (await readFile(join(AUTOMATION, "token"), "utf8")).trim();
  const body = JSON.stringify({ payload });
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        method: "POST",
        path: `/v1/agents/${encodeURIComponent(source.agentId)}/routines/${encodeURIComponent(source.routineId)}/run`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${token}`, // Sent on the loopback connection only, never in an argument list.
        },
        timeout: 8000,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("Timed out.")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const reply = (status, message) => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(message);
  };
  try {
    const source = SOURCES[new URL(request.url ?? "/", "http://localhost").pathname];
    if (!source || request.method !== "POST") return reply(404, "Not found.");
    const raw = await readBody(request);
    if (raw === null) return reply(413, "Too large.");
    // Verify the exact bytes before anything reads the body as JSON.
    if (!verify(source.secret, raw, source.signature(request.headers))) return reply(401, "Bad signature.");
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(400, "Not JSON.");
    }
    if (!source.fresh(event)) return reply(401, "Too old.");
    const id = source.deliveryId(request.headers);
    const now = Date.now();
    for (const [key, time] of seen) if (now - time > SEEN_FOR_MS) seen.delete(key);
    if (id && seen.has(id)) return reply(200, "Already seen.");
    const summary = source.summarize(event, request.headers);
    if (IGNORED.has(summary.actor)) return reply(202, "Ignored actor."); // Your own agent's changes.
    const payload = JSON.stringify(summary).slice(0, MAX_PAYLOAD);
    const status = await startRoutine(source, payload);
    if (status === 202) {
      if (id) seen.set(id, now);
      return reply(202, "Started.");
    }
    // 429, 409 and the like: the sender may retry later. Nothing marks this delivery as seen.
    return reply(503, `OpenBot answered ${status}.`);
  } catch {
    return reply(503, "OpenBot is not reachable.");
  }
});
server.listen(PORT, "127.0.0.1");
```

The forwarder answers:

| Status | Meaning |
| --- | --- |
| `202` | OpenBot took the run, or the actor is on your ignore list. |
| `200` | This delivery ID was already forwarded. |
| `401` | The signature is not valid, or a Linear event is older than a minute. |
| `404`, `413`, `400` | Wrong path or method, body over 1 MiB, or body that is not JSON. |
| `503` | OpenBot is not running, or refused the run. The sender retries. |

GitHub shows each delivery under **Recent deliveries**, with a **Redeliver** button. Linear retries a
failed delivery after one minute, one hour and six hours.

The forwarder keeps its list of seen delivery IDs in memory. After a restart of the forwarder, a
retry of an old delivery can start the routine again. OpenBot does not check the ID.

## Settings

| Variable | Meaning |
| --- | --- |
| `OPENBOT_AUTOMATION_DIR` | The `automation` folder in the OpenBot data folder. See [Files](automation.md#files). |
| `GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET` | The secrets that you gave to the services. |
| `GITHUB_AGENT_ID`, `GITHUB_ROUTINE_ID`, `LINEAR_AGENT_ID`, `LINEAR_ROUTINE_ID` | The routine that each source starts. |
| `IGNORED_ACTORS` | Optional. Names of senders to skip, separated by commas. Use it for the account that your agents use, so that their own changes do not wake them. |
| `FORWARDER_PORT` | Optional. The default is `8787`. |

Keep the secrets in a file that only the service user can read. Do not put them in a command line.

## Run it with systemd

`/etc/systemd/system/openbot-forwarder.service`, for the user that runs OpenBot:

```ini
[Unit]
Description=OpenBot webhook forwarder
After=network.target

[Service]
User=openbot
EnvironmentFile=/etc/openbot-forwarder.env
ExecStart=/usr/bin/node /opt/openbot-forwarder/openbot-forwarder.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

`/etc/openbot-forwarder.env` (mode `0600`, owner `openbot`):

```sh
OPENBOT_AUTOMATION_DIR=/home/openbot/.config/OpenBot/automation
GITHUB_WEBHOOK_SECRET=change-me
GITHUB_AGENT_ID=agent-id
GITHUB_ROUTINE_ID=routine-id
LINEAR_WEBHOOK_SECRET=change-me-too
LINEAR_AGENT_ID=agent-id
LINEAR_ROUTINE_ID=routine-id
IGNORED_ACTORS=openbot-bot
```

Then run `systemctl enable --now openbot-forwarder`. Point the reverse proxy at `127.0.0.1:8787`,
for example `reverse_proxy 127.0.0.1:8787` in Caddy. Expose only the `/github` and `/linear` paths.

## Run it in Docker Compose

If OpenBot runs in a container, the forwarder must reach the same loopback address. Share the network
namespace of the OpenBot container, and mount its `automation` folder read-only:

```yaml
services:
  forwarder:
    image: node:22-alpine
    network_mode: "service:openbot"
    working_dir: /app
    command: ["node", "openbot-forwarder.mjs"]
    env_file: ./forwarder.env
    environment:
      OPENBOT_AUTOMATION_DIR: /openbot-data/automation
    volumes:
      - ./openbot-forwarder.mjs:/app/openbot-forwarder.mjs:ro
      - openbot-data:/openbot-data:ro
    restart: unless-stopped
```

Set `OPENBOT_AUTOMATION_DIR` to the `automation` folder inside the volume that holds the OpenBot
data folder, for example `/openbot-data/automation`. The reverse proxy must reach port 8787 through
the `openbot` service.

## Test it without a real service

Sign a sample body yourself. The forwarder must answer `202` for a valid signature and `401` for a
changed body:

```sh
body='{"action":"opened","repository":{"full_name":"acme/app"},"sender":{"login":"ada"},"pull_request":{"number":7,"title":"Fix login"}}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -sS -i -X POST http://127.0.0.1:8787/github \
  -H 'Content-Type: application/json' -H 'X-GitHub-Event: pull_request' \
  -H 'X-GitHub-Delivery: test-1' -H "X-Hub-Signature-256: $sig" --data-binary "$body"
```

## Why not the OpenBot route

The OpenBot webhook route lets the Signal relay hold no secret: the host verifies the signature. To
accept GitHub and Linear directly, the relay and the host would need both new signature schemes and
new delivery ID headers for each route. A relay that queues events for an offline host would also have
to store the request bodies, which the relay does not do today. Both changes touch the released
webhook contract and the Signal Worker, so this forwarder does the work outside them.
