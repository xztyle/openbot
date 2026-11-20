# UX standard

The one way to build a screen in OpenBot: desktop (`src/renderer`), the web client and an iPhone in
Safari. Where Slack has a pattern for the same job, we copy it ([slack-parity.md](slack-parity.md));
where agents need a different rule, the spec says so (§ 2.2 there). The findings behind this file are
in [inventory.md](inventory.md).

A new screen uses these parts. A change to an old screen moves it to these parts in the same change.

## 1. Pick the container

| Job | Container | Component |
|---|---|---|
| Make one thing, or change a few fields of one thing | Dialog; a full-height sheet on a phone | `FormDialog` (`@openbot/ui`) |
| Pick one item from a long list (switcher, browse) | The same dialog without a footer | `FormDialog` with no `submitLabel` |
| Confirm a change that loses data or reaches other people | Alert dialog | `ConfirmDialog` |
| Details and settings of the open conversation or agent | Right panel; full screen pane on a phone | `WorkspacePaneHeader` + tabs |
| Settings of the app or a server | Settings page | `SettingsDialogShell` + `SettingsSection` |
| A list of things of one kind | Workspace view | `WorkspacePaneHeader` + `.ws-view` + view states (§ 4) |
| First run of a server (first agent, provider step) | Page in the main pane | `FirstAgentSetup`, onboarding |
| Place a thing at a point (canvas) | Card at the point | `DiagramNewAgentCard` |

Do not make a page for a create flow, and do not make a dialog for a list. Do not build an overlay
from `Dialog.*` parts in a feature: use `FormDialog` or `ConfirmDialog`. The primitives (`Dialog`,
`Popover`, `DropdownMenu`) are for those components and for pickers.

## 2. Create and edit flows (`FormDialog`)

Source: `packages/ui/src/form-dialog.tsx`, styles in `packages/ui/src/styles/patterns.css`.
Stories: Workspace/Dialogs, Agents/New agent dialog, Workspace/Spaces. E2E:
`scripts/ux-creation-flows-e2e.ts`.

### 2.1 Anatomy

1. **Header:** title, then one sentence that says what the thing is for, then the close button.
   The title is a noun phrase: "New channel", "New agent", "Edit space", "Add people to #launch".
2. **Body:** the fields, top to bottom in the order a person fills them. Required fields first.
   Use `Field` (label, description, error, `required`), `Input`, `Textarea`, `SwitchField`,
   `MemberPicker`, `FormSection` for a titled group. The body scrolls; header and footer stay.
3. **Error line:** a failure of the submit, above the footer, in a danger `Alert`. Never a toast.
4. **Footer:** at the start, the step ("Step 1 of 2") or nothing. At the end: the secondary action
   (Cancel; Back in a later step), then the primary action. One primary action only.

Sizes: `sm` 440 px (one or two fields), `md` 520 px (default), `lg` 640 px (pickers with previews,
New agent). On a screen 720 px wide or less, every size is the sheet of `ActionSheet` at full height:
it rises from the bottom edge, stops under the status bar, has the grab handle and rounded top
corners, keeps the footer above the home indicator, and has 44 px buttons.

### 2.2 Behavior

- **Focus:** the first field of the body when the dialog opens, never the close button.
- **Enter** in a field submits (the body is a `<form>`). In a people search with text, Enter adds the
  first match instead (Slack). In a `Textarea`, Enter adds a line.
- **Validation:** the primary action is off while the form is not valid. A rule that the person can
  break by typing shows at once under its field (`Field error`), for example "#launch already exists."
  Say what to do, not what is wrong: "Enter a name."
- **Busy:** the primary button spins (`busy`). Fields and Cancel are off. Escape and the overlay do
  not close the dialog.
- **Failure:** the dialog stays open with the person's input. The error line says why, in the reader's
  language (`errorMessage(error, fallback)`). The caller returns the message; it does not toast.
- **Success:** the dialog closes and **the new thing opens**: a new channel, DM, agent chat or space
  shows in the main pane (on a phone, the conversation pane). An edit closes and the change shows in
  place. No success toast when the result is on screen.
- **Steps:** at most two. Step 2 has Back. Slack's channel flow is the model: name and privacy, then
  people.
- **Cancel, Escape, close:** throw away the draft of a create flow. A long edit form with unsaved text
  asks first (`createUnsavedGuard`, `DiscardChangesDialog`).

### 2.3 Fields

