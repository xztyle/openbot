# Slack parity: behavior spec, gap analysis and backlog for the OpenBot workspace

Date: 2026-11-18. Repo state read: `openbot-dev` at `31be19ed3`. Research and code reading only; no code changed.

Goal from the user: "investigate way more deeply how Slack works, and let's fix our page so it works just like Slack."

Contents

1. How to read this file (legend, source keys, path keys)
2. Scope: what we copy, what we skip, where agents need a different rule
3. Behavior spec + gap analysis, by area (A to R)
4. Ranked backlog (top 30)
5. Work packages for parallel build (with file ownership)
6. Open product decisions
7. Appendix: things OpenBot already does like Slack

---

## 1. How to read this file

Each area has a table. One row is one rule.

| Column | Meaning |
|---|---|
| ID | Stable id, such as `C3`. The backlog refers to it. |
| Slack rule | What Slack does, with a source key in brackets. `[CK]` means common knowledge that no primary source confirmed. Treat `[CK]` as a sensible default that is easy to change. |
| OpenBot today | What the code does, with `file:line`. "None" means no code for it exists. |
| Change | What to build. "Keep" means OpenBot already matches. |
| Eff | Effort. S = under a day. M = 1 to 4 days. L = more than 4 days, or it needs a backend change, a migration, or a new Team API version. |
| Imp | Impact on "feels like Slack" for this product. H, M or L. |

### 1.1 Source keys

| Key | URL |
|---|---|
| KBD | https://slack.com/help/articles/201374536 (keyboard shortcuts) |
| NAV | https://slack.com/help/articles/360000411963 (navigate with keyboard and screen reader) |
| A11Y | https://slack.com/help/articles/115003340723 (keyboard basics) |
| A11YLOG | https://slack.com/help/articles/50668520513939 (accessibility changelog, includes 2025-2026 UI changes) |
| SIDEBAR | https://slack.com/help/articles/212596808 and the 2024 copy https://web.archive.org/web/2024/https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences |
| SECTIONS | https://slack.com/help/articles/360043207674 (sidebar sections, filter, sort) |
| READ | https://slack.com/help/articles/201457107 (send and read messages, drafts and sent) |
| MARKREAD | https://slack.com/help/articles/360043037853 (mark as read preference) |
| UNREADS | https://slack.com/help/articles/226410907 (Unreads view, Catch up) |
| ACT | https://slack.com/help/articles/19693583638803 (Activity) |
| ACT26 | https://slack.com/help/articles/46751260742035 (2026 Activity view) |
| ACTOLD | https://slack.com/help/articles/45573197224467 (2023-2025 Activity) |
| NOTIF | https://slack.com/help/articles/201355156 (notification preferences) |
| CHNOTIF | https://slack.com/help/articles/360056534254 (per-conversation notifications) |
| MUTE | https://slack.com/help/articles/204411433 |
| HERE | https://slack.com/help/articles/202009646 (@here, @channel, @everyone) |
| DND | https://slack.com/help/articles/214908388 |
| FOCUS | https://slack.com/help/articles/51416500176147 |
| THREADS | https://slack.com/help/articles/115000769927 |
| EDIT | https://slack.com/help/articles/202395258 |
| PERMS | https://slack.com/help/articles/115004868646 (edit and delete permissions) |
| MODIFY | https://docs.slack.dev/messaging/modifying-messages |
| REACT | https://slack.com/help/articles/202931348 |
| EMOJIPREF | https://slack.com/help/articles/4406393601683 |
| FORMAT | https://slack.com/help/articles/202288908 |
| ENTER | https://slack.com/intl/en-ie/help/articles/115005523006 |
| SCHED | https://slack.com/help/articles/1500012915082 |
| FILES | https://slack.com/help/articles/201330736 |
| MENTIONS | https://slack.com/help/articles/205240127 |
| SLASH | https://slack.com/help/articles/201259356 |
| SEARCH | https://slack.com/help/articles/202528808 |
| QS | https://slack.engineering/a-faster-smarter-quick-switcher/ |
| BROWSE | https://slack.com/help/articles/205239967 |
| CREATE | https://slack.com/help/articles/201402297 and https://docs.slack.dev/reference/methods/conversations.create |
| ARCHIVE | https://slack.com/help/articles/213185307 |
| LEAVE | https://slack.com/help/articles/201375146 |
| DMS | https://slack.com/help/articles/212281468 |
| PRES | https://slack.com/help/articles/201864558 |
| TABS | https://slack.com/help/articles/32562841868307 (conversation tabs, pins, folders, links) |
| SAVED | https://slack.com/help/articles/360042650274 |
| TODOS | https://slack.com/help/articles/55757634348435 (Later is now To-dos, Oct 2026) |
| REMIND | https://slack.com/help/articles/208423427 |
| FWD | https://slack.com/help/articles/203274767 |
| DISPLAY | https://slack.com/intl/en-gb/help/articles/213893898 (message display) |
| UNFURL | https://slack.com/help/articles/204399343 |
| MOBHOME | https://slack.com/help/articles/29788684062739 (mobile Home) |
| IOSRN | https://slack.com/release-notes/ios |
| IOS26 | https://slack.com/blog/news/redesigning-slack-ios26 |
| AIAPPS | https://docs.slack.dev/ai/developing-ai-apps |
| AIHELP | https://slack.com/intl/en-gb/help/articles/33076000248851 (AI apps in Slack) |
| SESS | https://docs.slack.dev/ai/agent-sessions |
| STREAM | https://docs.slack.dev/reference/methods/chat.startStream |
| SETSTATUS | https://docs.slack.dev/reference/methods/assistant.threads.setStatus |
| REDESIGN | https://www.engadget.com/slacks-latest-redesign-has-a-dedicated-dm-tab-and-a-discord-style-activity-view-130032154.html and https://uit.stanford.edu/service/slack/redesign2023/sidebar |

The raw research notes (about 430 rules with sources) are in the session scratchpad:
`/tmp/claude-1000/-home-ubuntu/b4086e1f-0a21-58ba-8bfb-c48fca79100e/scratchpad/slack-research-nav.md` and
`/tmp/claude-1000/-home-ubuntu/b4086e1f-0a21-58ba-8bfb-c48fca79100e/scratchpad/slack-research-messages.md`.
Copy them in too if you want the long form.

### 1.2 Path keys

| Key | Path |
|---|---|
| UI/ | `packages/ui/src/features/workspace/` |
| UICSS/ | `packages/ui/src/features/workspace/styles/` |
| R/ | `src/renderer/src/features/workspace/` |
| CH/ | `src/renderer/src/features/channels/` |
| WEB/ | `src/renderer/src/features/web-client/` |
| BE/ | `src/backend/` |
| CT/ | `packages/contracts/src/` |
| CONV/ | `packages/ui/src/features/conversation/` |

### 1.3 Slack's layout timeline (so we copy the right version)

Slack changed its shell several times. This spec targets the late-2026 state, with notes where an older pattern fits OpenBot better.

- 2023: vertical tab rail (Home, DMs, Activity, Later, More), workspaces in a narrow left rail [REDESIGN].
- 2024-02: mobile "Catch up" (swipe through unreads) [IOSRN].
- 2025-09: consolidated tabs. Home, DMs, Activity, Files show by default; Later and Tools go under More; People and Channels move into a "Directories" page in Home [A11YLOG].
- 2026-01: new Activity view (DMs in Activity, Dense/Detailed layouts, custom views, clear). The DMs tab badge counts unread conversations, not messages [ACT26].
- 2026-08/10: Slackbot (an AI agent) gets its own tab; To-dos replace Later; Saved moves to the top of Home; on mobile the Slackbot tab replaces More [TODOS, A11YLOG].

The 2026 "AI agent gets a first-class tab" direction matches OpenBot: agents are teammates, and Fleet is our equivalent of Slack's "Agents & tools".

---

## 2. Scope

### 2.1 Skipped (not relevant to an AI-teammate workspace)

Huddles, calls, clips (audio/video), Slack Connect and external organizations, guests and guest roles, canvases, lists, workflows and Workflow Builder, templates, custom emoji upload, user groups, Enterprise org policies, temporary channel joins, Slack AI recap and summaries (OpenBot agents can do this on request), focus mode, scheduled status, VIPs, channel templates, "Unsend" (Cmd+Z within 15 s; an agent may already act on the message, see R9).

### 2.2 Agent-specific adaptations (where Slack's model needs a change)

