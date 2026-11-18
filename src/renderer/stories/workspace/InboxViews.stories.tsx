import { DirectMessagesView } from "@openbot/ui/features/workspace/DirectMessagesView";
import { LaterView } from "@openbot/ui/features/workspace/LaterView";
import { SearchView } from "@openbot/ui/features/workspace/SearchView";
import { ShortcutsSheet } from "@openbot/ui/features/workspace/ShortcutsSheet";
import { UnreadsView } from "@openbot/ui/features/workspace/UnreadsView";
import { WorkspaceSearchBar } from "@openbot/ui/features/workspace/WorkspaceSearchBar";
import { currentText } from "@openbot/ui/text";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { workspaceShortcutGroups } from "../../src/features/workspace/workspace-shortcuts";
import { delynith, fonikad, gameDesigner, mention, NOW, orchestrator, qa, text } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const MINUTE = 60_000;

const unreads = () => (
  <StoryFrame width="760px">
    <UnreadsView
      groups={[
        {
          id: "launch",
          name: "launch",
          kind: "channel",
          visibility: "public",
          count: 2,
          read: false,
          collapsed: false,
          messages: [
            {
              id: "m1",
              author: orchestrator,
              at: NOW - 30 * MINUTE,
              text: [text("The build is green. "), mention(delynith, true), text(" can you approve the release?")],
            },
            { id: "m2", author: fonikad, at: NOW - 12 * MINUTE, text: [text("Release notes are in the doc.")] },
          ],
        },
        {
          id: "dm-qa",
          name: qa.name,
          kind: "dm",
          visibility: "private",
          members: [qa],
          count: 1,
          read: true,
          collapsed: true,
          messages: [{ id: "m3", author: qa, at: NOW - 5 * MINUTE, text: [text("All smoke tests pass.")] }],
        },
      ]}
      stale
      onRefresh={fn()}
      onOpenMessage={fn()}
      onOpenConversation={fn()}
      onMarkRead={fn()}
      onUndo={fn()}
      onToggle={fn()}
      onMarkAllRead={fn()}
    />
  </StoryFrame>
);

const later = () => (
  <StoryFrame width="760px">
    <LaterView
      tab="saved"
      onTabChange={fn()}
      savedCount={2}
      items={[
        {
          id: "launch/m1",
          author: orchestrator,
          where: "#launch",
          inThread: false,
          at: NOW - 3 * 60 * MINUTE,
          preview: "The build is green. Approve the release when the notes are ready.",
          deleted: false,
        },
        {
          id: "design/m2",
          author: gameDesigner,
          where: "#design",
          inThread: true,
          at: NOW - 26 * 60 * MINUTE,
          preview: "Here are three level layouts for the tutorial.",
          deleted: false,
        },
      ]}
      onOpen={fn()}
      onSetDone={fn()}
      onRemove={fn()}
    />
  </StoryFrame>
);

const dms = () => (
  <StoryFrame width="760px">
    <DirectMessagesView
      items={[
        {
          id: "dm-fonikad",
          kind: "dm",
          members: [fonikad],
          name: fonikad.name,
          preview: "Lunch at 12?",
          at: NOW - 8 * MINUTE,
          unread: true,
          count: 2,
        },
        {
          id: "dm-qa",
          kind: "dm",
          members: [qa],
          name: qa.name,
          preview: "I ran the smoke tests.",
          fromReader: true,
          at: NOW - 3 * 60 * MINUTE,
          unread: false,
          count: 0,
        },
        {
          id: "group",
          kind: "group",
          members: [fonikad, orchestrator],
          name: `${fonikad.name}, ${orchestrator.name}`,
          preview: "The plan is in the doc.",
          author: orchestrator.name,
          at: NOW - 2 * 24 * 60 * MINUTE,
          unread: false,
          count: 0,
        },
      ]}
      onOpen={fn()}
      onNewMessage={fn()}
    />
  </StoryFrame>
);

const search = () => (
  <StoryFrame width="760px">
    <SearchView
      query="release from:@Orchestrator"
      onSubmit={fn()}
      tab="messages"
      onTabChange={fn()}
      total={2}
      hits={[
        {
          id: "h1",
          author: orchestrator,
          where: "#launch",
          inThread: false,
          at: NOW - 30 * MINUTE,
          snippet: "The build is green. Can you approve the release?",
          highlights: [{ start: 40, length: 7 }],
        },
        {
          id: "h2",
          author: orchestrator,
          where: "#launch",
          inThread: true,
          at: NOW - 2 * 24 * 60 * MINUTE,
          snippet: "The release branch is frozen.",
          highlights: [{ start: 4, length: 7 }],
        },
      ]}
      channels={[{ id: "launch", name: "launch", visibility: "public", memberCount: 6, joined: true }]}
      people={[]}
      filtered
      onClearFilters={fn()}
      onOpenHit={fn()}
      onOpenChannel={fn()}
      onOpenPerson={fn()}
      recent={["release", "from:me is:thread"]}
    />
  </StoryFrame>
);

const searchBar = () => (
  <StoryFrame width="760px">
    <WorkspaceSearchBar
      placeholder="Search Acme"
      shortcut="⌘G"
      recent={["release notes", "from:@Orchestrator build"]}
      suggestions={() => [{ id: "launch", label: "launch", kind: "channel" }]}
      onSubmit={fn()}
      onOpenSuggestion={fn()}
      onShortcuts={fn()}
    />
  </StoryFrame>
);

const meta = {
  title: "Workspace/Inbox views",
  component: UnreadsView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof UnreadsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unreads: Story = { render: unreads };
export const UnreadsLight: Story = { ...LIGHT, render: unreads };
export const Later: Story = { render: later };
export const DirectMessages: Story = { render: dms };
export const SearchResults: Story = { render: search };
export const SearchResultsLight: Story = { ...LIGHT, render: search };
export const SearchField: Story = { render: searchBar };

/** Nothing unread: what the view says. */
export const UnreadsEmpty: Story = {
  render: () => (
    <StoryFrame width="760px">
      <UnreadsView
        groups={[]}
        onRefresh={fn()}
        onOpenMessage={fn()}
        onOpenConversation={fn()}
        onMarkRead={fn()}
        onToggle={fn()}
        onMarkAllRead={fn()}
      />
    </StoryFrame>
  ),
};

/** The ⌘/ sheet with the macOS keys. */
export const Shortcuts: Story = {
  render: () => <ShortcutsSheet open onOpenChange={fn()} groups={workspaceShortcutGroups(currentText().t, true)} />,
};