- One label per field, above it, sentence case, no colon. The optional ones say "(optional)".
- A hint goes in `description`, under the field; an error replaces it.
- A choice applied at once is a `Switch` in a `SwitchField` row; a choice from two to five options is
  a `RadioGroup`; a longer list is a `Select` or a `Combobox`.
- People and agents: `MemberPicker` (search, chips, People and AI agents groups).
- A name with a prefix (`#`, a lock) uses `.ws-name-field`.

## 3. Lists and rows

Source: `packages/ui/src/features/workspace/WorkspacePaneHeader.tsx`, `.ws-view*` in
`workspace-views.css`, view states in `packages/ui/src/view-state.tsx`.

- **Header:** `WorkspacePaneHeader` with the title, a short subtitle (a count or a scope), and at most
  one primary action in the `default` variant, size `sm`, with a `Plus` icon and the label
  "New <thing>". Other header actions are `ghost`. On a phone the header has Back.
- **Toolbar** (optional): tabs, then filters, then search at the end. It wraps on a phone.
- **Row:** `WorkspaceList` and `WorkspaceListRow` (`features/workspace/WorkspaceList.tsx`): leading
  avatar, title with a time or badge at its end, lines under it, trailing dot or count. A row that
  opens one thing is a button over its whole width (Threads, Activity, Between agents). A row with
  several actions (Space agents, Secrets) keeps them at its end: on hover and focus on a computer,
  always on a touch screen. Icon-only buttons are `IconButton` with a label. Fleet and Artifacts are
  card grids, not lists.
- **Unread:** bold name plus a count badge for mentions, as in the sidebar (Slack).
- **Selection:** checkboxes only where a bulk action exists (Space agents, Storage).

## 4. Empty, loading and failed states

| State | Component | Rules |
|---|---|---|
| Loading, first time | `LoadingState` | Skeleton rows, not text. Only when nothing is shown yet; a refresh keeps the old rows. |
| Empty | `EmptyState` | Icon, title ("No secrets yet"), one sentence that says what fills it, and the action that fills it ("New secret") when the reader can do it. |
| No match | `EmptyState`, compact | Different text from Empty: "No matches", with "Clear filters" when filters are on. |
| Failed | `ErrorState` | Title ("Couldn't load the secrets"), the reason, Retry. Never show the Empty text for a failure. |
| Failed action | Error line in the dialog; toast only for an action with no dialog | Toast text says what failed and what to do. |

## 5. Settings pages

- One layout: `SettingsSection` (title, description) with rows. A row is a label with a description
  on the left and its control on the right; on a phone (520 px and less) the control goes under the
  label.
- **Save model** (decided 2026-10-10): toggles, selects and pickers save at once. A text form saves
  with an explicit Save bar (`SettingsSaveBar` in a `SaveBarDock`) that shows only when there are
  changes, with Reset. Leaving with unsaved
  changes (Back, close, another tab, another server, the browser tab) asks first.
- A destructive area is the last section, `DangerZone`, with a confirm.
- The page has a visible close (a computer) or Back (a phone). Escape closes it.
- On a phone the page is two screens, as iOS Settings and Slack's app: the list of sections, then the
  section that a tap opens. Back on a section goes to the list; Back on the list closes the page. An
  address that names a section (`?section=members`) opens that section.

## 6. Confirmations

- `ConfirmDialog` for an action that loses data that cannot come back, or that reaches other people.
  Title is the question ("Delete #launch?"), description is the consequence, confirm label is the verb
  and object ("Delete channel").
- **Undo instead of confirm** for an action that can be undone in a few seconds (hide an agent, delete
  a memory or a workflow). Never both. Deleting an agent is a confirm only, as in Slack.
- `tone="destructive"` (red, trash icon) only when data is lost. Leave, Revoke, Disconnect use the
  default tone.
- Leaving a private channel confirms (Slack); leaving a public one does not. Removing someone from a
  channel confirms. Nobody leaves #general.
- A failure shows inside the confirm (`error`); the dialog stays open.
- Text: "You cannot undo this." when it cannot be undone. Do not write it when it can.

## 7. Workspace sidebar (Slack)

Decided 2026-11-18 (slack-parity.md D1, B4):

- Fixed rows at the top: Unreads, Threads, Activity, Later (when the host keeps saved messages; the
  row counts the open ones) and Fleet (our agents tab). Drafts & sent comes when drafts sync.
