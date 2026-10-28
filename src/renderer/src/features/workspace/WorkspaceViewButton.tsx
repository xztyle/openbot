import { Button, MessageSquareText } from "@openbot/ui";
import { useText } from "@openbot/ui/text";

/** In the classic sidebar: the way back to the workspace view. */
export function WorkspaceViewButton(props: { onOpen: () => void }) {
  const { t } = useText();
  return (
    <Button variant="outline" size="sm" class="ws-back-to-workspace" onClick={() => props.onOpen()}>
      <MessageSquareText aria-hidden="true" />
      {t("workspace.app.menu.workspace")}
    </Button>
  );
}
