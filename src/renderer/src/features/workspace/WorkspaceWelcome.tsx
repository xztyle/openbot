import { AtSign, Button, Hash, IconButton, MessageCircle, Plus, SquarePen, Waypoints, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";

/** The id of the answer-mode hint, in the hints the reader closed. */
export const ANSWER_MODES_HINT = "answer-modes";

/** The three ways an agent answers in a channel, for the welcome and the first channel with agents. */
function AnswerModes() {
  const { t } = useText();
  const modes = (): { icon: JSX.Element; title: string; text: string }[] => [
    {
      icon: <AtSign aria-hidden="true" />,
      title: t("workspace.app.welcome.modeMention"),
      text: t("workspace.app.welcome.modeMentionHint"),
    },
    {
      icon: <MessageCircle aria-hidden="true" />,
      title: t("workspace.app.welcome.modeAlways"),
      text: t("workspace.app.welcome.modeAlwaysHint"),
    },
    {
      icon: <Waypoints aria-hidden="true" />,
      title: t("workspace.app.welcome.modeLead"),
      text: t("workspace.app.welcome.modeLeadHint"),
    },
  ];
  return (
    <ul class="ws-welcome-modes">
      <For each={modes()}>
        {(mode) => (
          <li class="ws-welcome-mode">
            <span class="ws-welcome-mode-icon">{mode.icon}</span>
            <span class="ws-welcome-mode-title">{mode.title}</span>
            <span class="ws-welcome-mode-text">{mode.text}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * A workspace with no channel yet: what channels are, the button that makes #general with the whole
 * team and its agents, and how agents answer.
 */
export function WorkspaceWelcome() {
  const { t } = useText();
  const ws = useWorkspace();
  return (
    <section class="ws-welcome" aria-labelledby="ws-welcome-title">
      <div class="ws-welcome-inner">
        <span class="ws-channel-intro-glyph" aria-hidden="true">
          <Hash />
        </span>
        <h1 id="ws-welcome-title" class="ws-welcome-title">
          {t("workspace.app.welcome.title", { name: ws.env.serverName() })}
        </h1>
        <p class="ws-welcome-text">{t("workspace.app.welcome.body")}</p>
        <div class="ws-welcome-actions">
          <Button
            loading={ws.state.creatingGeneral}
            disabled={!ws.env.connectionReady()}
            onClick={() => void ws.ensureGeneral()}
          >
            <Hash aria-hidden="true" />
            {t("workspace.app.welcome.createGeneral")}
          </Button>
          <Button variant="outline" onClick={() => ws.openDialog({ kind: "create-channel" })}>
            <Plus aria-hidden="true" />
            {t("workspace.app.welcome.createChannel")}
          </Button>
          <Button variant="ghost" onClick={() => ws.openDialog({ kind: "new-message" })}>
            <SquarePen aria-hidden="true" />
            {t("workspace.app.welcome.newMessage")}
          </Button>
        </div>
        <h2 class="ws-welcome-subtitle">{t("workspace.app.welcome.modesTitle")}</h2>
        <AnswerModes />
      </div>
    </section>
  );
}

/**
 * The first channel with agents tells once how they answer, and where to change it. Closing it
 * keeps it closed on this computer.
 */
export function AnswerModesHint(props: { channelId: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  return (
    <Show when={!ws.state.hintsSeen[ANSWER_MODES_HINT]}>
      <aside class="ws-hint" aria-label={t("workspace.app.welcome.modesTitle")}>
        <span class="ws-hint-icon" aria-hidden="true">
          <AtSign />
        </span>
        <p class="ws-hint-text">{t("workspace.app.hint.answerModes")}</p>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            ws.openDetails(props.channelId, "members");
            ws.closeHint(ANSWER_MODES_HINT);
          }}
        >
          {t("workspace.app.hint.openMembers")}
        </Button>
        <IconButton
          variant="ghost"
          size="icon-xs"
          label={t("workspace.app.hint.dismiss")}
          onClick={() => ws.closeHint(ANSWER_MODES_HINT)}
        >
          <X />
        </IconButton>
      </aside>
    </Show>
  );
}