- DMs, Space agents, Artifacts, Between agents, Storage, Secrets and Apps are under one **More** row.
- The top bar of the main pane holds the message search (⌘G, `/`) and the shortcuts sheet (⌘/). A
  phone has no top bar: the search opens from the sidebar as a full-screen view.
- A view that gathers messages (Unreads, Later, search results) opens the exact message: its channel,
  or its thread for a reply, scrolled to and marked.
- Groups: Channels, Direct messages. A collapsed group still shows its unread rows, its mention rows
  and the open conversation. The collapse state is saved with the sidebar preferences.
- Activity opens the exact message (scrolled to and highlighted); its badge does not count reactions;
  "Mark all as read" marks only the Activity items read.
- Sections (stream/p35): Starred (only when it has rows), the reader's own sections, Channels, Direct
  messages. A conversation is in one section only. Each section header has an options menu (a sheet
  on a phone): Sort (Custom order, Alphabetical, Recent activity, Priority) and Show (All, Unreads
  only, Mentions only), then New section, Rename and Delete for the reader's own. Delete has Undo,
  not a confirm: the conversations go back to their groups. All of it is in the synced sidebar
  preferences (`starred`, `sections`, `groupOptions`).
- A row with an unsent draft shows a pencil. Drafts & sent is a top row, with the number of drafts;
  drafts stay on the device, Sent comes from the host's message search.
- Keys: Up and Down move between rows, Left on a row goes to its section header, Left and Right on
  a header collapse and open it, a letter moves to the next conversation with that letter.

## 7a. Message box (Slack)

- On a computer, Edit opens the message in place (Enter saves, Escape cancels, Save and Cancel
  buttons); an empty save asks to delete. ↑ in an empty box edits the last own message. On a phone
  the edit stays in the box, as in Slack's app.
- `:` and two letters offer emoji; `@` people and agents; `#` channels. Enter in an open code block
  adds a line. The formatting toolbar remembers its state (shown on a computer, hidden on a phone
  until the reader shows it).

## 7b. The owner's DM with an agent

The DM is the agent's main chat: provider turns, steps, tool calls, approvals, questions, browser
steps, routine runs, the side panel, the queue and steer stay its own. It looks and acts as a channel
(stream/agentdm):

- `WorkspaceAgentFrame` provides `ConversationWorkspaceLayoutContext`. With it, the chat draws each
  message with `WorkspaceChatRow` (the shared `MessageRow`): face, name, time, five-minute grouping,
  the hover action bar (quick reactions, emoji picker, Reply, More) and the long-press sheet. Reply
  quotes the message in the box; More has Reply, Copy text, Copy link (web) and Read aloud.
- The steps of a turn fold inside the answer's row. Cards of a turn and cards that wait for the reader
  stand in the text column. Markers between messages stay centered.
- The day pill, the "New" line, the "N new messages since" pill and the jump pill are the channel's.
- The message box is the channel's box: formatting toolbar (the same "Aa" choice), emoji, `:` search,
  the paper plane. The "+" menu, the context meter, the microphone, Stop, the queue and the saved
  replies stay.
- One header row: the DM header holds the chat's controls (model, search, side panel) through a
  portal. On a phone the model is its provider's mark.
- A message that a link, a search or a notification opens is scrolled to the middle and flashes.
- Without the context (the chat outside the workspace, a channel in the chat view) nothing changes.

## 7c. Needs you

Anything that waits for the reader is impossible to miss (stream/needsyou). The host's list
(`agent-attention-changed`) names every question, form, API key form, approval, browser takeover,
sign-in and browser secret of every agent. Each surface reads that one list:

- The agent's DM row shows at once, also for an agent that nobody wrote to, with the amber Needs you
  mark (a hand in an amber bubble, an amber bar at the start of the row). It sorts first under
  Priority and stays in a collapsed section and under Unreads only.
- The agent that gave the work shows the request too: its row in the sidebar is marked, its
  "Waiting for replies" row says what to do and where ("Sign in on accounts.google.com") with the
  action (Take over, Answer, Review), and the teammate's card stands in its chat.
- "Needs you": a button with the count in the top bar of a computer (it shows only while something
  waits) opens the list; Activity starts with the same list; a phone's Home has the chip. A row says
  who asks, what to do, the safe summary, where and when, and opens the chat that answers it.
- The Activity badges, the space rail, the tab title and the Dock count it. A takeover and a browser
  secret send a web push, as a question and an approval do.
- A new card in the open chat brings the chat to its end. A takeover card that this client cannot
  open (a web client without the browser view) says where to finish the step.

