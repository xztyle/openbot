/*
 * "Decided by agents", in the inbox: what the agents' managers decided for the owner (tier 1 of
 * docs/approvals.md), as an FYI. None of it is a Needs you item. Each row says it in plain words (the
 * host explains it for an owner with no technical background); the raw request stays behind a
 * collapsed "technical details". OK hides a row in this browser; Reopen, where the host can, puts the
 * request back in the owner's Today to decide it themselves.
 */
import type { AgentApproval } from "@openbot/contracts/agent-approvals";
import { Button } from "@openbot/ui/button";
import { MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

const KEPT_LIMIT = 500;

function keptKey(workspaceKey: string): string {
  return `atelier:agent-decisions-kept:${workspaceKey}`;
}

function readKept(workspaceKey: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(keptKey(workspaceKey)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function writeKept(workspaceKey: string, kept: ReadonlySet<string>): void {
  try {
    localStorage.setItem(keptKey(workspaceKey), JSON.stringify([...kept].slice(-KEPT_LIMIT)));
  } catch {
    // The row comes back on the next load; nothing is lost.
  }
}

function rowKey(item: AgentApproval): string {
  return `${item.id}\n${item.decidedAt ?? ""}`;
}

export function WorkspaceAgentDecisionsSection() {
  const ws = useWorkspace();
  const { t } = useText();
  const workspaceKey = ws.env.storageKey();
  const [kept, setKept] = createSignal(readKept(workspaceKey));
  const [items, setItems] = createSignal<readonly AgentApproval[]>([]);
  const [busy, setBusy] = createSignal<string | null>(null);
  const load = () => {
    const calls = ws.env.trust?.();
    if (!calls) return;
    void calls
      .approvals()
      .then((view) => setItems(view.decided))
      .catch(() => undefined);
  };
  onSettled(() => load());
  const spaceId = () => (ws.spaces.available() ? ws.spaces.current() : undefined);
  const rows = createMemo(() =>
    items().filter(
      (item) =>
        item.verdict !== "escalate" &&
        !kept().has(rowKey(item)) &&
        (!spaceId() || ws.spaces.agentSpace(item.askerId) === spaceId()),
    ),
  );
  const name = (agentId: string | undefined) =>
    agentId ? (ws.env.agents().find((agent) => agent.id === agentId)?.name ?? agentId) : "";
  const keep = (item: AgentApproval) => {
    const next = new Set([...kept(), rowKey(item)]);
    setKept(next);
    writeKept(workspaceKey, next);
  };
  const reopen = async (item: AgentApproval) => {
    const calls = ws.env.trust?.();
    if (!calls || busy()) return;
    setBusy(item.id);
    try {
      const view = await calls.reopenApproval(item.id);
      setItems(view.decided);
      actionToast.success(t("workspace.agentDecisions.reopened"));
    } catch {
      actionToast.error(t("workspace.agentDecisions.reopenFailed"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Show when={rows().length > 0}>
      <section class="ws-learned" aria-label={t("workspace.agentDecisions.title")}>
        <h2 class="ws-learned-title">{t("workspace.agentDecisions.title")}</h2>
        <p class="ws-learned-note">{t("workspace.agentDecisions.description")}</p>
        <For each={rows()} keyed={rowKey}>
          {(item) => {
            const member = () =>
              memberById(ws.directory(), item().approverId ?? item().askerId, name(item().approverId));
            const head = () =>
              item().verdict === "approve"
                ? t("workspace.agentDecisions.approved", {
                    manager: name(item().approverId),
                    agent: name(item().askerId),
                  })
                : t("workspace.agentDecisions.declined", {
                    manager: name(item().approverId),
                    agent: name(item().askerId),
                  });
            return (
              <article class="ws-learned-row">
                <MemberAvatar member={member()} size="md" />
                <div class="ws-learned-copy">
                  <p class="ws-learned-head">
                    <strong>{head()}</strong>
                  </p>
                  <Show when={item().plain}>
                    {(plain) => (
                      <>
                        <p class="ws-learned-change">{plain().asks}</p>
                        <Show when={plain().why}>{(why) => <p class="ws-learned-note">{why()}</p>}</Show>
                      </>
                    )}
                  </Show>
                  <details class="ws-learned-technical">
                    <summary>{t("workspace.today.technicalDetails")}</summary>
                    <p>{[item().title, item().reason, item().note].filter(Boolean).join("\n")}</p>
                  </details>
                  <div class="ws-learned-actions">
                    <Button size="sm" variant="secondary" onClick={() => keep(item())}>
                      {t("workspace.agentDecisions.keep")}
                    </Button>
                    <Show when={item().reopenable}>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy() === item().id}
                        onClick={() => void reopen(item())}
                      >
                        {t("workspace.agentDecisions.reopen")}
                      </Button>
                    </Show>
                  </div>
                </div>
              </article>
            );
          }}
        </For>
      </section>
    </Show>
  );
}
