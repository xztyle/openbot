# UX inventory: flows and screen families

Date: 2026-11-18. Base: `main` at `31be19ed3`. Branch: `stream/uxflows`. The standard that these
findings feed is [standard.md](standard.md). The Slack behavior spec is [slack-parity.md](slack-parity.md).

How this was made: code reading of `packages/ui/src` and `src/renderer/src`, Storybook screenshots at
1280 × 800 and 390 × 844, and the web client on the mock host (`scripts/ux-creation-flows-e2e.ts`).
"Status" says what this branch changed. "Open" items are ranked in [standard.md § 9](standard.md#9-what-is-left).

Path keys: `UI/` = `packages/ui/src/features/`, `R/` = `src/renderer/src/features/`.

## 1. Create and edit flows

### 1.1 Before this branch

| Flow | Entry points | Component | Container | Footer | Error | Phone | Bugs |
|---|---|---|---|---|---|---|---|
| New agent (first) | Server with no agents opens it; empty sidebar row | `UI/agents/FirstAgentSetup.tsx` via `R/agents/WorkspaceAgentSetup.tsx` (desktop), `R/web-client/WebAgentSettings.tsx` (web) | Takes over the conversation pane | Create agent under the fields; no Cancel | `p.first-agent-error` | Page, scrolls | – |
| New agent (later) | Sidebar "Add an agent", workspace menu "New agent", Fleet and Space agents "Add agent", command search, old sidebar "+" | Same page as the first agent | Takes over the pane; Cancel top right | Create agent in the body, Cancel in the header | same | Page | Web did not open the new agent. Web Create did nothing after an unconfirmed failure. |
| New agent (template) | Marketplace | `UI/agents/AgentTemplateInstallDialog.tsx` | Dialog with corner actions | Cancel, Add agent | `role=alert` | none | – |
| New agent (canvas) | Routines canvas right-click "New agent here" | `UI/diagrams/DiagramNewAgentCard.tsx` | Card at the click point | Create | inline | – | Kept: in-place create on a canvas |
| New channel (workspace) | Sidebar group "+", workspace menu, Browse "Create a channel", welcome | `UI/workspace/CreateChannelDialog.tsx` | `ws-dialog`, 2 steps | Step text, Next; then Back, Create or "Skip for now" | `p.ws-dialog-error` | Centered card | – |
| New channel (legacy host) | Old sidebar "+", **command search in the workspace too** | `R/channels/ChannelCreateDialog.tsx` | `channel-create-dialog`, 1 step, needs agents | Create only, no Cancel | `Alert` at the top | Centered card | Command search opened this form in the workspace. First focus on the X. |
| New message (DM, group) | Sidebar "+", menu, welcome | `UI/workspace/NewMessageDialog.tsx` | `ws-dialog` | Start DM only, no Cancel | `ws-dialog-error` **and** a toast | Centered card | Error shown twice; agent DM open rejected with no handler (`workspace-controller.ts` `openAgent`). |
| Add members | Channel intro, header, details | `R/workspace/WorkspaceDialogs.tsx` `InviteDialog` | `ws-dialog` | Cancel, Add | **toast only** | Centered card | Failure closed nothing, said nothing in place |
| Edit topic, description | Channel details | `EditMetaDialog` (same file) | `ws-dialog` | Cancel, Save | toast only | Centered card | – |
| New space, edit space | Space rail "+", space menu | `UI/spaces/SpaceDialogs.tsx` `SpaceDialog` | `ws-dialog space-dialog` | Cancel, Create space / Save | `ws-dialog-error` | Centered card | – |
| Move to space, delete space | Space and agent menus | `MoveToSpaceDialog`, `DeleteSpaceDialog` | `ConfirmDialog` | Cancel, Move / Delete space | inside | 560 px rule | – |
| Custom provider, ACP agent | Provider settings | `UI/custom-providers/*Dialog.tsx` | own `custom-provider-*` | Submit only | next to the button | none | Vague "Submit" |
| Profile edit | Settings, Profile | `UI/settings/ProfileEditDialog.tsx` | borrows `ui-confirm-dialog-overlay` | Cancel, Save | Field error | none | – |
| Vault item | Settings, Vault | `UI/vault/VaultPanel.tsx` | borrows confirm-dialog classes | Cancel, Save | `role=alert` | 560 px | – |
| Join server, add server | Server rail | `UI/servers/JoinServerDialog.tsx`, `AddServerDialog.tsx` | `join-server-*` | **Primary first**, then Cancel | Field + alert | 720 / 560 px | Button order reversed |
| OpenCode key, chat apps, saved replies | Settings | own classes | – | Cancel, Save | `role=alert` | none | **No close button** |

Result: 11 class families for one job (`ws-dialog*`, `ui-confirm-dialog*`, `channel-dialog-*`,
`profile-dialog-*`, `custom-provider-*`, `join-server-*`, `mcp-connect-*`, `vault-dialog-*`,
`opencode-key-*`, `saved-replies-*`, `marketplace-install-*`). Three button orders. Four error places.
New agent and new channel looked like two different products (screenshots below).

### 1.2 After this branch

| Flow | Component | Status |
|---|---|---|
| New agent (later), desktop and web | `UI/agents/NewAgentDialog.tsx` on `FormDialog` | Done. Opens over the pane; Cancel and Create agent in the footer; full screen on a phone; the new agent's chat opens. |
| New agent (first) | `FirstAgentSetup` page | Kept as a page (onboarding step). Shares `createAgentDraftEditor`, `AgentAppearanceFields`, `AgentDetailsFields` with the dialog. |
| New channel (workspace and legacy) | `FormDialog` | Done. Both have Cancel; command search opens the workspace form. |
| New message | `FormDialog` | Done. One error, in place. Enter in the search adds the first match. |
| Add members, edit topic, edit description | `FormDialog` | Done. Errors in place; the dialog stays open. |
| New space, edit space | `FormDialog` | Done. |
| Browse channels, quick switcher | `FormDialog` without a footer | Done (same frame, full screen on a phone). |
| Edit profile | `FormDialog` | Done. |
| Template install, custom provider, vault, join server, OpenCode key, chat apps, saved replies | own frames | Open: move to `FormDialog` (standard § 9). |

## 2. List views

All workspace views share `WorkspacePaneHeader`, `.ws-view`, `.ws-view-toolbar`, `.ws-view-scroll`.
None used a shared row, `Item`, `Spinner`, `Skeleton` or `Alert`.

| View | Shared component / wrapper | Rows | Empty | Loading | Error | Phone | Bugs |
|---|---|---|---|---|---|---|---|
| Space agents | `UI/spaces/SpaceAgentsView.tsx` / `R/workspace/WorkspaceSpaceAgents.tsx` | `space-agents-row`, 3 icon buttons | "No agents in this space." also on a search miss | none | in ConfirmDialog | no rules; crowded at 375 px | wrong empty text on a search miss |
| Fleet | `UI/workspace/FleetView.tsx` | cards | "No agents match." also with zero agents | none (source has `loading`) | silent; source gives up for the session | container rule | "Assign" = "Message" |
| Storage | `UI/workspace/StorageView.tsx` | 3 row kinds | `storageHygiene.empty` | blank | warning-colored alert | 640 px media rule | stuck progress after a poll failure |
| Secrets | `UI/workspace/SecretsView.tsx` | `ws-secret` | says "add one", no button | text | load failure shows "No secrets yet" | none | unhandled rejection on add; delete error swallowed |
| Threads | `UI/workspace/ThreadsView.tsx` | `ws-feed-row` | "Nothing new" | none | none | – | – |
| Activity | `UI/workspace/ActivityView.tsx` | `ws-feed-row` | "Nothing new" also when filtered | none (controller has `loading/failed`) | none | – | Mark all read marks every channel of every space |
| Between agents | `UI/workspace/AgentTalkView.tsx` | `ws-agent-talk-pair` | empty also on failure | text | shows empty | none | refresh shows pairs of other spaces |
| Artifacts | `UI/workspace/ArtifactsView.tsx` | cards | rich `ws-empty` | none | silent, permanent | – | `openUrl` without catch |
| Routines | `R/routine-flows/WorkspaceRoutineFlows.tsx` | canvas | blank | blank | bare `role=alert` | – | nested `<main>` |
| Tasks | `UI/tasks/TasksPage.tsx` | own | illustrated | – | – | own header (ArrowLeft, always shown) | header differs from workspace header |

Primary header actions used four variants: "Add agent" default, "Add secret" ghost, "Scan again"
secondary, "Mark all read" ghost.

## 3. Settings pages

Four layout systems:

1. Shell (`UI/settings/SettingsDialogShell.tsx` + `SettingsSection` + `settings-modal-row`): app settings, server settings, web account settings.
2. Side panel (`UI/../components/SettingsPanel.tsx`): agent settings, legacy channel settings, files, routines.
3. Workspace details (`UI/workspace/ChannelDetails.tsx`, private `SettingRow`): channel details tabs.
4. Integrations (`UI/settings/IntegrationLayout.tsx`, `DangerZone`): connectors.

Save models in use: immediate (app settings, channel details), autosave on blur (agent and legacy
channel editors), save bar (server General identity, Workspace, MCP), explicit dialog (profile).
The unsaved-changes guard covers only the server Workspace tab change. The settings page has no
visible close or back control (Escape only). Server-settings rows do not stack at 520 px, unlike
app settings. The save-bar markup is copied three times in `R/servers/ServerSettingsModal.tsx`.

## 4. Confirmations

`ConfirmDialog` (`packages/ui/src/confirm-dialog.tsx`) is used about 50 times and is the standard.
Gaps:

- No confirm: Leave channel (details, header, sidebar), Archive channel, remove a channel member, remove the OpenCode key.
- Agent delete on desktop: confirm ("cannot be undone") **and** an undo toast. Web: confirm, no undo. *Fixed in round 2: a confirm only on both.*
- Bulk delete in a space says "You cannot undo this." but makes undo toasts on desktop. *Fixed in round 2.*
- Errors: about half the destructive confirms pass no `error`; Secrets swallows it.
- The trash icon shows on Leave, Revoke, Disconnect, Discard and Regenerate.
- Three wordings of "cannot be undone".

## 5. Copy

| Thing | Before | After (this branch) |
|---|---|---|
| Make a channel | "New channel", "Create a channel", "Add a channel" | "New channel" for every entry; button "Create channel" |
| Make an agent | "New agent", "Add an agent", "Add agent", "Create a new agent" | "New agent"; button "Create agent" |
| Make a space | "Create a space" | "New space"; button "Create space" |
| Add to a channel | "Add" | "Add members" |
| Step | "Step {step} of {total}", workspace-only keys | `common.step`, `common.next`, `common.back` |
| Spanish gaps | `common.unsaved.*` missing | added |

Fixed in round 2: Spanish uses Quitar for every "Remove" (it was Eliminar in 25 keys, such as "Remove
member"), "Salir de" for every "Leave" ("Abandonar servidor" before), and one common key each for
"Deleting…" (five before), "Removing…" (three) and "Undo" (five).

## 6. Screenshots

Before (Storybook, this branch's base): `/tmp/claude-1000/-home-ubuntu/b4086e1f-0a21-58ba-8bfb-c48fca79100e/scratchpad/ux/before/`.
After: `/tmp/claude-1000/-home-ubuntu/b4086e1f-0a21-58ba-8bfb-c48fca79100e/scratchpad/ux/after/` and
`.openbot-build/ux-creation-flows-e2e/` (written by the E2E script). Screenshots are not committed.
