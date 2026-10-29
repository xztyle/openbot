import { EmojiPicker, EmojiPickerPopover } from "@openbot/ui/features/workspace/EmojiPicker";
import { SmilePlus } from "@openbot/ui/icons";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { LIGHT } from "./workspace-story";

const RECENT = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏🏽", "🔥", "🚀", "💯", "👋🏻", "🤔"];

function Pickers() {
  const [tone, setTone] = createSignal(3);
  const [open, setOpen] = createSignal(false);
  const [picked, setPicked] = createSignal("");
  return (
    <div
      style={{
        display: "flex",
        "flex-wrap": "wrap",
        "align-items": "flex-start",
        gap: "24px",
        padding: "24px",
        "min-height": "100vh",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <div class="ui-popover-menu-surface" style={{ overflow: "hidden" }}>
        <EmojiPicker onPick={fn()} />
      </div>
      <div class="ui-popover-menu-surface" style={{ overflow: "hidden" }}>
        <EmojiPicker
          recent={RECENT}
          skinTone={tone()}
          onSkinToneChange={setTone}
          onPick={(emoji) => setPicked(emoji)}
        />
      </div>
      <div style={{ display: "flex", "align-items": "center", gap: "8px", color: "var(--openbot-text-primary)" }}>
        <EmojiPickerPopover
          open={open()}
          onOpenChange={setOpen}
          trigger={<SmilePlus aria-hidden="true" />}
          triggerLabel="Add reaction"
          placement="bottom-start"
          recent={RECENT}
          skinTone={tone()}
          onSkinToneChange={setTone}
          onPick={(emoji) => setPicked(emoji)}
        />
        <span style={{ "font-size": "var(--openbot-text-3xl)" }}>{picked()}</span>
      </div>
    </div>
  );
}

const meta = {
  title: "Workspace/EmojiPicker",
  component: EmojiPicker,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EmojiPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <Pickers /> };
export const Light: Story = { ...LIGHT, render: () => <Pickers /> };