| Slack concept | OpenBot adaptation |
|---|---|
| "X is typing…" under the composer [CK] | Keep the human line. For agents, keep OpenBot's "X is working… <current step>" with an expandable step trail (UI/TypingIndicator.tsx:1-78). Slack's own agent surface shows "Working…" and a Stop button [SESS, SETSTATUS]. Add Stop (R2). |
| Agent session status: processing, active, suspended (needs input), closed [SESS] | Map to OpenBot agent states: working, idle, waiting (approval, question, browser takeover, usage limit). Show "Needs attention" the same way in the sidebar row, Activity and Fleet (R3). |
| Streamed answer with task cards ("timeline") or a plan block, collapsed by default [STREAM] | OpenBot already folds agent commentary into a StepTrail above the answer (R/workspace-model.ts:435-515, UI/StepTrail.tsx). Keep it collapsed after the answer, open while streaming. |
| "APP" badge after a bot name [CK]; agents "labeled as an agent" [AIAPPS] | Keep OpenBot's AI badge (UI/WorkspaceAvatar.tsx `AiBadge`). Show it on every agent author row, not only in DMs. |
| Bot messages never show "(edited)" [MODIFY] | An agent that edits its own streaming answer must not show "(edited)". |
| Thread auto-follow: you follow if you started, replied or were mentioned [THREADS] | Also follow a thread when you assigned work to an agent in it (you mentioned the agent), so its answer reaches Threads and Activity. |
| Channel unread from top-level messages only; thread-only replies do not bold the channel [THREADS] | Already true (BE/channel-store.ts:250-264). Agent commentary and plan items are not unread (same lines). Keep. |
| @here = active members only [HERE] | Agents are always "active". `@here` reaches every human who is active and every agent with answer mode that listens to broadcasts. Decide per agent answer mode (see section 6). |
| Message actions for apps: "More message shortcuts" [CK] | Agent-specific actions in the "More" menu: "Ask <agent> to redo", "Stop this work", "Open the agent's chat". Optional, after parity. |
| Unsend within 15 s | Skip. Use Stop (R2) instead, because the agent may already act. |

---

## 3. Behavior spec and gap analysis

### A. Shell, navigation and history

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| A1 | Desktop regions in F6 order: top bar (history, search), tab rail, workspace rail, navigation list, primary view, secondary view (thread/details), control strip [NAV]. | Space rail + sidebar + main + right panel (UI/WorkspaceLayout.tsx:1-94, R/WorkspaceSidebarPane.tsx:173-235). No top search bar; no tab rail; views are rows at the top of the sidebar (UI/WorkspaceSidebar.tsx:159-244). | Keep the layout. Optional: compact the 8 quick rows (Threads, Activity, Fleet, Agents, Artifacts, Between agents, Storage, Secrets, Apps) into Slack's pattern: a few fixed rows (Unreads, Threads, Activity, Drafts & sent, Saved) and put Fleet, Artifacts, Between agents, Storage, Secrets, Apps under one "More" row or a tab rail. See section 6, decision D1. | M | M |
| A2 | Back/forward history across conversations and views: Cmd+[ / Cmd+] (Mac), Alt+Left/Right (Win) [KBD]. | Desktop history covers agents, channels and direct members only (src/renderer/src/navigation.tsx:230-238). Views (Activity, Threads, Fleet) and thread panels are not history entries. Web uses browser history (WEB/web-location-history.ts). | Record workspace views and open threads as history entries on desktop. | M | M |
| A3 | Space (workspace) switcher: rail of workspace icons with unread dot and mention count; Cmd+1..9 jumps to a workspace; Ctrl+Tab next [KBD, SIDEBAR]. | Space rail exists with unread and mention marks (R/WorkspaceSpaceRail.tsx:11-18). No keyboard switch. | Add Cmd/Ctrl+Shift+1..9 (or Ctrl+Tab) to switch spaces. Keep marks. | S | L |
| A4 | Cmd+. hides or shows the right pane [KBD]. | Esc closes the panel (R/WorkspaceView.tsx:52-56). No Cmd+. | Add Cmd/Ctrl+. toggle. | S | L |
| A5 | Reload restores the last tab and conversation per workspace, and open thread panes where possible; scroll is not restored literally; the conversation reopens at the first unread [CK, MARKREAD]. | Last channel restored (CH/channels-controller.ts:425-475); last view or thread restored on desktop (R/workspace-controller.ts:1425-1460). With nothing saved the route is Activity (R/workspace-controller.ts:580). | Keep. Also restore the place on web (rememberPlace is desktop-only per R/desktop-workspace.tsx `rememberPlace: true`). | S | M |
| A6 | Keyboard shortcut list opens with Cmd+/ [A11Y]. | GlobalSearch has a shortcuts action (packages/ui/src/components/GlobalSearch.tsx:90). No workspace shortcut sheet. | Add a workspace shortcuts sheet (Cmd+/) that lists the shortcuts in section Q. | S | L |