## 7d. Touch scale (phone)

On a screen 720 px wide or less with a touch pointer, settings pages, the agent settings panel, form
and confirm dialogs, select pickers, Secrets, Usage, Schedule and Tasks read the size tokens at their
touch steps (`--openbot-touch-*` in the brand tokens; the scope is at the end of `patterns.css`):
body text 16 px, hints 14 px, controls and rows 44 px, a larger switch. No field is under 16 px, so
iOS does not zoom into it. A new management screen joins the scope list; do not hand-size its controls.

## 8. Copy

All text comes from `@openbot/i18n`. Write English and Spanish together; the other languages may
follow.

- Sentence case. No final period on a title, a label or a button.
- **Verbs:** "New <thing>" opens a create flow (menu item, sidebar row, header button). "Create
  <thing>" is the primary button that makes it. "Add <thing>" puts an existing thing into another
  (members into a channel). "Save" stores an edit. "Delete" loses data. "Remove" takes a thing out of a
  group and keeps it. "Leave" takes the reader out.
- Spanish follows the English verb, one to one: New → Nuevo/Nueva, Create → Crear, Add → Añadir,
  Save → Guardar, Delete → Eliminar, Remove → Quitar ("Quitar a {name}" for a person or an agent),
  Leave → Salir de. Infinitive on buttons ("Crear canal"), not the imperative.
- Pending labels and Undo come from the common area: `common.saving`, `common.deleting`,
  `common.removing`, `common.undo`. Do not add a screen's own copy of them.
- Errors: what failed, then what to do: "Could not create the channel. Try again."

## 9. What is left

Ranked by impact. "Done" items are on `stream/uxflows`.

| Rank | Item | State |
|---|---|---|
| 1 | One `FormDialog` for New agent, New channel (both), New message, New space, Edit space, Add members, Edit topic/description, Browse, switcher | Done |
| 2 | New agent opens its chat on web; Create not dead after an unknown failure | Done |
| 3 | Command search "New channel" opens the workspace form | Done |
| 4 | View states in Activity, Threads, Fleet, Space agents, Secrets, Between agents; Artifacts and Storage keep their own | Done |
| 5 | Sidebar to Slack (§ 7): More row, collapsed groups keep unread rows, saved collapse | Done |
| 6 | Activity: exact message, badge without reactions, Mark all as read of Activity only | Done |
| 7 | Confirm Leave private channel, Delete channel (details) and Remove member; agent delete is a confirm only, on desktop and web | Done |
| 8 | Settings page: visible close/Back, rows stack on a phone, one `SettingsSaveBar`, unsaved guard on section change and on Close/Back/Escape | Done; a switch of server while a draft is open still drops it |
| 9 | Move template install, custom provider, vault, OpenCode key, chat apps, saved replies, more providers to `FormDialog`; join server button order; close buttons | Done; Publish agent and Join/Add server keep their own frames |
| 10 | Spanish wording: Quitar for Remove, Eliminar for Delete, Salir de for Leave; one "Deleting…", "Removing…" and "Undo" key | Done |
| 11 | One row component for workspace lists (`WorkspaceListRow` in Threads, Activity, Between agents, Space agents, Secrets) | Done |
| 12 | Unreads, Later, DMs, message search (top bar), Jump to frecency, Browse filters, shortcuts sheet (slack-parity P2, P4) | Done on `stream/p24`; E2E `scripts/workspace-inbox-e2e.ts` |
| 13 | QA pass of the merged streams (`stream/qa-ui`): one DMs list on a computer and a phone (the phone's DMs tab is the DMs view; Jump to DMs or Activity opens the tab), Mark as read and "Conversation details" in row menus, the bell as a sheet on a phone, Back alone on a phone pane, field text size in dialogs and the sidebar filter, toasts clear of the safe areas | Done; E2E `scripts/workspace-seams-e2e.ts` |
| 14 | The owner's DM with an agent as a workspace conversation (§ 7b); the side panel E2E opens the DM; Storybook draws stories with args; phone search filters in two columns | Done on `stream/agentdm`; E2E `scripts/agent-dm-e2e.ts`, `scripts/web-side-panel-e2e.ts` |
| 15 | Needs you (§ 7c): the host's list of what waits for the user on every surface | Done on `stream/needsyou`; E2E `scripts/needs-you-host-e2e.ts`, `scripts/needs-you-ui-e2e.ts` |
