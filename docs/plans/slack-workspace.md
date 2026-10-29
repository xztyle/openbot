# Plan: OpenBot as a Slack-style workspace with AI teammates

Owner decision (2026-10-28): turn OpenBot's product surface into a Slack clone — it looks, feels and is
controlled like Slack — where some teammates are AI agents. Authentication stays as it is. Discord keeps
working and can be bridged into the workspace.

This plan builds on what exists. Channels are live end to end (upstream 0.48 restored them): shared
transcript, one execution thread per (channel, agent), lead routing with an `idle` outcome, tasks,
assign/transfer, memories, routines, unread counts, and the same conversation view on desktop, web and
iOS. Human↔human DMs exist in the backend. One-shot toolless model calls exist
(`generateTextWithoutTools`, `WarmGenerations`).

## Product model

| Slack concept | OpenBot model |
| --- | --- |
| Workspace | A server (host). The server rail stays as Slack's workspace switcher. |
| Member | A human team member (account service identity, roles unchanged) or an AI agent. |
| Public channel `#name` | `Channel{kind:"channel", visibility:"public"}`. Every human member can see and join it. |
| Private channel `🔒name` | `visibility:"private"`. Only its human members (and owners/admins) see it. |
| Agent visibility | An agent sees and can act in a channel only if it is a member of it — in public and private channels alike. |
| DM with a human | `kind:"dm"`, two human members, no agents. |
| Group DM | `kind:"group"`, 3–9 members, humans and agents mixed. |
| DM with an agent | For the server owner: the agent's main chat (full context). For other humans: a private `kind:"dm"` channel with that agent, so DMs stay private per person. Per-agent switch "Share the main chat with everyone" keeps today's behavior. |
| Thread | Messages carry `threadRootId`. Replies in a thread live in the thread panel; agents answer inside the thread they were addressed in. |
| Reactions | On every channel/DM message, actor is a member or an agent. |
| Mentions | `@human`, `@agent`, `@channel`/`@here`; `#channel` links. |
| Apps | Discord bridge, Slack/Telegram connectors, event checks — unchanged, surfaced as integrations. |

### When an AI teammate answers (answer modes)

Per (channel, agent) membership, with a per-agent default:

- `mention` — answers only when mentioned (`@agent`), when a message replies to it, or in a thread it is part of.
- `always` — considers every message. Before answering, the **gate** (below) decides if it should.
- `always-no-gate` — answers every message (old behavior, for 1:1 DMs and "assistant" channels).
- `lead` — the channel coordinator mode that exists today (the lead routes work to one member). Kept as a channel-level option "Coordinator routing".

DMs with one agent default to `always-no-gate`. Channels default to `mention` for agents added later and `always` (gated) for the agent that created/was asked to join with "Answer every message".

### The gate (cheap model)

A toolless one-shot call through `WarmGenerations` on a cheap model chosen in Server settings → Workspace
(default `claude-haiku-5-5`; alternatives listed from the providers, e.g. Codex `gpt-6-luna`).

- Input: the new message (+ thread root), the last ~20 messages of the channel/thread (trimmed), the agent's
  name/title/description/instructions summary, its per-channel "focus" note, what it is currently doing
  (running turn summary/plan, open tasks), and who else is in the channel and their focus.
- Output (strict JSON): `{"answer": true|false, "reason": "...", "priority": 0-1}`.
- Rules baked into the prompt: answer if addressed, if the message is about the agent's remit/focus or its
  ongoing work, or if it asks a question nobody else in the channel is better placed to answer; stay quiet for
  chit-chat between humans, messages aimed at another member, or acknowledgements.
- Several gated agents may want to answer the same message; the highest `priority` answers first and the
  others see its answer before deciding again (prevents pile-ons). Max 2 agents answer one message unless
  mentioned.
