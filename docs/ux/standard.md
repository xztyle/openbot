# UX standard

The one way to build a screen in OpenBot: desktop (`src/renderer`), the web client and an iPhone in
Safari. Where Slack has a pattern for the same job, we copy it ([slack-parity.md](slack-parity.md));
where agents need a different rule, the spec says so (§ 2.2 there). The findings behind this file are
in [inventory.md](inventory.md).

A new screen uses these parts. A change to an old screen moves it to these parts in the same change.

## 1. Pick the container

| Job | Container | Component |
|---|---|---|
| Make one thing, or change a few fields of one thing | Dialog; full screen on a phone | `FormDialog` (`@openbot/ui`) |
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
New agent). On a screen 720 px wide or less, every size is a full screen sheet: no rounded frame,
header under the status bar, footer above the home indicator, 44 px buttons.

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
- **Row:** a whole-row button when the row opens one thing (Threads, Activity, Between agents). A row
  with several actions shows them as icon buttons on hover on a computer and in a row menu (`…`, or a
  long press) on a phone. Icon-only buttons are `IconButton` with a label.
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
  with an explicit Save bar that shows only when there are changes, with Reset. Leaving with unsaved
  changes (Back, close, another tab, another server, the browser tab) asks first.
- A destructive area is the last section, `DangerZone`, with a confirm.
- The page has a visible close (a computer) or Back (a phone). Escape closes it.

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

- Fixed rows at the top: Threads, Activity, and, when the host serves them, Unreads, Drafts & sent and
  Saved. Fleet stays visible (our agents tab).
- Space agents, Artifacts, Between agents, Storage, Secrets and Apps are under one **More** row.
- Groups: Channels, Direct messages. A collapsed group still shows its unread rows, its mention rows
  and the open conversation. The collapse state is saved with the sidebar preferences.
- Activity opens the exact message (scrolled to and highlighted); its badge does not count reactions;
  "Mark all as read" marks only the Activity items read.

## 8. Copy

All text comes from `@openbot/i18n`. Write English and Spanish together; the other languages may
follow.

- Sentence case. No final period on a title, a label or a button.
- **Verbs:** "New <thing>" opens a create flow (menu item, sidebar row, header button). "Create
  <thing>" is the primary button that makes it. "Add <thing>" puts an existing thing into another
  (members into a channel). "Save" stores an edit. "Delete" loses data. "Remove" takes a thing out of a
  group and keeps it. "Leave" takes the reader out.
- Spanish: Nuevo/Nueva, Crear, Añadir, Guardar, Eliminar (delete), Quitar (remove), Salir (leave).
  Infinitive on buttons ("Crear canal"), not the imperative.
- Pending labels: "Creating…", "Saving…", "Deleting…" from the common area.
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
| 8 | Settings page: visible close/Back and server rows stack on a phone (done); one `SettingsSaveBar`; unsaved guard on close | Partly done |
| 9 | Move template install, custom provider, vault, join server, OpenCode key, chat apps, saved replies to `FormDialog` (profile done) | Open |
| 10 | Spanish wording: Quitar vs Eliminar for remove; one "Leave" verb; one "Deleting…" and one "Undo" key | Open |
| 11 | One row component for workspace lists (`ws-feed-row`, `space-agents-row`, `ws-secret`, `ws-agent-talk-pair`) | Open |
