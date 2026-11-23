/*
 * What waits on the reader in an agent's DM that its chat has no card for: a Motion ticket that the
 * agent handed to the reader. The sidebar marks the DM as waiting for it, so the DM says what it is,
 * opens it, and lets the reader dismiss it, which clears the mark.
 */
import { isTicketAttention } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui/button";
import { ExternalLink, Ticket } from "@openbot/ui/icons";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For } from "solid-js";
import { useWorkspace } from "./workspace-context";

export function WorkspaceAgentWaits(props: { agentId: string }) {
  const ws = useWorkspace();
  const { t } = useText();
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = createSignal<string | null>(null);
  const tickets = createMemo(() =>
    (ws.env.needsYou?.() ?? []).filter(
      (item) => item.agentId === props.agentId && isTicketAttention(item) && !gone().has(String(item.requestId)),
    ),
  );
  const dismiss = async (requestId: string | number) => {
    const key = String(requestId);
    setFailed(null);
    setGone((keys) => new Set([...keys, key]));
    try {
      await ws.channels.port().agent.respondToPrompt({ requestId, answers: {} });
    } catch {
      setGone((keys) => new Set([...keys].filter((entry) => entry !== key)));
      setFailed(key);
    }
  };
  return (
    <For each={tickets()} keyed={(item) => String(item.requestId)}>
      {(item) => (
        <div class="ws-agent-dm-wait" role="status">
          <Ticket class="ws-agent-dm-wait-icon" aria-hidden="true" />
          <span class="ws-agent-dm-wait-text">
            {t("workspace.needsYou.banner.ticket", { ticket: item().summary ?? "" })}
            {failed() === String(item().requestId) ? ` · ${t("workspace.today.answerFailed")}` : ""}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const url = item().url;
              if (url) void ws.channels.port().openUrl(url);
            }}
          >
            {t("workspace.needsYou.banner.openTicket")}
            <ExternalLink aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void dismiss(item().requestId)}>
            {t("workspace.today.dismiss")}
          </Button>
        </div>
      )}
    </For>
  );
}