- Failure/timeout (3 s budget) → fall back to `mention` behavior for that message.
- Decisions are logged (debug "why did/didn't X answer" visible to owners/admins on hover).
- Loop safety: agent messages never trigger `always` agents; agents trigger each other only by explicit
  `@mention`, with a chain depth limit of 3 per human message.

## Architecture changes

### Data (no new tables where JSON already carries the data)

- `projection_channels.channel_json` (JSON): add `kind`, `visibility`, `topic`, `description`,
  `humanMemberIds`, per-agent `answerMode` + `focus`, `createdBy`, `discordLink?`. No migration needed.
- `projection_channel_messages.message_json`: add `threadRootId`, `reactions[]` (actor member/agent),
  `mentions[]`, `edited`, `deleted`. Thread queries use `json_extract` (+ one expression index in
  migration 48 if needed for speed).
- Migration 48 (only if indexes are needed): expression index on `json_extract(message_json,'$.threadRootId')`.
  Rehearse on a copy of the live snapshot before deploy.
- Human↔human DMs move onto channels (`kind:"dm"`) so one UI and one API serve everything; existing
  `projection_direct_*` rows (none on the live server) are migrated lazily.
- Workspace settings (gate model, defaults) in a JSON preference file (`openbot-workspace-v1.json`).

### Backend

- `ChannelStore.list(memberId)` filters by visibility and membership; owners/admins see all.
- Agent channel tools and `list_channels` only expose channels the agent is a member of.
- New responder pipeline in `ChannelService` (replaces "lead picks one owner" unless the channel uses
  Coordinator routing): on each human message, compute candidate agents (mentioned, repliers, thread
  participants, `always*` members), run the gate for gated ones in parallel, deliver to each chosen agent's
  (channel, agent) context thread with the thread id, capture replies into the right thread.
- Reactions, edits, deletes, thread replies as `ChannelCommand`s.
- Member mentions: chat-tag kind `member` (`@[name](member:id)`), notifications for mentioned humans.
- Activity feed per member: mentions, thread replies, DMs (derived from channel messages + reads).

### Team API / IPC (additive, fork capability `workspace-v1` under `fork-host-v1`)

- Channel payloads gain the new fields; routes: thread page, react, edit/delete message, join/leave,
  set member answer mode/focus, workspace settings, activity feed.
- Realtime: `channels-changed` stays; add `channel-message` event with the message payload so clients
  append without refetching (Slack feel).

### UI (desktop and web share `packages/ui`)

- Slack layout: workspace rail (servers) · sidebar · message pane · right panel (thread / details).
- Sidebar: workspace header + menu, search/jump (⌘K), Threads, Activity (mentions/DMs), Channels
  (`#`/`🔒`, bold unread, mention badges), Direct messages (humans with presence, agents with an "AI" badge
  and live working indicator), Apps; "+" to create channel / new message. Agents' own management (settings,
  routines, tasks, sections) stays reachable from the agent profile and the DM header.
- Message pane: channel header (name, topic, member face pile, details button), Slack-style rows (avatar,
  name, time, no bubbles, grouped consecutive messages, hover action bar: react, reply in thread, more),
  "N replies" thread summaries, reactions bar, day dividers, "new messages" line, typing/working indicators
  for agents ("Atlas is thinking…").
- Composer: Slack-like box with formatting toolbar, `@` humans/agents/`@channel`, `#` channels, attachments,
  Enter to send / Shift+Enter newline, ↑ to edit last message.
- Thread panel (right): root message, replies, its own composer, "Also send to #channel".
- Channel details (right panel/modal): About (topic, description), Members (humans + agents; add/remove;
  per-agent answer mode, focus note; gate on/off), Settings (privacy, Coordinator routing, Discord link),
  Archive.
- Create channel dialog (name, private toggle, add people and agents); New message (DM / group DM).
- Agent profile popover/page (AI badge, title, description, model, quick actions: DM, settings).
- Keyboard: ⌘K switcher, ⌥↑/↓ channel nav, Esc mark read, ↑ edit.
- Existing agent-centric screens (agent chat with reasoning/steps, tasks, routines, workflows, marketplace,
  settings) remain, reached from DMs and menus, so nothing is lost.

