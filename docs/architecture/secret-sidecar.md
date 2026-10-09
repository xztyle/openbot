# Secret sidecar

Status: design. Nothing in this file is built. This file says what is missing, why, and how to
build it so that a change to a running host is small and can be undone.

## The problem

An event check program gets its private variables (API keys) in its environment. Today the host,
the agents and the program run as one user, `openbot`, in one container. So a full-access agent that
a prompt injection controls can do all of these:

- read the keyring password file in `/data/.config/openbot-container`, open the keyring, and decrypt
  `watcher-environments/<check>/.env`;
- read `/proc/<pid>/environ` of a running program and of OpenBot (the same user can);
- read the memory of OpenBot with `ptrace` when `ptrace_scope` is 0;
- start a program of its own, which is not an event check, and ask the host to run it (`launch()`
  does not confine a program).

Approval of a program digest (see [Private variables and approval](../event-checks.md#private-variables-and-approval))
stops an agent from changing an approved program. It does not stop the three reads above, and it
does not stop a program that you approved from sending its values anywhere. A boundary needs two things
that the host cannot give itself: a second user that agents cannot become, and a place that only
that user can read.

## What the boundary must give

1. An agent cannot read a private value, at rest or in memory.
2. An agent cannot set a private value, or approve a program. Only a person's action can.
3. A program runs with the values only when its bytes are the approved bytes. The check and the run
   use the same copy, so a swap between them gains nothing.
4. A program cannot read the files of the agents (`/data`), and an agent cannot read the files or the
   environment of a program.
5. If the part that holds the values is down, checks fail and say so. Nothing falls back to a plain file.

## Prerequisite: OpenBot and agents must not share a user

The hard part is not the sidecar. It is point 2. A sidecar must know that a `set` comes from OpenBot
main, which got it from a person, and not from an agent. A Unix socket tells the sidecar the user
of the caller (`SO_PEERCRED`). Today that user is `openbot` for main and for every agent process, so
the sidecar cannot tell them apart. A secret in main's memory or environment is also readable by the
agents. So the change must first give agents another user, or another container:

| Option | Change | Cost |
| --- | --- | --- |
| A. Two users in one container | Main runs as `openbot` (UID 1000). The provider CLIs and every command of an agent run as `openbot-agent` (UID 1001) through `setpriv`/`runuser` set in the provider spawn. `/data/OpenBot` is group-writable by both. Main's own files (`/data/.config/OpenBot`, the database, the keyring) are mode 0700 for UID 1000. | The provider spawn, the workspace paths, `~/.codex` and `~/.claude` homes, the Computer Use driver and the browser profile all need a new owner. Large. |
| B. Two containers | Main in one container, a runner for the provider CLIs in another, joined by a shared workspace volume and a socket. | A new process boundary for the tool bridge and the MCP gateway. Larger. |

Without A or B, a sidecar protects only against a program that is not an agent. It adds a process and
protects nothing against the agent in the threat model, so we should not build it first.

## Components

```text
  person ──► web client / app ──► OpenBot main (uid 1000) ───socket───► openbot-secrets (uid 1002)
                                       ▲                                    │ own volume /secrets
  agents (uid 1001) ── tools ──────────┘ (no socket access)                 └─ runs check programs
                                                                               (uid 1003, empty root)
```

- **openbot-secrets** is a second service in the compose file, from the same image, started with
  `openbot-secrets --socket /run/openbot-secrets/sock`. It has its own volume `openbot-secrets`
  (mode 0700, owner 1002). It has `cap_drop: ALL`, a read-only root file system, and a small `pids_limit`.
  It holds a sealed store (one file per check, encrypted with a key in `/secrets`, which only 1002 can read).
- **The socket** is in a volume that both services mount. Its owner is 1002 and its group is a group
  that only main's user (1000) has. Agents (1001) are not in the group. The sidecar checks `SO_PEERCRED`
  on every connection and refuses a user other than 1000. The socket path is not in any
  environment that an agent receives.
- **The watcher folder** `OpenBot/Shared/Watchers` is mounted read-only in the sidecar. The sidecar never
  trusts a path or a digest that main sends. It opens the file, reads the bytes into memory, hashes
  them, and writes them to a file in its own private temporary directory. The program runs from that copy.
- **Program user.** The sidecar starts the program as UID 1003, with an empty root (`/tmp` only), no
  mount of `/data`, a fresh PID namespace and the environment of the check. UID 1003 cannot read
  the sidecar's volume, and UID 1001 cannot read `/proc/<pid>/environ` of the program.

## Protocol

One local stream socket. One JSON object per line, in each direction, at most 1 MiB. Every request
has `id`, `type` and `version` (1). Every answer has the same `id`, `ok` and either a result or
`error` (`code` and a fixed text with no value). The version is a number, as in the Team API. A new
field is optional. A new meaning gets a new `type`.

| `type` | Request fields | Answer | Who may cause it in main |
| --- | --- | --- | --- |
| `hello` | none | `{ version, store: "ready" \| "locked" }` | any |
| `status` | `checkId`, `variables[]`, `account`, `destination` | `{ variables: [{ name, configured }], approval: "none" \| "approved" \| "changed" }` | any |
| `set` | `checkId`, `account`, `name`, `value`, `path`, `destination` | `{ approval }` | a person (IPC, Team API); never an agent tool |
| `remove` | `checkId`, `name` or `all` | `{}` | a person, or check delete |
| `approve` | `checkId`, `path`, `destination` | `{ approval }` | a person |
| `run` | `checkId`, `account`, `path`, `args`, `deadlineMs`, `reviewedDigests[]` | `{ stdout }` (redacted) or `{ error }` | the scheduler |
| `forget` | `checkId` | `{}` | check delete |

Main decides who is a person. It is the same decision as in `EventCheckScheduler` today: an
agent actor never reaches `set`, `approve` or `remove`. The sidecar cannot check that, so
OpenBot main is part of the trusted base and must be a different user from the agents (see above).
The sidecar enforces what it can alone:

- `set` stores the digest of the file as the sidecar reads it, and the destination fingerprint. A
  `set` for another variable, with a program that differs from the approved one, drops the other values.
- `run` computes the digest itself, from the bytes it will run. It refuses to start when the
  digest and the destination differ from the approval and are not in `reviewedDigests`. `reviewedDigests`
  comes from the catalog that main read. The sidecar also holds a copy of the catalog digests, shipped
  with its image, and uses the intersection, so a compromised main cannot widen it.
- `run` returns the output after it removes the values and their encoded forms (URL, base64, JSON).
- A value is never in a log, an answer or an error.

## Migration from today

1. **Release N (additive).** Add the `local` secret driver behind an interface (`EventCheckSecrets`:
   `status`, `set`, `approve`, `remove`, `run`). The driver is today's code: `EventCheckEnvironment`
   and `runEventCheckProgram`. Nothing changes for users. This is also the place for the tests of the interface.
2. **Release N+1.** Add the `sidecar` driver and the `openbot-secrets` service, off by default. A
   host that sets `OPENBOT_SECRETS_SOCKET` uses it. Main sends `hello` at the start.
3. **Import.** For each check with a file in `watcher-environments`, main decrypts it with the keyring
   as today and sends `set` for each value, with the check's current approval. Main deletes the file
   only after the sidecar answers that the value is written and synced. A failure in the middle leaves
   the file, and the import starts again. Nothing is removed in a step that can fail.
4. **Release N+2.** The compose file starts the sidecar and sets the socket. The user split from
   the prerequisite section is on. The `local` driver stays for the desktop app, which has no sidecar.
5. **Rollback.** A value never leaves the sidecar, so a rollback to the `local` driver means that the user
   enters the values again. Keep the old files until the user has accepted the new setup: the import
   in step 3 can keep them for one release, behind a setting, and the cleanup deletes them later. A
   downgrade to a release without the driver finds no file and shows the variables as missing. Say
   this in the release notes.

The database needs no migration. A check keeps `source.variables`, `programDigest` and
`template`. The approval moves from the encrypted file to the sidecar.

## Failure modes

| Failure | Result |
| --- | --- |
| Sidecar is down or the socket is missing | `status` says nothing is configured, `run` fails with a fixed error, the check pauses after three failures. No value is written to `/data`. |
| Sidecar store is locked (no key) | `hello` says `locked`. The settings panel shows it. No run starts. |
| Main and agents run as one user | The sidecar cannot tell them apart and gives no protection. This is why the user split is a prerequisite. |
| An agent writes the socket path | `SO_PEERCRED` refuses it. The socket is in a mode 0660 directory with a group that agents lack. |
| The program file changes between the check and the run | Not possible: the sidecar hashes and runs one private copy. |
| A program loads other files | The program sees only its private root. A `.mjs` that imports a sibling fails. A bundle must be one file. |
| A program is approved and sends the values to another host | Not stopped by this design. Phase 2 below stops it. |
| Two `set` calls at once | The sidecar serializes writes per check and writes with a temporary file and a rename. |
| A restart in the middle of an import | The old file stays until the sidecar confirms. The import starts again. |
| The sidecar volume is lost | The values are lost. The user enters them again. There is no backup of values by design. |

## Phase 2: egress by destination

An approved program can still send a value to any host. To stop it, the sidecar runs the program in
a network namespace with one route: a local proxy of the sidecar. The proxy allows a connection only
to the hosts of the approved destination. For a catalog template these are fixed (`api.linear.app`,
`slack.com`, `api.github.com`, …) plus the host in an address setting, which a person approved. A program
that an agent wrote has an allow list that the person sets with the approval. This is the control
that makes "approve" mean more than "I read the code".

## What stays open

- Providers and agent tools still get the environment of OpenBot. The sidecar covers event checks only.
  The keys for providers (`XAI_API_KEY`, …) and MCP headers have the same problem and need the same split.
- Messages that a person types into the app pass through main. A compromised main sees them.
- The web client, the Cloudflare Access policy and the account server are outside this file.

## Tests to write with the build

- The protocol, with a fake socket: each `type`, the size limit, a request from the wrong user.
- The run: a program that was swapped after `set` does not get the value; a program with a sibling
  import fails; the output has no value in any encoding.
- The import: killed after each step, restarted, with the file still present until the answer.
- A real two-user run in a container (needs Docker, so it is a CI test, not a unit test).
