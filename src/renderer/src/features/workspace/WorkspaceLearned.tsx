/*
 * What the agents learned, at the top of the inbox: a memory an agent's review added, rewrote or
 * forgot applies by itself, and the owner reads it here afterwards. Keep only marks it read; Revert
 * puts the memory back as it was (the item keeps the text from before). A lesson for an agent's
 * instructions, playbook or skill does not apply by itself, so it shows here with Apply and Dismiss.
 * None of it is a Needs you item. What the reader marked read is kept in this browser.
 */
import type { LearningChange, LearningReviewItem } from "@openbot/contracts/agent-learning";
import { Button } from "@openbot/ui/button";
import { MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const KEPT_LIMIT = 500;

function keptKey(workspaceKey: string): string {
  return `atelier:learned-kept:${workspaceKey}`;
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

/** One change of an item, as the reader reads it. */
function changeText(item: LearningReviewItem, t: ReturnType<typeof useText>["t"]): string {
  return item.changes.map((change) => changeLine(change, t)).join("\n");
}

function changeLine(change: LearningChange, t: ReturnType<typeof useText>["t"]): string {
  switch (change.type) {
    case "memory-update":
      return t("workspace.learned.change.update", { before: change.before, after: change.after });
    case "memory-forget":
      return t("workspace.learned.change.forget", { before: change.before });
    case "instructions-add":
      return t("workspace.learned.change.instructions", { text: change.text });
    case "playbook-add":
      return t("workspace.learned.change.playbook", { name: change.slug, text: change.text });
    case "skill-add":
      return t("workspace.learned.change.skill", { name: change.name, text: change.text });
    case "skill-copy":
      return t("workspace.learned.change.skillCopy", { name: change.name });
  }
}

export function WorkspaceLearnedSection() {
  const ws = useWorkspace();
  const { t } = useText();
  const workspaceKey = ws.env.storageKey();
  const [kept, setKept] = createSignal(readKept(workspaceKey));
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
  const spaceId = () => (ws.spaces.available() ? ws.spaces.current() : undefined);
  const [items, setItems] = createSignal<readonly LearningReviewItem[]>([]);
  let read = 0;
  // Read again when the space changes; an older answer that lands later is dropped.
  createEffect(
    () => (ws.env.efficiency?.() ? (spaceId() ?? "") : null),
    (space) => {
      const calls = ws.env.efficiency?.();
      if (space === null || !calls) return;
      const current = ++read;
      void calls
        .learning(space ? { spaceId: space } : {})
        .then((page) => {
          if (current === read) setItems(page.items);
        })
        .catch(() => undefined);
    },
  );
  const rows = createMemo(() => {
    const since = Date.now() - WEEK_MS;
    const hidden = gone();
    const read = kept();
    return items().filter(
      (item) =>
        !hidden.has(item.id) &&
        ((item.state === "auto-applied" && item.kind === "memory" && !read.has(item.id)) || item.state === "pending") &&
        Date.parse(item.createdAt) >= since,
    );
  });
  const keep = (id: string) => {
    const next = new Set([...kept(), id]);
    setKept(next);
    writeKept(workspaceKey, next);
  };
  const decide = async (item: LearningReviewItem, decision: "accept" | "dismiss" | "revert") => {
    const calls = ws.env.efficiency?.();
    if (!calls) return;
    setGone((ids) => new Set([...ids, item.id]));
    try {
      await calls.decideLearning(item.id, decision);
      if (decision === "revert") actionToast.success(t("workspace.learned.reverted"));
    } catch (error) {
      setGone((ids) => new Set([...ids].filter((id) => id !== item.id)));
      actionToast.error(error instanceof Error ? error.message : t("workspace.today.answerFailed"));
    }
  };
  return (
    <Show when={rows().length > 0}>
      <section class="ws-learned" aria-label={t("workspace.learned.title")}>
        <h2 class="ws-learned-title">{t("workspace.learned.title")}</h2>
        <For each={rows()} keyed={(item) => item.id}>
          {(item) => {
            const member = () =>
              memberById(ws.directory(), item().agentId ?? "learning", t("workspace.today.learning"));
            const applied = () => item().state === "auto-applied";
            return (
              <article class="ws-learned-row">
                <MemberAvatar member={member()} size="md" />
                <div class="ws-learned-copy">
                  <p class="ws-learned-head">
                    <strong>{member().name}</strong>{" "}
                    {applied() ? t("workspace.learned.applied") : t("workspace.learned.proposed")}
                  </p>
                  <p class="ws-learned-change">{changeText(item(), t)}</p>
                  <Show when={item().note}>{(note) => <p class="ws-learned-note">{note()}</p>}</Show>
                  <div class="ws-learned-actions">
                    <Show
                      when={applied()}
                      fallback={
                        <>
                          <Button size="sm" onClick={() => void decide(item(), "accept")}>
                            {t("workspace.today.apply")}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void decide(item(), "dismiss")}>
                            {t("workspace.today.dismiss")}
                          </Button>
                        </>
                      }
                    >
                      <Button size="sm" variant="secondary" onClick={() => keep(item().id)}>
                        {t("workspace.learned.keep")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void decide(item(), "revert")}>
                        {t("workspace.learned.revert")}
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