### Discord

- Existing Discord connector and per-channel config stay.
- New: link a workspace channel to a Discord channel (Channel details → Integrations). Discord messages
  appear in the workspace channel authored by the Discord user (external badge); workspace messages and agent
  answers in that channel are posted to Discord (webhook-style name/avatar per author when the bot has
  Manage Webhooks, otherwise prefixed by name). Answer modes and the gate apply to bridged messages like to
  native ones.

## Phases (each merged to `main` and deployed when built; owner preference: no extra checks)

1. **Model + backend core**: channel kinds/visibility/human members/answer modes/focus in contracts and
   store; visibility filtering for humans and agents; threads, reactions, edit/delete, member mentions;
   Team API + IPC additive surface + `channel-message` realtime event; DMs on channels; workspace settings
   file.
2. **Responder pipeline + gate**: answer modes, gate via `WarmGenerations`, multi-agent answering, thread-
   aware delivery and capture, loop safety, decision log; Coordinator routing kept as an option.
3. **Slack UI**: layout, sidebar, message pane, composer, thread panel, channel details, create/new-message
   dialogs, profiles, activity, shortcuts — desktop and web.
4. **Agent behavior settings**: per-agent defaults (answer mode, gate on/off, focus), workspace gate model
   picker, "share main chat" switch for DMs.
5. **Discord bridge**: workspace channel ↔ Discord channel, both directions, authors, answer modes.
6. **Polish**: empty states, onboarding into #general with the team's agents, i18n in all languages, docs,
   remove dead paths, performance (realtime append, virtualized lists).