### B. Sidebar (Home)

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| B1 | Top-of-sidebar pages: Unreads, Threads, Drafts & sent, Saved (and Directories); user picks which always show [SIDEBAR, TODOS]. | Rows: Threads, Activity, Fleet, Space agents, Artifacts, Between agents, Storage, Secrets, Apps (UI/WorkspaceSidebar.tsx:159-244). No Unreads, Drafts & sent, Saved. | Add Unreads (E-area), Drafts & sent (G9), Saved (M6). Let the user hide rows (store in sidebar prefs). | M | H |
| B2 | Sections: Starred, Channels, Direct messages, Apps, plus custom sections; drag between sections; drag section headers to reorder [SECTIONS]. | Two fixed groups: Channels and Direct messages (UI/WorkspaceSidebar.tsx:246-357). Manual drag order inside a group (UI/WorkspaceSidebar.tsx:493-535), synced to the host (R/workspace-controller.ts:808-934). | Add Starred, then custom sections (name + emoji). Extend `WorkspaceSidebarPrefs` with `sections: {id, name, emoji, ids[], sort, filter}` and `starred`. The host stores prefs as one bounded record, so the change is additive. | M | M |
| B3 | Per-section sort: A-Z, Recency, Priority. Per-section filter. Sidebar-wide "Show": All / Unreads only / Mentions only. Default filter "Active only" hides conversations with no activity in 30 days [SECTIONS, SIDEBAR]. | Channels sorted A-Z (R/workspace-model.ts:220) unless the reader dragged an order (R/workspace-controller.ts:342-358). DMs newest first (R/workspace-model.ts:265). Text filter field only (R/WorkspaceSidebarPane.tsx:192-207). | Add a "Filter and sort" menu on each group header: sort A-Z / Recent activity / Custom (= today's drag order), show All / Unreads only / Mentions only. Store per group in sidebar prefs. | M | H |
| B4 | A collapsed section still shows its unread rows and the open conversation; the header announces "has unreads" [SECTIONS, A11YLOG]. | Collapsing hides every row (UI/WorkspaceSidebar.tsx:457-459). Collapse state is a local signal, lost on reload (UI/WorkspaceSidebar.tsx:119-120). | Collapsed group: render unread rows, mention rows and the active row. Persist collapse in sidebar prefs. Alt+click a header collapses or expands all. | S | H |
| B5 | Row: bold name = unread; red pill with a number = mentions (channels) or every unread message (DMs); badge shows even when muted [SIDEBAR, MUTE]. | Bold via `data-unread` (UI/WorkspaceSidebar.tsx:547); mention pill (566-570); DM pill = unread count (R/workspace-model.ts:260); muted rows hide the bold (547). | Keep. Show the mention pill on muted rows too (today `data-unread` is cleared for muted, which is right; check the pill is still drawn, it is: 566). Keep. | – | – |
| B6 | Muted conversations are hidden by default; "Show muted conversations" brings them back, dimmed [MUTE, SIDEBAR]. | Muted rows stay in the list, dimmed (UI/WorkspaceSidebar.tsx:548). | Add "Hide muted conversations" toggle in the group menu, default on (Slack default), with the open muted row always shown. | S | L |
| B7 | A conversation with a draft shows a pencil icon by its name [CK]. | None. Drafts exist per conversation and thread (R/workspace-controller.ts:1649-1691). | Show a pencil icon on rows whose draft key has text (channel key or any `channel/thread` key). | S | M |
| B8 | Row right-click menu: Open in new window, Copy link, Mark as read, Mute, Move to section, Star, Change notifications, Leave [CK, NAV]. | Open, Details or agent settings, Between agents, Mute, Move up, Move down, Move to space, Close (DM), Leave (R/WorkspaceSidebarPane.tsx:72-165). | Add Mark as read, Copy link, Star/Move to section, Notifications submenu (N2). Keep Move up/down as the keyboard path for custom order. | S | M |
| B9 | Up/Down move between rows; Enter opens and focuses the composer; Alt+Up/Down opens previous/next conversation; Alt+Shift+Up/Down opens previous/next unread [NAV, KBD]. | Up/Down/Home/End (UI/WorkspaceSidebar.tsx:591-604); Alt+Up/Down (R/WorkspaceView.tsx:42-46, R/workspace-controller.ts:1564-1571). No unread variant. | Add Alt+Shift+Up/Down over rows with unread or mentions, in sidebar order. Enter on a row moves focus into the composer. | S | M |
| B10 | Mobile: long-press a row = peek without marking read, plus Mark as read, Mute, Copy link, Leave [IOSRN]. | Right-click menu only; touch long-press relies on Kobalte ContextMenu (unverified on iOS Safari, which fires no `contextmenu` on long-press). | Add an explicit long-press handler on touch that opens the row menu as a bottom sheet (shared with D7). | S | M |
| B11 | DM rows show the person's photo with a presence dot; group DMs show stacked faces; agent rows show "working" [SIDEBAR]. | Done: avatar + status (UI/WorkspaceSidebar.tsx:377-390), AI badge and working pulse (326-331). | Keep. | – | – |

### C. Read state, unread and "New" line

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| C1 | Opening a conversation marks it read soon after; it lands on the first unread with the red "New" line, or on the newest message when all is read (default "Start where you left off") [MARKREAD, NAV]. | On first page the held unread count is kept and the channel is marked read (CH/channels-controller.ts:238-262); the list scrolls to the divider (R/WorkspaceMessageList.tsx:182-203). Read only while the window has focus (CH/channels-context.tsx:68; WEB/WebWorkspace.tsx:1342). | Keep. | – | – |
| C2 | The "New" line stays while you remain in the conversation, also after it is marked read; it goes when you come back with nothing unread [CK]. | Held until leave, mark read (Esc) or mark all (CH/channels-controller.ts:31-42, 635-637). Esc removes it at once (R/workspace-controller.ts:1635-1646). | Let Esc mark read but keep the line until the reader leaves. | S | L |
| C3 | Banner at the top when the first unread is above the view: "N new messages since 10:15 AM" + "Mark as read"; clicking jumps up [CK]. | Done: "unread since <time>" + Mark as read (R/WorkspaceMessageList.tsx:284-302). No count. | Add the count ("12 new messages since 10:15 AM"). | S | L |
| C4 | Scrolled up and new messages arrive: floating pill "New messages" / "Jump to recent" near the bottom [CK]. | Done (R/WorkspaceMessageList.tsx:303-318). | Keep. | – | – |
| C5 | Esc marks the conversation read; Shift+Esc marks everything read (with a confirm) [KBD]. | Esc done (R/WorkspaceView.tsx:48-58). Shift+Esc none; "Mark all as read" in the workspace menu (R/desktop-workspace.tsx `mark-read` item). | Add Shift+Esc with a confirm dialog that has "Don't ask again". | S | M |
| C6 | Mark unread: message menu "Mark unread", Alt/Option+click a message, key U on a focused message. The line moves to that message and the conversation goes bold again; it stays unread until you leave [READ, KBD, CK]. | None. The read pointer can only go forward: `MAX(through_sequence, excluded.through_sequence)` (BE/channel-store.ts:992-1011). | Backend: a new channel command `mark-unread {channelId, beforeSequence}` that sets the pointer exactly. Team API: add it in a new channels protocol version or behind a capability; do not change `read` (released adapters are permanent). Client: menu item, Alt+click, U key; keep the conversation unread until the reader leaves (suspend `readLive`, CH/channels-controller.ts:484-491). | L | H |
| C7 | Thread read state is per thread. Reading a channel does not read its threads; opening a thread reads it [THREADS, CK]. | One pointer per channel. Thread unread counts compare thread replies with the channel pointer (BE/channel-activity.ts:289-309), and opening the channel moves that pointer past every reply (CH/channels-controller.ts:249-262). So opening a channel silently clears its thread unreads. | Backend: per-thread read pointers (`projection_thread_reads (channel_id, root_id, member_id, through_sequence)`), migration with preservation fixtures, a `read-thread` command, thread unread from that table. Client: mark a thread read when its panel shows the newest reply, or when it is viewed in the Threads view. | L | H |
| C8 | Unreads view (Cmd+Shift+A): every unread message grouped by conversation; per-group "Mark as read" with Undo; "Mark all messages read" at the bottom; Esc marks the focused group read; no live insert, a refresh icon appears [UNREADS]. | None. | New view "Unreads". Build from channel summaries with `unreadCount > 0` plus `readChannel` pages from the read pointer. Muted channels excluded. | M | H |
| C9 | Read state syncs across devices [IOSRN]. | The pointer is on the host; the sidebar re-reads on focus (CH/channels-controller.ts:476-482). | Keep. | – | – |
| C10 | Cmd+J jumps to the oldest unread in the conversation [KBD]. | The banner button does it (R/WorkspaceMessageList.tsx:138-144). No key. | Bind Cmd/Ctrl+J to `jumpToUnread`. | S | L |

### D. Message list and message rendering

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| D1 | Clean layout: avatar, name, time; follow-ups from the same author within about 5 minutes show no header, with the time in the left gutter on hover [DISPLAY, CK]. Grouping breaks on a date divider, a broadcast reply, a system message. | Done: 5-minute grouping, break on day and on the "New" line (R/workspace-model.ts:59, 455-476); gutter time (UI/MessageRow.tsx:90-98). | Keep. Also break grouping on a broadcast thread reply (D9). | S | L |
| D2 | Date divider pill "Today" / "Yesterday" / "Monday, November 16th" (year when not this year); sticky at the top while you scroll that day; click opens "Jump to…" (most recent, last week, last month, beginning, a date) [CK]. | Labels done (UI/MessageDividers.tsx:11-34). CSS is sticky (UICSS/workspace-messages.css:443-450), but the divider sits inside a translated virtual row (R/WorkspaceMessageList.tsx:258-266), so it is sticky only inside that row (unverified in a live run). | Draw one floating date pill over the list, with the day of the first visible row. Jump-to-date menu is optional. | S | L |
| D3 | Hover a message: grey row background and a floating toolbar at top right [CK]. Toolbar left to right: 3 one-click reactions (user-set), Add reaction, Reply in thread, Forward, Add to-do / Save, More actions (⋮) [REACT, THREADS, FWD, TODOS, SAVED]. | Toolbar: 3 quick reactions, react picker, Reply, More (UI/MessageRow.tsx:146-197). Quick reactions = recent emoji first, then 👍 ❤️ 😂 🎉 👀 ✅ (UI/MessageRow.tsx:27; R/workspace-controller.ts:990-994). | Add "Save" (M6) to the toolbar when it exists. Make the 3 one-click reactions a stable user setting (Slack does not reorder them by recent use); default ✅ 👀 🙌 [EMOJIPREF]. Forward is optional (section 6, D4). | S | M |
| D4 | More menu (⋮) and right-click: Turn off / Get notified about replies, Mark unread, Remind me, Add to saved, Copy link, Copy message, Pin to channel, Send reply to channel (thread replies), Edit message, Delete message (red, last) [THREADS, READ, REMIND, SAVED, FWD, A11YLOG, TABS, EDIT]. | Reply, Edit (own), Copy text, Copy link, Delete (own or admin) (R/WorkspaceMessage.tsx:111-157). Right-click shows the same items (UI/MessageRow.tsx:78). | Add Mark unread (C6), Follow/Unfollow thread (H5), Pin (M5), Save (M6), Send reply to channel (H4). Order: Follow, Mark unread, Save, Copy link, Copy text, Pin, Send to channel, Edit, Delete. | S each after backend | M |
| D5 | Focused-message keys: E edit, Delete delete, T or Right open thread, R react, U mark unread, P pin, A save, M remind, F forward [KBD]. Up/Down move by message (one tab stop for the list); Home/End; Shift+PageUp/Down by day [A11Y, NAV]. | Every message is its own tab stop (`tabindex="0"`, UI/MessageRow.tsx:81). No keys. | Roving focus in R/WorkspaceMessageList.tsx: one tab stop, Up/Down move, Enter/Right opens the thread, keys E, Delete, T, R, U, P, A. Up from an empty composer edits (today) or focuses the list (Slack preference). | M | M |
| D6 | "(edited)" after the text; tooltip with edit time. Bots never show "(edited)" [MODIFY]. | "(edited)" shown for any edited message (UI/MessageRow.tsx:126-128). | Add the edit-time tooltip. Do not show "(edited)" on agent messages. | S | L |
| D7 | Touch: no hover bar. Long-press a message opens a bottom sheet: quick reactions row + Add reaction, then Reply in thread, Forward, Save, Copy text, Copy link, Mark unread, Remind, Pin, notifications for replies, Edit, Delete (red) [REACT, IOSRN, CK for order]. Long-press a reaction pill shows who reacted [REACT]. | On `hover: none` every message draws its action bar under the text (UI/MessageRow.tsx:203-208; UICSS/workspace-messages.css:289-297). This clutters an iPhone transcript. | Hide the inline bar on touch. Add a long-press (450 ms, cancel on move) that opens a `MessageActionSheet` (bottom sheet) with the same items as D4 plus the quick reaction row. Tap still opens links and threads. | M | H |
| D8 | Delete top-level message without replies: it goes. Delete a thread parent with replies: "This message was deleted." placeholder, replies stay [MODIFY]. | Done: deleted rows show only when they have replies (R/workspace-model.ts:294-309); placeholder text (UI/MessageRow.tsx:119-121). | Keep. | – | – |
| D9 | A thread reply also sent to the channel shows in the channel with a context line "replied to a thread: <parent preview>" [CK]. | Shown in the channel (CT/ipc-chat-workspace.ts:298-300) but with no context line (no `alsoInChannel` use in R/*.tsx). | Add the context line; click opens the thread. | S | M |
| D10 | Permalink open: scroll the message into the middle, flash a yellow highlight that fades in about 2 s; a thread reply opens the thread pane with the reply lit [CK]. | Scrolls to and marks the linked message until the reader leaves the channel (R/WorkspaceMessageList.tsx:151-178; `data-highlighted`). | Fade the highlight after 2 to 3 s (keep the thread-root highlight while its panel is open). | S | L |
| D11 | Channel intro at the top of history: "This is the very beginning of #name", description, Add people [CK]. | Done (R/WorkspaceChannelPane.tsx:463-514). | Keep. | – | – |
| D12 | Infinite scroll up, anchor stays fixed while older pages load [CK]. | Done (R/WorkspaceMessageList.tsx:85-112, 233). | Keep. | – | – |
| D13 | Link unfurls under the message, removable with an "x"; none if more than 5 links [UNFURL]. | Artifact links get cards (R/WorkspaceMessage.tsx `ArtifactCard`); no general unfurl. | Optional: general link previews (needs a fetch on the host). Skip for now. | L | L |
| D14 | Emoji-only messages render jumbo [EMOJIPREF]. | None. | Render a message of 1 to 3 emoji at about 2x size. | S | L |

### E. Edit and delete

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| E1 | Desktop edit is in place: the message body becomes an editor with Cancel and Save; Enter saves, Esc cancels; saving empty text asks to delete [EDIT, CK]. Mobile: edit in the composer, check-mark saves [EDIT]. | Edit happens in the bottom composer with an "Editing" notice (R/WorkspaceComposer.tsx:62-73, 284-303). | Desktop: inline editor in the message row (MessageRow gets an `editor` slot; reuse `ComposerEditor`). Phone: keep the composer path. Empty save opens the delete dialog. | M | M |
| E2 | Up in an empty composer edits your last message in this conversation or thread [KBD]. | Done (R/WorkspaceComposer.tsx:245-268). | Keep; it now opens the inline editor. | – | – |
| E3 | Delete confirm: dialog "Delete message" with a preview of the message, "Cancel" / "Delete" (red) [EDIT]. Shift-click skips the confirm [CK]. | Confirm dialog with title and text (R/WorkspaceDialogs.tsx:491-510). | Add the message preview. Shift+click Delete skips the dialog. | S | L |
| E4 | Owners and admins set an edit window (any time, never, N minutes) and who may delete [PERMS]. | Own messages editable any time; delete by own or admin (R/WorkspaceMessage.tsx:121-155). | Keep "any time" (Slack default). No setting needed now. | – | – |

### F. Reactions and emoji

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| F1 | Pills: emoji + count; yours highlighted blue; click toggles; hover tooltip "Reacted by A, B and 3 others"; an Add reaction button at the end of the row [REACT, CK]. | Done (UI/MessageRow.tsx:271-312). | Keep. Use "and N others" when more than 3 actors. | S | L |
| F2 | Limits: 23 reactions per person per message, 50 unique emoji per message [REACT mirror]. | No limit in UI. | Cap in the UI and the host command. | S | L |
| F3 | Picker: search autofocused, Frequently used first, categories, skin tone, hover shows `:code:` [REACT, CK]. Frequently used syncs across devices [IOSRN]. | Picker with recent and skin tone, kept in localStorage per computer (R/workspace-controller.ts:306-318). | Sync recent emoji and skin tone through the host sidebar prefs. | S | L |
| F4 | Cmd/Ctrl+Shift+\ reacts to the last message; typing `+:emoji:` reacts to the last message instead of sending [KBD, CK]. | None. | Add both. | S | L |

### G. Composer

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| G1 | Desktop: Enter sends, Shift+Enter adds a line; preference to swap (Ctrl/Cmd+Enter sends) [READ, ENTER]. | Done in the editor (CONV/ComposerEditor.tsx:990-1003). The agent chat honors the user's send-key preference (src/renderer/src/features/conversation/ConversationComposer.tsx:56); the workspace composer passes no `sendShortcut`, so it is always Enter (R/WorkspaceComposer.tsx:328-346). | Pass `sendShortcut={deviceSendShortcut(platform)}` so the user's preference applies here too. | S | M |
| G2 | Phone: Return adds a line; only the paper-plane sends; long-press the paper-plane schedules [SCHED, CK]. | Return sends on iPhone, because G1's prop is missing and the default is Enter. The shared rule already exists: `effectiveSendShortcutMode(mode, touchLayout)` returns `mod-enter` on touch (CONV/send-shortcut.ts). | Use `effectiveSendShortcutMode` for the workspace composer. | S | H |
| G3 | In a code block, Enter adds a line; in a list, Enter adds an item and Enter on an empty item ends the list; Cmd/Ctrl+Enter always sends [CK]. | Plain-text Markdown editor; Enter sends everywhere (CONV/ComposerEditor.tsx:995-1003). | When the caret is inside an open ``` fence, Enter adds a line. List continuation is optional. | S | M |
| G4 | Formatting toolbar at the top of the box, shown by default, toggled with "Aa"; Bold, Italic, Strike, Link, Ordered, Bulleted, Quote, Code, Code block; shortcuts Cmd+B, I, Shift+X, Shift+U, Shift+7/8/9, Shift+C, Alt+Shift+C [FORMAT, KBD]. | Toolbar with Bold, Italic, Strike, Link, Lists, Code; toggle; hidden by default in threads (UI/MessageComposer.tsx:25-33, 83, 92-110). No Quote, no Code block. | Add Quote (Cmd+Shift+9) and Code block (Cmd+Alt+Shift+C). Remember the toggle state. | S | L |
| G5 | Autocomplete: `@` members first (recent first), then @here/@channel, then non-members marked "Not in channel"; `#` channels; `:` + 2 chars emoji; Up/Down, Tab/Enter insert, Esc closes, Enter never sends while open [MENTIONS, A11YLOG, CK]. | `@` offers all people and only the agents of the conversation, plus broadcasts in channels; `#` channels (R/WorkspaceComposer.tsx:105-131). Emoji autocomplete: not confirmed in the workspace editor. | Sort `@` by channel members first and recent use; show people who are not in the channel with a "Not in channel" tag. Confirm `:` emoji autocomplete works here. | S | M |
| G6 | @channel/@here/@everyone in a channel with 6 or more members asks to confirm before sending [HERE]. | No confirm. | Confirm dialog "This notifies N people" when the text has a broadcast and the channel has at least 6 human members (agents excluded from N, see section 6). | S | M |
| G7 | Mentioning someone not in the channel: after sending, an ephemeral prompt "Invite them" / "Do nothing" [MENTIONS, CK]. | None. | Show a local, dismissible notice under the sent message with "Add to channel". For agents this matters: an agent mentioned but not a member does not answer. | S | M |
| G8 | Drafts save per conversation and thread, survive reload, and sync across devices; the row shows a pencil [READ, CK]. | Per conversation and thread, in localStorage per computer (R/workspace-controller.ts:256, 371-395, 1678-1691). Files of a draft live in memory only (1656-1668). | Keep local drafts now. Host sync is a later step (backend, per member). Pencil icon: B7. | L (sync) | M |
| G9 | "Drafts & sent" page: tabs Drafts, Scheduled, Sent; hover a draft to edit or delete; click a sent message to jump to it [READ]. | None. | New view: Drafts (from local drafts), Sent (the reader's recent messages; host query by author). Scheduled only if G10 lands. | M | M |
| G10 | Schedule send: arrow next to the paper-plane; presets "Tomorrow at 9:00 AM", "Monday at 9:00 AM", Custom; up to 120 days [SCHED]. | None. Routines exist for scheduled agent work. | Optional. Low value for an agent team; skip unless asked. | L | L |
| G11 | Files: + button, drag and drop with a "Upload to #channel" overlay, paste images; thumbnails in the box with a remove "x" and progress; Send waits for uploads [FILES, CK]. | Attach, paste on web, drop/paste import on desktop, chips with remove (R/WorkspaceComposer.tsx:133-188, 304-325). No upload progress, no drop overlay. | Add a drop overlay over the message pane and a progress state on chips. | S | L |
| G12 | Placeholder "Message #channel", "Message Name", "Reply…" [CK]. | Done (R/WorkspaceChannelPane.tsx:235-245; R/WorkspaceThreadPanel.tsx:135-145). | Keep. | – | – |
| G13 | Slash commands at the start of the box (`/remind`, `/topic`, `/invite`, `/leave`, `/mute`, ...) [SLASH]. | None in the workspace. | Optional: `/topic`, `/invite`, `/leave`, `/mute`, plus agent commands (`/stop @agent`). | M | L |

### H. Threads

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| H1 | Thread opens in the right pane "Thread · #channel": root, "N replies" divider, replies, composer with "Also send to #channel"; mobile full screen [THREADS]. | Done (UI/ThreadPanel.tsx:1-56; R/WorkspaceThreadPanel.tsx). | Keep. | – | – |
| H2 | Reply summary under the root: replier faces, "N replies", "Last reply 2 hours ago" (hover: "View thread"); unread replies are marked [CK]. | Summary done (UI/MessageRow.tsx:417-438) but `unread` is never set (R/workspace-model.ts:544-552). | Set `unread` from per-thread read state (C7). | S after C7 | M |
| H3 | Thread pane follows new replies only when you are at the end; it keeps your place when you read up [CK]. | Every new reply scrolls the pane to the end (R/WorkspaceThreadPanel.tsx:60-75). Long agent answers in a thread yank the reader down. | Reuse the list's "follow when within 80 px of the end" rule and add the "New replies" pill. | S | H |
| H4 | Any thread reply can be sent to the channel after the fact: menu "Send reply to this channel" [THREADS]. | Only at send time (R/WorkspaceComposer.tsx:365-369). | Add the menu item; host sets `alsoInChannel`. | M | L |
| H5 | Auto-follow if you started the thread, replied, or were mentioned in it; in 1:1 DMs all threads; manual "Get notified about new replies" / "Turn off notifications for replies"; channel option "Follow every thread" [THREADS, CHNOTIF]. | Followed = threads where the reader wrote the root or a reply (BE/channel-activity.ts:126-188). Mentions in a thread do not follow it; no manual follow or unfollow. | Backend: follow table (member, channel, root, state followed/muted); auto-follow on mention and on DM threads; unfollow wins over auto-follow. UI: menu item and a bell in the thread header. | L | M |
| H6 | Threads view (Cmd+Shift+T): followed threads, unread first; each card shows channel, root, latest replies with "Show N more replies", and an inline reply box; hover: react, open in channel, save, turn off notifications; viewing a card marks it read [THREADS, A11YLOG, CK]. | List of followed threads, newest reply first, unread count pill; a click opens the thread panel (UI/ThreadsView.tsx:1-97; R/WorkspaceViews.tsx:103-128). | Sort unread first. Expand each card to show the last 2 replies and an inline composer (reuse WorkspaceComposer with `threadRootId`). Mark read on view (C7). | M | M |
| H7 | The Threads row goes bold when a followed thread has unread replies, also in a muted conversation for replies to your message [MUTE]. | Bold when any thread has `unreadCount > 0` (R/workspace-controller.ts:1024). | Keep; becomes correct once C7 lands. | – | – |
| H8 | Esc closes the thread pane; Right/T opens a thread from a focused message; Left returns [KBD, CK]. | Esc closes the panel (R/WorkspaceView.tsx:52-56). | Add Right/T and Left with D5. | S | L |

### I. Activity

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| I1 | One reverse-chronological feed: mentions, replies in followed threads, reactions to your messages, DMs, invitations, app notifications [ACT, NOTIF]. | Mentions, replies, DMs, reactions (BE/channel-activity.ts:104-224; UI/ActivityView.tsx:14). | Add "added you to #channel" invitations and agent "needs you" items (approval, question, browser takeover) as kinds (R3). | M | M |
| I2 | Filters: All, Mentions, Threads, Reactions, DMs (2026: tabs, plus Unreads toggle) [ACT26, ACTOLD]. | All, Mentions, Threads, DMs, Unread only switch (UI/ActivityView.tsx:80-103). No Reactions filter. Filter state is lost when leaving the view (local signal, line 58). | Add Reactions. Keep the filter while the session lasts. | S | L |
| I3 | Click an item: the message opens in the main view, scrolled to it and highlighted; a thread reply opens the thread with the reply lit; the Activity list stays reachable [NAV, ACT]. | A thread item opens the thread root; other items open the channel at its default place, not the message (R/WorkspaceViews.tsx:83-88). | Call `focusMessage(channelId, messageId)` (R/workspace-controller.ts:1584) before opening, for channel items and thread replies. | S | H |
| I4 | Mark read per item ("R"), clear per item ("C"), select with X, header checkbox for all; marking read unbolds the conversation but keeps the item [ACT26, ACT]. | One "Mark all as read" that marks every channel in the workspace read, not only the activity (R/WorkspaceViews.tsx:89-94 calls `channels.markAllRead`). | "Mark all as read" in Activity marks the conversations of the listed unread items only. Add per-item mark read on hover. | S | M |
| I5 | Badge: number = unread mentions, DMs, thread replies (thread replies optional); reactions never add to the badge [ACT, ACTOLD]. | `activityCount` counts every unread item including reactions (R/workspace-controller.ts:1023). | Exclude reactions from the count. | S | M |
| I6 | Mobile: swipe left on an item clears it; long-press gives remind, notification and mute options [ACT, IOSRN]. | None. | Swipe left = mark read on phone. | S | L |

### J. Direct messages

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| J1 | DMs tab: every DM and group DM, most recent first, with avatar, names, time right-aligned, one-line preview prefixed "You:" when you sent last; unread rows bold; filter unread; search field; new message button [DMS, REDESIGN, CK]. | DMs live in the sidebar group, newest first, no preview (R/workspace-model.ts:242-287). The owner's agent rows show only for agents written to in 30 days, waiting or opened (R/workspace-controller.ts:721-726). | New "DMs" view (desktop: a quick row; phone: a bottom tab) with preview and time from `ChannelSummary.lastMessage`, and agent rows from the agent's last reply. | M | H |
| J2 | DMs tab badge = number of unread conversations [ACT26]. | None. | Badge on the DMs tab/row. | S | M |
| J3 | Group DMs are named by member names; can be renamed; can become a private channel [DMS]. | Named by members (UI/WorkspaceSidebar.tsx:320-323). | Optional rename and convert. | M | L |
| J4 | Self-DM "Name (you)" as a notes space [CK]. | Reader-only DM falls back to the reader's name (R/workspace-model.ts:255-258). | Optional. | S | L |

### K. Jump to and search

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| K1 | Cmd/Ctrl+K opens Jump to. Empty query shows unread channels and DMs first (max 24). Ranking = fuzzy match + frecency (recent and frequent visits); word-start matches; separators optional ("devweb" finds #devel-webapp); initials match people ("dh") [QS]. | Cmd+K (R/WorkspaceView.tsx:35-41). Empty query: channels in store order, then agents, max 30 (R/WorkspaceDialogs.tsx:252-290). Ranking: prefix, word start, substring (291-305). Unread is only a style. | Empty query: unread first, then recent visits. Store visit counts per target locally. Add initials and separator-free matching. | M | H |
| K2 | Jump to also opens tabs and pages (Activity, Threads, Unreads, Drafts) and offers "Create channel <query>" when nothing matches [QS, NAV]. | Conversations, agents and people only. | Add the views (Activity, Threads, Fleet, Artifacts, Unreads, Drafts) and "Create #<query>". | S | M |
| K3 | Search (Cmd/Ctrl+G or the top field): recent searches; results for Messages, Files, People, Channels; modifiers `in:`, `from:`, `has:`, `is:thread`, `before:`, `after:`, `on:`, `during:`, `"phrase"`, `-word` [SEARCH]. | Global search covers agents, channel names (with the last message as detail), agent chat messages, files, routines (packages/ui/src/components/GlobalSearch.tsx:93-127; CH/global-search-channels.ts). Channel messages are not searchable. | Backend: full-text search over channel messages the reader can see (SQLite FTS5 table fed by the channel message projection; a migration). Route + IPC. UI: a "Messages" section in global search with `in:` `from:` `before:` `after:` `is:thread` parsing; results open with C/I3 focus. | L | H |
| K4 | Cmd/Ctrl+F searches the open conversation (dialog) [KBD, A11YLOG]. | `ChannelHeader` has a `search` slot (UI/ChannelHeader.tsx:31) that the pane does not fill (R/WorkspaceChannelPane.tsx:309-327). | After K3: Cmd/Ctrl+F opens search scoped `in:<this conversation>`. | S after K3 | M |

### L. Channels: browse, create, join, leave, archive

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| L1 | Browse channels (Cmd+Shift+L): public channels with member count and description; sort (most members, newest, A-Z…); filter "Hide my channels", archived [BROWSE, ARCHIVE, CK]. | Dialog with search, A-Z only, Join or Open, Create (R/WorkspaceDialogs.tsx:139-233). | Add sort and an "Archived" filter, a "Joined" tag, Cmd/Ctrl+Shift+L. | S | M |
| L2 | Selecting a channel you have not joined opens a preview: you read history; the composer is replaced by "You are viewing #name" + Details + "Join Channel"; it is not added to the sidebar [BROWSE, CK]. | The pane supports a not-joined state with a Join banner (R/WorkspaceChannelPane.tsx:436-447), but Browse only offers "Join" for such channels (R/WorkspaceDialogs.tsx:189-200). | Browse row click = preview (open without join); keep the Join button. | S | M |
| L3 | Name rules: lowercase letters, numbers, hyphens, underscores; max 80; spaces become hyphens as you type; unique incl. archived [CREATE]. | `slugChannelName`, `CHANNEL_NAME_MAX` (UI/workspace-format.ts re-exports from contracts). | Keep; check that uniqueness covers archived channels. | S | L |
| L4 | Leave: from the header name menu or `/leave`; private channels confirm; nobody leaves #general [LEAVE]. | Leave in row and header menus (R/WorkspaceSidebarPane.tsx:153-163; R/WorkspaceChannelPane.tsx:293-303). | Confirm for private channels. | S | L |
| L5 | Archive: closed to new activity, history kept and searchable; unarchive from the directory [ARCHIVE]. | Archive and an archived notice (R/WorkspaceChannelPane.tsx:436). | Keep; L1 adds the archived filter. | – | – |
| L6 | System messages: joined, left, topic set, renamed; consecutive joins collapse ("A and 3 others joined") [CK]. | `SystemEvent` component (UI/MessageDividers.tsx:70-125). | Collapse runs of join events. | S | L |

### M. Channel header, details, pins, saved

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| M1 | Header: # or lock + name (click = details) + chevron; topic; at right: member faces with count, agents icon, notification bell / kebab; tab row under it: Messages, Files, Pins, … [TABS, AIHELP, CK]. | Name, topic (editable), face pile, Artifacts, Details (UI/ChannelHeader.tsx:41-154). No bell, no tab row. | Add the notification bell (N2). Add a light tab row: Messages, Pins (M5), Files (attachments of the channel), Artifacts (move the Artifacts button here). | M | M |
| M2 | Details dialog: About (name, topic, description, created by, Leave), Members (search, Add people, roles, Remove), Integrations, Settings (archive, tab permissions) [TABS, CK]. | Panel with About, Members, Integrations, Decisions, Settings (UI/ChannelDetails.tsx:30). | Keep. Cmd/Ctrl+Shift+I opens it. | S | L |
| M3 | Topic and description: max 250 characters; change posts a system message [CK]. | Edit dialogs (R/WorkspaceDialogs.tsx EditMetaDialog). | Check the 250 limit. | S | L |
| M4 | Add people: up to 1000 at once, by name or email; Remove: confirm, the person is told [CK]. | Invite dialog and member actions (R/workspace-controller.ts:2026-2054). | Keep. | – | – |
| M5 | Pin: menu "Pin to channel", key P; the message shows "Pinned by <name>" and a light yellow tint; a Pins tab lists pins; a system message says it [TABS, KBD, CK]. | None. | Backend: `pin`/`unpin` commands (pinned flag + pinnedBy on the message, new protocol version or capability). UI: menu item, tint and label, Pins tab. For agents: pinned messages are good shared context; optional "agents read the pins" later. | L | M |
| M6 | Save for later / Saved (Oct 2026: "Add to saved", Saved section in Home; To-dos with status and reminders) [SAVED, TODOS]. | None. | Saved list per member on the host (message refs). Toolbar and menu "Save", key A, a Saved view. To-dos and reminders: skip for now (routines cover reminders). | M | M |

### N. Notifications, mentions and badges

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| N1 | Global default: notify about "Mentions and direct messages" or "Everything"; thread replies you follow; keywords [NOTIF]. | Per host: muted + level (all / mentions / nothing) (WEB/web-notification-routing.ts:32-35). Desktop has its own settings. | Keep the per-host level as the default. | – | – |
| N2 | Per conversation: bell in the header with "All new posts", "Just mentions", "Mute"; advanced: desktop/mobile, "Follow every thread"; "Temporarily mute" 1 h / until tomorrow [CHNOTIF, MUTE]. | Mute only, in sidebar prefs (R/workspace-controller.ts:961-966). | Extend sidebar prefs with `notify: {[conversationId]: "all" | "mentions" | "nothing"}`. Apply it in the web and desktop notification routing, and in the badge rules. | M | M |
| N3 | @everyone = all in #general; @channel = all members, active or away; @here = active members only; none notify inside threads; none notify paused users [HERE]. | Broadcast mentions recognized (UI/workspace-types.ts:60); activity counts `channel` and `here` for persons (BE/channel-activity.ts:155-159). Presence is only active/offline (R/workspace-model.ts:83). | Apply "no broadcast inside threads". Apply @here to active people only after O1. | S | L |
| N4 | Browser tab title shows unread state; favicon gets a dot; badge counts are the same across dock, tab and switcher [A11YLOG, CK for glyphs]. | Web title counts agents that wait or have unread replies (WEB/WebWorkspace.tsx:1613-1630). Channel mentions and DMs are not counted. | Title "(N) " = channel mentions + DM unreads + waiting agents; favicon dot when only plain unreads. Same number on the desktop dock badge. | S | M |
| N5 | Mobile push is held while the desktop is active (1 min after lock, 10 min idle) [NOTIF]. | Web Push exists (WEB/web-push.ts). | Optional: hold push while another session of the member is focused. | M | L |

### O. Presence and status

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| O1 | Active (filled green dot) or away (hollow); away after 10 minutes of desktop inactivity, or when the mobile app is left; manual "Set yourself as away" [PRES]. | `active` when online, else `offline` (R/workspace-model.ts:83). The type has `away` (UI/workspace-types.ts:10) but nothing sets it. | Report idle after 10 minutes without input; show away; manual toggle in the account menu. | M | L |
| O2 | Custom status: emoji + text + expiry, shown next to the name everywhere [PRES]. | None for humans. Agents show their current task in Fleet. | Optional for humans. For agents, show the current task as the status line in the profile card and the DM header. | M | L |

### P. Mobile (iPhone web) and small screens

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| P1 | Bottom tab bar: Home, DMs, Activity, and one more (Slackbot since Oct 2026, More before); search is a floating control on iOS 26; the profile picture at the top opens status and preferences [A11YLOG, IOS26]. | In workspace mode the bottom bar is hidden (WEB/WebWorkspace.tsx:2847-2853); when shown it has Chat and Agents only (WEB/WebMobileNavigation.tsx:26-29). Phone = one pane at a time: list, conversation, panel (UI/WorkspaceLayout.tsx:36; UICSS/workspace-shell.css:102-130). | Phone tab bar for the workspace: Home (channels list), DMs (J1), Activity (I), Fleet (agents, our "Slackbot/agents" tab). Search as a button in the Home header. Hide the bar inside a conversation and while the keyboard is open (reuse `createKeyboardOpen`, WEB/WebMobileNavigation.tsx:47-78). | M | H |
| P2 | Mobile Home: a horizontal row of shortcut chips at the top (Catch up, Threads, Drafts & sent, Saved), then the conversation list; sort toggle (A-Z / Recent) [MOBHOME]. | The full desktop sidebar renders on the phone, with 8 or more view rows above the channels (UI/WorkspaceSidebar.tsx:159-244). | On phone: chips row (Unreads, Threads, Drafts, Artifacts, More) instead of the stacked view rows. | M | H |
| P3 | Tapping a conversation pushes it; iOS edge-swipe back pops [CK]. | Back buttons (UI/WorkspacePaneHeader.tsx, UI/ChannelHeader.tsx:44-50); browser back syncs panes on web (WEB/WebWorkspace.tsx:2066-2070). | Add a left-edge swipe-back gesture in standalone (home-screen) mode where Safari offers none. | M | M |
| P4 | Long-press a message: action sheet (D7). Long-press a reaction: who reacted (F1). Long-press a row: menu (B10). | D7, B10. | See D7, B10. | – | – |
| P5 | Catch up: one card per unread conversation; swipe right = mark read, swipe left = skip; Undo [UNREADS]. | None. | After C8: phone Unreads view as cards with these swipes. | M | M |
| P6 | Composer: Return = new line; paper-plane sends (G2); "+" opens attachments; the bar rides on the keyboard [CK, IOSRN]. | G2 bug; keyboard handling exists (WEB/WebMobileNavigation.tsx:47-78). | G2. | – | – |

### Q. Keyboard and accessibility

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| Q1 | F6 / Shift+F6 cycle regions; Tab moves inside a region; arrows inside lists and toolbars [A11Y, NAV]. | Landmarks exist (`nav` in UI/WorkspaceSidebar.tsx:126; `main` and `aside` in UI/WorkspaceLayout.tsx:74-91). No F6. | Add F6 / Shift+F6 to move focus between sidebar, header, message list, composer, right panel. | S | M |
| Q2 | Shortcut set: Cmd+K jump; Cmd+Shift+A Unreads; Cmd+Shift+T Threads; Cmd+Shift+M Activity; Cmd+Shift+K DMs; Cmd+Shift+L browse channels; Cmd+Shift+I details; Cmd+N new message; Cmd+. right pane; Cmd+J first unread; Cmd+F search here; Cmd+G search; Esc read; Shift+Esc all read; Alt+Up/Down; Alt+Shift+Up/Down [KBD]. | Cmd+K, Alt+Up/Down, Esc (R/WorkspaceView.tsx:30-67). | Add the rest in one shortcut module with the platform map (Mac Cmd, others Ctrl). Do not take keys that the app already uses: check `src/renderer/src/global-search-shortcut.ts` first. | M | M |
| Q3 | Message list keyboard: one tab stop, Up/Down by message, Home/End, keys on focused message (D5) [A11Y]. | Each message is a tab stop (UI/MessageRow.tsx:81). | D5. | – | – |
| Q4 | New messages announced politely only when focus is in the conversation; message label "<author>, <text>, <time>" [CK, A11YLOG]. | Row label is "<name>, <time>" without text (UI/MessageRow.tsx:86). Typing line is `aria-live="polite"` (UI/TypingIndicator.tsx:39). | Add the first 100 characters of the text to the label; a polite live region for new messages while focus is in the list or composer. | S | M |
| Q5 | Reduced motion respected (animations, pulses) [A11YLOG]. | Working pulses (UI/WorkspaceSidebar.tsx:185, 329). Not checked against `prefers-reduced-motion`. | Stop pulses under `prefers-reduced-motion: reduce`. | S | L |

### R. AI teammates (agent-specific)

| ID | Slack rule | OpenBot today | Change | Eff | Imp |
|---|---|---|---|---|---|
| R1 | While an agent works: standard "Working…" state; text can rotate; cleared when it answers [SESS, SETSTATUS]. | "X is working… <step>" with a live step trail, polled every 2 s (R/WorkspaceChannelPane.tsx:84-148; UI/TypingIndicator.tsx). | Keep. It is better than Slack's. | – | – |
| R2 | A Stop button shows while the agent works [SESS, AIHELP]. | The workspace pane has no Stop. The old channel view had `stopWork` with the `stop` command (CH/channel-conversation.tsx:202-213). | Add "Stop" next to each working agent in the typing line (channel and thread), sending `stop` for that agent's running tasks. | S | H |
| R3 | Session status "suspended" = needs the user; listed as "Needs attention" [SESS, AIHELP]. | Waiting agents get a DM row and an unread (R/workspace-model.ts:274-283); approval, question and takeover cards show above the composer (R/WorkspaceChannelPane.tsx:346-431). Activity has no item for them. | Add an Activity kind "needs you" (approval, question, browser takeover, usage limit) that opens the conversation at the card; count it in the badge. | M | H |
| R4 | Steps shown as task cards (timeline) or one plan block; collapsed by default and expandable [STREAM]. | StepTrail open while pending, closed after (R/WorkspaceMessage.tsx `defaultOpen={props.row.pending}`). | Keep. | – | – |
| R5 | Agent identity: "labeled as an agent"; added from the header's agents icon; removable from the agent message's More actions [AIAPPS, AIHELP]. | AI badge in DM rows and header (UI/WorkspaceSidebar.tsx:326; UI/ChannelHeader.tsx:76-78). Agents are added in Details. | Show the AI badge on agent message author lines. Add "Remove from channel" and "Agent settings" in the More menu of an agent's message (admins). | S | M |
| R6 | Suggested prompts (up to 4) at the top of an agent conversation [AIAPPS]. | None. | Optional: in a new DM with an agent, show 3 or 4 prompt chips from the agent's description or skills. | M | L |
| R7 | Agent DMs in Slack use the same message UI as people (with the agent's own thread history) [AIHELP]. | The owner's DM with an agent is the agent's main chat, drawn by the older conversation UI inside a DM header (R/WorkspaceView.tsx:157-187). A non-owner's DM is a normal channel. So the most-used surface looks different from channels. | Product decision (section 6, D2). | L | H |
| R8 | Answer streams; links in streamed messages do not unfurl [STREAM]. | Streaming status exists on messages (R/workspace-model.ts:509). | Keep. | – | – |
| R9 | Unsend (Cmd+Z, 15 s) [EDIT]. | None. | Skip; Stop (R2) and Delete cover it. | – | – |

---

## 4. Ranked backlog (top 30)

Rank = impact first, then lower effort, then how many other items it unblocks. "Pkg" = work package in section 5.

| Rank | Item | IDs | Eff | Imp | Pkg |
|---|---|---|---|---|---|
| 1 | Phone: Return adds a line, paper-plane sends; desktop honors the send-key preference | G2, G1 | S | H | P5 |
| 2 | Activity click opens the exact message (focus + highlight), thread replies lit in the panel | I3 | S | H | P2 |
| 3 | Stop button for working agents in channel and thread typing lines | R2 | S | H | P6 |
| 4 | Thread panel keeps the reader's place; "New replies" pill | H3 | S | H | P6 |
| 5 | Collapsed sidebar groups still show unread, mention and active rows; collapse state persists | B4 | S | H | P3 |
| 6 | Activity badge excludes reactions; Activity "Mark all as read" marks only listed items | I5, I4 | S | M | P2 |
| 7 | @channel / @here confirm in channels with 6+ people; "Not in channel" mention notice with "Add to channel" | G6, G7 | S | M | P5 |
| 8 | Browse channels: preview before join, sort, archived filter, Cmd+Shift+L | L1, L2 | S | M | P4 |
| 9 | Broadcast thread replies show "replied to a thread: …" | D9 | S | M | P1 |
| 10 | Web tab title and favicon count mentions, DMs and waiting agents | N4 | S | M | P7 |
| 11 | Touch: long-press message action sheet; no inline action bar on phones | D7, P4 | M | H | P1 |
| 12 | Phone shell: bottom tabs (Home, DMs, Activity, Fleet), Home chips row, keyboard-aware | P1, P2 | M | H | P7 |
| 13 | DMs view with last-message preview and time; DMs badge = unread conversations | J1, J2 | M | H | P2 |
| 14 | Sidebar "Filter and sort" per group (A-Z / Recent / Custom; All / Unreads / Mentions); hide muted | B3, B6 | M | H | P3 |
| 15 | Jump to: unread first, frecency, initials, views and "Create #name" | K1, K2 | M | H | P4 |
| 16 | Unreads view (grouped by conversation, mark read per group with Undo) | C8 | M | H | P2 |
| 17 | Agent "needs you" items in Activity and the badge | R3, I1 | M | H | P2 (+P0 if host-side) |
| 18 | Per-thread read state (backend + migration); thread summaries and Threads view correct | C7, H2, H7 | L | H | P0 then P2 |
| 19 | Mark unread (backend command + menu + Alt+click + U) | C6, D4 | L | H | P0 then P1 |
| 20 | Channel message search with modifiers; Cmd+F in conversation | K3, K4 | L | H | P0 then P4 |
| 21 | Keyboard set: Alt+Shift+Up/Down, Shift+Esc, Cmd+Shift+A/T/M/K/I, Cmd+., Cmd+J, Cmd+N, F6, Cmd+/ sheet | Q1, Q2, B9, C5, C10, A4, A6 | M | M | P4 |
| 22 | Inline edit in the message row (desktop) | E1 | M | M | P5 (+slot in P1) |
| 23 | Draft pencil on rows + Drafts & sent view | B7, G9 | M | M | P3 + P2 |
| 24 | Threads view: unread first, last replies, inline reply, mark read on view | H6 | M | M | P2 |
| 25 | Message toolbar and More menu to Slack order; stable one-click reactions setting; agent message actions | D3, D4, R5 | S | M | P1 |
| 26 | Thread follow / unfollow; auto-follow on mention and DM threads | H5 | L | M | P0 then P6 |
| 27 | Per-conversation notification level (bell in header) | N2, M1 | M | M | P6 + P7 |
| 28 | Roving focus and single-key actions in the message list; message labels with text | D5, Q3, Q4, H8 | M | M | P1 |
| 29 | Starred + custom sidebar sections | B2 | M | M | P3 |
| 30 | Saved for later and Pins (backend + menu + views) | M6, M5 | L | M | P0 then P1 + P6 |

Status after the QA pass (2026-11-18, `stream/qa-ui`): C10 ⌘J, D9 "Replied to a thread", N4 tab title with
the place ("#general - Market - OpenBot"), B8 Mark as read in the row menu, and a filter (All, Channels, DMs)
and sort (sidebar, newest, oldest) for C8 Unreads are done; E2E `scripts/workspace-seams-e2e.ts`. A2 view
history stays open on the desktop: the web client already gets Back and Forward for views from the address
(stream/deeplinks), and the desktop history (`src/renderer/src/navigation.tsx`) records chats only.

Below the line (do later or on request): D2 floating date pill, C2/C3 divider details, E3 delete preview, F2-F4 reaction details, G3 code-fence Enter, G4 quote and code block, G11 drop overlay, L3-L6, O1 away, P3 edge swipe, P5 Catch up cards, A2 view history, A3 space keys, D14 jumbo emoji, J3 rename group DM, R6 suggested prompts, G8 draft sync, G10 schedule, N5 push hold.

---

## 5. Work packages (parallel build, disjoint files)

Rules for all packages:

- Each package owns the files listed. Another package must not edit them; ask the owner, or add a prop/slot in your own file.
- `R/workspace-controller.ts` (2,235 lines) is the main conflict risk. P-S below splits it first. If you skip P-S, give the controller to one package and let the others call through narrow new modules.
- Interface text: every package adds keys only under its own prefix in `packages/i18n/src/messages/<lang>/workspace.ts` (for example `workspace.unreads.*`, `workspace.dms.*`, `workspace.sidebar.sort.*`). Append in one block per package so merges are trivial. Read `docs/i18n.md`.
- Tests: E2E only (`scripts/*-e2e.ts`, artifacts under `.openbot-build/`); extend `scripts/workspace-scope-e2e.ts` or add one script per package. Storybook for visuals. Migrations need data-preservation fixtures (AGENTS.md "Tests").
- Team API: new commands go in a new protocol version or behind a capability; never change `read` or other released commands (AGENTS.md "Non-negotiable").
- Shared UI stays free of renderer contexts (packages/ui/AGENTS.md).

### P-S. Seams (prerequisite, 1 engineer, 1 to 2 days, lands first)

Owns: `R/workspace-controller.ts`, `R/workspace-model.ts`, `R/WorkspaceView.tsx`, `R/WorkspaceDialogs.tsx`, `UI/WorkspaceSidebar.tsx` (type export only).
Do, with no behavior change:
- Split the controller into `R/workspace-navigation.ts`, `R/workspace-read-state.ts`, `R/workspace-drafts.ts`, `R/workspace-sidebar-prefs.ts`, `R/workspace-activity.ts`, `R/workspace-typing.ts`; the controller only composes them.
- Split the model into `R/workspace-model-sidebar.ts` (sidebarChannels, sidebarDirectMessages) and keep message rows in `R/workspace-model.ts`.
- Move `WorkspaceKeyboard` from `R/WorkspaceView.tsx` to `R/workspace-shortcuts.tsx`.
- Split `R/WorkspaceDialogs.tsx` into `R/WorkspaceSwitcher.tsx`, `R/WorkspaceBrowse.tsx`, and the rest.
- Move the `WorkspaceView` union to `UI/workspace-types.ts` and make the sidebar quick rows and the view switch data-driven from one registry (`R/workspace-views-registry.ts`), so a new view is a one-line registry entry.

### P0. Backend and contracts (1 engineer, serial queue, each step behind a host capability)

Owns: `BE/channel-store.ts`, `BE/channel-service.ts`, `BE/channel-activity.ts`, new `BE/channel-search.ts`, `BE/openbot-database-schema.ts` and migrations, `CT/ipc-chat-channels.ts`, `CT/ipc-chat-workspace.ts`, `CT/team-protocol/*` (new versions only), `src/main/team-api/route-workspace.ts`, `src/main/ipc/agent-handlers.ts`, `src/preload/*` mirrors, `src/renderer/src/preview/mock-openbot.ts`.
Queue (ranked): (1) per-thread read pointers + `read-thread` (backlog 18); (2) `mark-unread` (19); (3) Activity "needs you" kind if host-side (17); (4) message search FTS + route (20); (5) thread follow table + auto-follow on mention (26); (6) saved items and pins (30); (7) optional draft sync (G8).
Each step ships the contract, the host route, the preview mock and an E2E, then the UI package wires it.

### P1. Message list and message actions

Owns: `UI/MessageRow.tsx`, `UI/MessageDividers.tsx`, `UI/EmojiPicker.tsx`, `UI/WorkspaceContextMenu.tsx`, `UICSS/workspace-messages.css`, `UICSS/workspace-emoji.css`, `R/WorkspaceMessage.tsx`, `R/WorkspaceMessageList.tsx`, `R/workspace-model.ts` (message rows), new `UI/MessageActionSheet.tsx`, new `UI/use-long-press.ts`.
Backlog: 9, 11, 25, 28; wiring for 19 and 30 (menu items) once P0 lands; adds the `editor` slot that P5 fills for 22. Below-the-line: D2, D6, D10, D14, E3, F1-F4.
Exports for others: `useLongPress` (P3 uses it for sidebar rows), `MessageActionSheet` (generic bottom sheet).

### P2. Views: Activity, Threads, Unreads, DMs, Drafts & sent

Owns: `UI/ActivityView.tsx`, `UI/ThreadsView.tsx`, new `UI/UnreadsView.tsx`, new `UI/DirectMessagesView.tsx`, new `UI/DraftsView.tsx`, `UICSS/workspace-views.css`, `R/WorkspaceViews.tsx`, `R/workspace-activity.ts`, `R/workspace-read-state.ts`, `CH/channels-controller.ts`, `CH/channels-context.tsx`.
Backlog: 2, 6, 13, 16, 17, 18 (client), 23 (Drafts view), 24. Below-the-line: C2, C3, C5 logic (the key binding is P4's), P5 Catch up.

### P3. Sidebar

Owns: `UI/WorkspaceSidebar.tsx`, `UI/WorkspaceMenu.tsx`, `UICSS/workspace-shell.css` (sidebar block only; P7 owns the phone container block, split the file into `workspace-sidebar.css` in P-S if needed), `R/WorkspaceSidebarPane.tsx`, `R/WorkspaceSpaceRail.tsx`, `R/workspace-sidebar-prefs.ts`, `R/workspace-model-sidebar.ts`, the `WorkspaceSidebarPrefs` bound in contracts (coordinate the one-line schema change with P0).
Backlog: 5, 14, 23 (pencil), 29; B8 row menu additions, B10 long-press (uses P1's hook). Below-the-line: A3.

### P4. Jump to, search UI, browse, shortcuts

Owns: `R/WorkspaceSwitcher.tsx`, `R/WorkspaceBrowse.tsx`, `R/workspace-shortcuts.tsx`, new `R/workspace-frecency.ts`, new shortcuts sheet `UI/ShortcutsSheet.tsx`, the message section of `packages/ui/src/components/GlobalSearch.tsx` and `CH/global-search-channels.ts`, `src/renderer/src/navigation.tsx` (history entries for views).
Backlog: 8, 15, 20 (UI), 21. Below-the-line: A2.

### P5. Composer and drafts

Owns: `R/WorkspaceComposer.tsx`, `UI/MessageComposer.tsx`, `R/workspace-drafts.ts`, `CONV/ComposerEditor.tsx` and `CONV/send-shortcut.ts` (shared with the agent chat: changes must keep the agent chat behavior; the agent chat owner reviews), new `R/BroadcastConfirmDialog.tsx`.
Backlog: 1, 7, 22 (inline edit fills P1's slot), draft API for P2/P3 (`listDrafts()`). Below-the-line: G3, G4, G11, G13, G8 client.

### P6. Channel pane, thread panel, header and agent work

Owns: `R/WorkspaceChannelPane.tsx`, `R/WorkspaceThreadPanel.tsx`, `R/WorkspaceDetailsPanel.tsx`, `UI/ThreadPanel.tsx`, `UI/TypingIndicator.tsx`, `UI/StepTrail.tsx`, `UI/ChannelHeader.tsx`, `UI/ChannelDetails.tsx`, `UI/WorkspacePaneHeader.tsx`, `UICSS/workspace-panels.css`.
Backlog: 3, 4, 26 (thread header bell), 27 (header bell UI), 30 (Pins tab). Below-the-line: R6.

### P7. Phone shell and notification surfaces

Owns: `WEB/WebMobileNavigation.tsx`, `WEB/WebWorkspace.tsx` (workspace phone wiring and the title block at 1613-1630; move the title block to new `WEB/web-title-badge.ts` first), `WEB/web-client.css`, `WEB/web-notification-routing.ts`, `WEB/web-notifications.ts`, `UI/WorkspaceLayout.tsx`, `UICSS/workspace-shell.css` (phone container block), new `UI/PhoneTabBar.tsx`, desktop dock badge code in `src/main` (if touched, follow src/main/AGENTS.md).
Backlog: 10, 12, 27 (apply the level in routing). Below-the-line: P3 edge swipe, N5, O1 (presence idle reporting; needs a small host field, coordinate with P0).

### Dependency map

- P-S before everything (or accept merge work in the controller).
- P0 steps unblock: 18 → P2; 19 → P1 (+P2 for "stay unread until leave"); 20 → P4; 26 → P6; 30 → P1 + P6.
- P1's `editor` slot before P5's inline edit (22). P1's `useLongPress` before P3's B10.
- P5's `listDrafts()` before P3's pencil and P2's Drafts view.
- P2's DMs view before P7's DMs tab.

---

## 6. Open product decisions

| ID | Question | Recommendation |
|---|---|---|
| D1 | Keep 8+ view rows at the top of the sidebar, or move to Slack's pattern (Unreads, Threads, Activity, Drafts, Saved at top; Fleet, Artifacts, Between agents, Storage, Secrets, Apps under "More" or a tab rail)? | Slack pattern. Fleet stays visible (it is our "Agents" tab); the admin views go under More. |
| D2 | The owner's DM with an agent renders the agent's main chat (different UI). Unify with the channel message UI? | Long term yes, it is the most-used surface. It is L effort and touches agent chat ownership; plan it as its own project after this backlog. |
| D3 | Does `@here` / `@channel` wake agents with answer mode "mention"? Do agents count in the "notify N people" confirm? | Count humans only in the confirm. Let `@channel` reach agents in "mention" mode only if the channel owner opts in, so one broadcast does not start many agent turns. |
| D4 | Forward message (share to another channel or DM)? | Low priority. "Copy link" plus a pasted-link preview covers most uses. |
| D5 | Unsend, schedule send, reminders, To-dos? | Skip. Stop (R2), Delete and routines cover them. |
| D6 | Default sidebar sort: A-Z (Slack default) or Recent? | A-Z for channels (Slack), Recent for DMs (Slack DMs tab). Expose the per-group choice (B3). |

---

## 7. Appendix: what OpenBot already does like Slack

- Enter sends, Shift+Enter adds a line on desktop (CONV/ComposerEditor.tsx:990-1003).
- Up in an empty composer edits the last own message (R/WorkspaceComposer.tsx:245-268).
- Drafts per conversation and per thread, kept across reloads on the same computer (R/workspace-controller.ts:371-395).
- "Also send to #channel" in the thread composer (UI/MessageComposer.tsx:201-212).
- Opening a channel lands on the "New" line and marks it read only while the window has focus (CH/channels-controller.ts:238-262; CH/channels-context.tsx:68).
- "Unread since …" banner with Mark as read, and the "N new messages" / "Jump to latest" pill (R/WorkspaceMessageList.tsx:284-318).
- Esc marks read, Esc closes the right panel, Cmd+K jump, Alt+Up/Down (R/WorkspaceView.tsx:30-67).
- Thread-only replies do not make the channel unread; agent commentary is not unread (BE/channel-store.ts:250-264).
- DM rows count every unread message; channel rows count mentions; muted rows lose the bold (UI/WorkspaceSidebar.tsx:547-570; R/workspace-model.ts:260).
- 5-minute message grouping, gutter time on grouped rows, Today/Yesterday dividers, deleted-parent placeholder (R/workspace-model.ts:59-476; UI/MessageRow.tsx:90-121; UI/MessageDividers.tsx:11-34).
- Reaction pills with "you reacted" state and actor tooltips (UI/MessageRow.tsx:271-312).
- Sidebar order and mutes follow the account across computers (R/workspace-controller.ts:808-934).
- Agent work line with live steps, which goes beyond Slack's "Working…" (UI/TypingIndicator.tsx; R/WorkspaceChannelPane.tsx:84-148).

Unconfirmed in this review (marked where used): Kobalte ContextMenu long-press on iOS Safari (B10); sticky date divider inside virtual rows (D2); `:` emoji autocomplete in the workspace editor (G5). I read the code; I did not run the app.