7. **Hyperagent-style fleet and artifacts** (owner reference: hyperagent.com — "Agents that ship real,
   powerful work"):
   - **Fleet / command center**: a workspace view listing every agent with live status (idle, working on
     what, waiting for someone), current channel/thread, today's cost and time, quick DM/assign. Assigning
     work = posting a brief in a channel or DM; agents keep it current ("the work never goes stale") through
     routines and event checks.
   - **Transparent execution**: each agent answer in a channel/thread has a collapsible step trail (searches,
     tools, files, skills loaded) like the agent chat's "N steps", streaming live while the agent works.
   - **Artifacts**: deliverables become first-class cards in the message pane and in an Artifacts view per
     channel and per workspace — hosted apps/websites (apps broker, `https://<app>.delynith.com`), published
     sites, HTML renders, documents, decks, dashboards, files — each with thumbnail, title, short
     description, the agent that built it, cost and time, and "Open"/"View this artifact".
   - **Agents with their own computer**: surface the existing browser, shell, bench (performance bench) and
     hosting as the agent's "computer" in its profile.

## Done means

- A human can create public and private channels, DMs and group DMs; invite humans and agents.
- Agents only see channels they belong to; private channels are hidden from non-members.
- Per agent per channel: mention / always (gated) / always (no gate) / coordinator.
- The gate stops off-topic answers in group chats, and logs why.
- Threads, reactions, mentions, edits, unread, activity work like Slack on desktop and web.
- Discord channels can be bridged to workspace channels.
- A Fleet view, step trails on agent answers, and Artifacts cards/views exist (phase 7).
- Everything deployed on the live server.

## Status (2026-10-29)

All seven phases are done on `main` and deployed on the live server, including the final gaps
(coordinator routing as a channel option, message links from outside the app, Discord bulk deletions).

| Phase | Status | What shipped |
| --- | --- | --- |
| 1. Model + backend core | Done | Channel `kind`, `visibility`, `topic`, `description`, `humanMemberIds`, `createdBy`; per-agent `answerMode` and `focus`; visibility filtering for people and agents; threads, reactions, mentions, edit and delete; DMs and group DMs on channels; `workspace-v1` routes and IPC; `channel-message` and `channel-message-removed` events; `openbot-workspace-v1.json`. No migration was necessary. |
| 2. Responder pipeline + gate | Done | Answer modes (`mention`, `always`, `always-no-gate`, `lead`); the gate on `GateGenerations` with its own budget; one answer first, a second round for the others, at most 2 gated answers; thread-aware delivery; mention chain limit 3; decision log for owners and admins. Coordinator routing is now a channel option (`routing`, `set-routing`, with a lead picker in Channel details → Settings). |
| 3. Slack UI | Done | Desktop and web: layout, sidebar (Threads, Activity, Fleet, Artifacts, channels, DMs), Slack rows, composer with mentions, `#` links and formatting, thread panel, channel details, create-channel and new-message dialogs, profiles, ⌘K, Alt+Up/Down, Escape; one pane at a time on a phone. |
| 4. Agent behavior settings | Done | Server settings → Workspace (default answer mode, gate model, effort and time limit); agent settings → In channels (answer mode and focus defaults); DM list shows only agents the reader can chat with; the owner's agent DM is the main chat. |
| 5. Discord bridge | Done | Link a channel with a Discord text channel; both directions, Discord name and picture, webhook posts with each author's name; edits and deletions in both directions; bulk deletions in Discord (`MESSAGE_DELETE_BULK`) delete the bridged messages. |
| 6. Polish | Done | Typing, thinking and working lines; public/private switch; onboarding into `#general`; emoji picker; unread banner and jump; sidebar filter, order and mute; message links (in place in the app, and now from outside the app through `openbot://workspace/...`); fast long channels; i18n in all 12 catalogs. |
| 7. Fleet and artifacts | Done | Fleet view with live status, last step, cost and time today, usage-limit waits; step trails on agent answers; Artifacts cards and views for apps, sites, documents, decks, dashboards and files. |

Verified live on 2026-10-29: the gate (an off-topic message stayed quiet, an on-topic one got an
answer), threads, reactions, Fleet, Storage, a private channel, and the Discord bridge both ways
(a reply and a 👍 from Discord in the workspace thread, the agent's answer back in Discord, unlink).

### Known limits

Closed on `wip/ws-limits`: Discord reactions and threads, a workspace post deleted in Discord,
artifact thumbnails, the stored artifact index, typing without the focus, the emoji listbox, and
the sidebar order and mutes for the account.

- Webhook posts (each author's own name and picture in Discord) need the bot's Manage Webhooks
  permission in the Discord server. Without it the bot posts as itself with `**Name:**` in front.
- A thread reply in Discord quotes the newest post of its thread. Posts bridged before 2026-10-29
  carry no thread root, so a reply to such a thread quotes its first message.
- A custom Discord emoji shows as `:name:` text in the workspace and is not mirrored back. A super
  reaction counts as a plain one. A moderator's "remove all reactions" or "remove this emoji" in
  Discord removes the Discord people's reactions in the workspace; those of the workspace's own
  people and agents stay, and OpenBot does not add its removed reactions back.
- A Discord person's reaction shows as the member `discord-<user id>`, the author id of their
  bridged messages.
- A workspace post that someone deletes in Discord stays in the workspace (by design); the bridge
  forgets its Discord ids, so a later edit or deletion does not call Discord.
- Artifact thumbnails are PNG: Electron's `nativeImage` has no WebP encoder. The address check
  resolves the name before Chromium does, so a DNS answer that changes in between (rebinding) is not
  caught; every request of the page goes through the check again.
- A change of the sidebar order or the mutes on another computer shows at the next load or
  reconnect: the host sends no event for it.
- With coordinator routing, the answer modes, the gate and the mention chains between agents do not
  apply; only an agent that a person mentions answers directly.
- A message link opens only on a server that this computer joined, in a channel the reader can see.
