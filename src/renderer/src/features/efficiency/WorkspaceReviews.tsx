import type {
  ModelSavingsSnapshot,
  PerformanceReview,
  RolePlaybook,
  RolePlaybooksSnapshot,
} from "@openbot/contracts/agent-efficiency";
import type { LearningReviewItem, LearningSettings } from "@openbot/contracts/agent-learning";
import { Button, Input, SwitchField, Text, Textarea, toast } from "@openbot/ui";
import { WorkspacePaneHeader } from "@openbot/ui/features/workspace/WorkspacePaneHeader";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useWorkspace } from "../workspace/workspace-context";
import { LearningCard } from "./LearningCard";
import { ReviewCard } from "./ReviewCard";
import "./efficiency.css";

const GRADE_ORDER = { poor: 0, watch: 1, good: 2, great: 3 } as const;

interface PlaybookDraft {
  id?: string;
  slug: string;
  roles: string;
  content: string;
}

/**
 * The Reviews view: what the automatic model policy saved, the newest weekly review of each agent of
 * the space with its proposal to approve, the role playbooks with the changes agents proposed, and
 * what the nightly memory cleanup and the task lessons propose for the agents of the space.
 * For an owner or an admin of a host with agent-efficiency-v1.
 */
export function WorkspaceReviewsView() {
  const { t, format, errorMessage } = useText();
  const ws = useWorkspace();
  const calls = () => ws.env.efficiency?.();
  const [tab, setTab] = createSignal<"reviews" | "playbooks" | "learning">("reviews");
  const [learning, setLearning] = createSignal<LearningReviewItem[] | null>(null);
  const [learningSettings, setLearningSettings] = createSignal<LearningSettings | null>(null);
  const [reviews, setReviews] = createSignal<PerformanceReview[] | null>(null);
  const [enabled, setEnabled] = createSignal(true);
  const [savings, setSavings] = createSignal<ModelSavingsSnapshot | null>(null);
  const [playbooks, setPlaybooks] = createSignal<RolePlaybooksSnapshot | null>(null);
  const [draft, setDraft] = createSignal<PlaybookDraft | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const agentName = (agentId: string) => ws.env.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
  const inSpace = (agentId: string) => ws.spaces.agentInCurrent(agentId);

  async function load(): Promise<void> {
    const api = calls();
    if (!api) return;
    try {
      const [page, saved, books] = await Promise.all([api.reviews({}), api.modelSavings(), api.playbooks()]);
      setReviews(page.reviews);
      setEnabled(page.enabled !== false);
      setSavings(saved);
      setPlaybooks(books);
      setError(null);
      // A host before agent-learning-v1 answers 404: the tab then stays empty.
      const learned = await api.learning({}).catch(() => null);
      setLearning(learned?.items ?? null);
      setLearningSettings(learned?.settings ?? null);
    } catch (failure) {
      setError(errorMessage(failure, t("efficiency.view.loadFailed")));
    }
  }
  onSettled(() => void load());

  const shown = createMemo(() =>
    (reviews() ?? [])
      .filter((review) => inSpace(review.agentId))
      .sort((left, right) => {
        const pending = Number(right.proposal?.state === "pending") - Number(left.proposal?.state === "pending");
        return pending || GRADE_ORDER[left.grade] - GRADE_ORDER[right.grade];
      }),
  );
  const pendingCount = () => shown().filter((review) => review.proposal?.state === "pending").length;
  // An item of one agent shows in that agent's space; a change of a whole space only in that space.
  const learned = createMemo(() =>
    (learning() ?? []).filter((item) =>
      item.agentId === null ? item.spaceId === null || item.spaceId === ws.spaces.current() : inSpace(item.agentId),
    ),
  );
  const learningPending = () => learned().filter((item) => item.state === "pending");
  const learningDone = () =>
    learned()
      .filter((item) => item.state !== "pending")
      .slice(0, 20);
  const replaceItem = (next: LearningReviewItem) =>
    setLearning((list) => (list ?? []).map((item) => (item.id === next.id ? next : item)));
  function setLearningSetting(change: Partial<LearningSettings>): void {
    const api = calls();
    const before = learningSettings();
    if (!api || !before) return;
    setLearningSettings({ ...before, ...change });
    void api.learning({ settings: change }).then(
      (page) => setLearningSettings(page.settings),
      () => setLearningSettings(before),
    );
  }

  async function act(run: () => Promise<RolePlaybooksSnapshot>): Promise<boolean> {
    setBusy(true);
    try {
      setPlaybooks(await run());
      return true;
    } catch (failure) {
      toast.error(t("efficiency.playbooks.saveFailed"), {
        error: failure,
        fallback: t("efficiency.playbooks.saveFailed"),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(): Promise<void> {
    const api = calls();
    const current = draft();
    if (!api || !current) return;
    const roles = current.roles
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);
    const saved = await act(() =>
      api.savePlaybook({
        ...(current.id ? { id: current.id } : {}),
        slug: current.slug.trim(),
        roles,
        content: current.content,
      }),
    );
    if (saved) setDraft(null);
  }

  const editDraft = (change: Partial<PlaybookDraft>) =>
    setDraft((current) => (current ? { ...current, ...change } : current));
  const edit = (playbook: RolePlaybook) =>
    setDraft({ id: playbook.id, slug: playbook.slug, roles: playbook.roles.join(", "), content: playbook.content });

  return (
    <section class="ws-view" aria-label={t("efficiency.view.title")}>
      <WorkspacePaneHeader title={t("efficiency.view.title")} onBack={() => ws.back()} />
      <div class="efficiency-view">
        <div class="efficiency-actions">
          <Button
            variant={tab() === "reviews" ? "secondary" : "ghost"}
            aria-pressed={tab() === "reviews" ? "true" : "false"}
            onClick={() => setTab("reviews")}
          >
            {t("efficiency.view.tab.reviews")}
          </Button>
          <Button
            variant={tab() === "playbooks" ? "secondary" : "ghost"}
            aria-pressed={tab() === "playbooks" ? "true" : "false"}
            onClick={() => setTab("playbooks")}
          >
            {t("efficiency.view.tab.playbooks")}
          </Button>
          <Show when={learningSettings()}>
            <Button
              variant={tab() === "learning" ? "secondary" : "ghost"}
              aria-pressed={tab() === "learning" ? "true" : "false"}
              onClick={() => setTab("learning")}
            >
              {t("efficiency.view.tab.learning")}
            </Button>
          </Show>
        </div>
        <Show when={error()}>
          {(message) => (
            <div class="efficiency-row">
              <Text role="alert">{message()}</Text>
              <Button variant="ghost" onClick={() => void load()}>
                {t("common.retry")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={tab() === "reviews"}>
          <Show when={savings()}>
            {(saved) => (
              <div class="efficiency-section">
                <h3>{t("efficiency.savings.title", { days: String(saved().days) })}</h3>
                <Show when={saved().autoTurns > 0} fallback={<Text tone="muted">{t("efficiency.savings.none")}</Text>}>
                  <Text>
                    {t("efficiency.savings.line", {
                      auto: format.number(saved().autoTurns),
                      turns: format.number(saved().turns),
                      small: format.number(saved().smallTurns),
                      cost: format.number(saved().costUsd, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                      fixed: format.number(saved().fixedCostUsd, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }),
                    })}
                  </Text>
                </Show>
                <Text tone="muted">{t("efficiency.savings.switches", { count: String(saved().warmSwitches) })}</Text>
              </div>
            )}
          </Show>
          <div class="efficiency-section">
            <SwitchField
              label={t("efficiency.view.weekly")}
              description={t("efficiency.view.weeklyHint")}
              checked={enabled()}
              onChange={(next) => {
                setEnabled(next);
                void calls()
                  ?.reviews({ enabled: next })
                  .catch(() => setEnabled(!next));
              }}
            />
            <Show when={pendingCount() > 0}>
              <Text>{t("efficiency.view.pending", { count: pendingCount() })}</Text>
            </Show>
            <Show when={reviews() !== null && shown().length === 0}>
              <Text tone="muted">{t("efficiency.view.empty")}</Text>
            </Show>
            <For each={shown()} keyed={(review) => review.id}>
              {(review) => (
                <Show when={calls()}>
                  {(api) => (
                    <ReviewCard
                      review={review()}
                      agentName={agentName(review().agentId)}
                      calls={api()}
                      onDecided={(next) =>
                        setReviews((list) => (list ?? []).map((item) => (item.id === next.id ? next : item)))
                      }
                    />
                  )}
                </Show>
              )}
            </For>
          </div>
        </Show>
        <Show when={tab() === "learning"}>
          <div class="efficiency-section">
            <h3>{t("efficiency.learning.title")}</h3>
            <Text tone="muted">{t("efficiency.learning.hint")}</Text>
            <Show when={learningSettings()}>
              {(settings) => (
                <>
                  <SwitchField
                    label={t("efficiency.learning.dreaming")}
                    checked={settings().dreaming}
                    onChange={(dreaming) => setLearningSetting({ dreaming })}
                  />
                  <SwitchField
                    label={t("efficiency.learning.taskLearning")}
                    checked={settings().taskLearning}
                    onChange={(taskLearning) => setLearningSetting({ taskLearning })}
                  />
                </>
              )}
            </Show>
            <Show
              when={learningPending().length > 0}
              fallback={<Text tone="muted">{t("efficiency.learning.empty")}</Text>}
            >
              <Text>{t("efficiency.learning.pending", { count: learningPending().length })}</Text>
            </Show>
            <For each={learningPending()} keyed={(item) => item.id}>
              {(item) => (
                <Show when={calls()}>
                  {(api) => (
                    <LearningCard
                      item={item()}
                      calls={api()}
                      agentName={item().agentId ? agentName(item().agentId ?? "") : undefined}
                      onDecided={replaceItem}
                    />
                  )}
                </Show>
              )}
            </For>
            <Show when={learningDone().length > 0}>
              <h3>{t("efficiency.learning.recent")}</h3>
              <For each={learningDone()} keyed={(item) => item.id}>
                {(item) => (
                  <Show when={calls()}>
                    {(api) => (
                      <LearningCard
                        item={item()}
                        calls={api()}
                        agentName={item().agentId ? agentName(item().agentId ?? "") : undefined}
                        onDecided={replaceItem}
                      />
                    )}
                  </Show>
                )}
              </For>
            </Show>
          </div>
        </Show>
        <Show when={tab() === "playbooks"}>
          <div class="efficiency-section">
            <h3>{t("efficiency.playbooks.title")}</h3>
            <Text tone="muted">{t("efficiency.playbooks.hint")}</Text>
            <Show when={playbooks()?.proposals.length}>
              <h3>{t("efficiency.playbooks.proposals")}</h3>
              <For each={playbooks()?.proposals ?? []} keyed={(proposal) => proposal.id}>
                {(proposal) => (
                  <div class="efficiency-review">
                    <strong>
                      {t("efficiency.playbooks.proposalBy", {
                        agent: agentName(proposal().agentId),
                        slug: playbooks()?.playbooks.find((item) => item.id === proposal().playbookId)?.slug ?? "",
                      })}
                    </strong>
                    <Text>{proposal().note}</Text>
                    <Textarea value={proposal().content} rows={8} readonly />
                    <div class="efficiency-actions">
                      <Button
                        disabled={busy()}
                        onClick={() =>
                          void act(() => calls()?.decidePlaybook(proposal().id, "approve") ?? Promise.reject())
                        }
                      >
                        {t("efficiency.playbooks.approve")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy()}
                        onClick={() =>
                          void act(() => calls()?.decidePlaybook(proposal().id, "dismiss") ?? Promise.reject())
                        }
                      >
                        {t("efficiency.playbooks.dismiss")}
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
            <Show when={playbooks() && playbooks()?.playbooks.length === 0}>
              <Text tone="muted">{t("efficiency.playbooks.empty")}</Text>
            </Show>
            <For each={playbooks()?.playbooks ?? []} keyed={(playbook) => playbook.id}>
              {(playbook) => (
                <div class="efficiency-review">
                  <div class="efficiency-row">
                    <strong>{playbook().slug}</strong>
                    <Text tone="muted">{t("efficiency.playbooks.agents", { count: playbook().agentIds.length })}</Text>
                  </div>
                  <Text>{playbook().roles.join(", ")}</Text>
                  <div class="efficiency-actions">
                    <Button variant="ghost" disabled={busy()} onClick={() => edit(playbook())}>
                      {t("efficiency.playbooks.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void act(() => calls()?.removePlaybook(playbook().id) ?? Promise.reject())}
                    >
                      {t("efficiency.playbooks.remove")}
                    </Button>
                  </div>
                </div>
              )}
            </For>
            <Show
              when={draft()}
              fallback={
                <div class="efficiency-actions">
                  <Button variant="secondary" onClick={() => setDraft({ slug: "", roles: "", content: "" })}>
                    {t("efficiency.playbooks.new")}
                  </Button>
                </div>
              }
            >
              {(current) => (
                <div class="efficiency-review">
                  <label>
                    <Text tone="muted">{t("efficiency.playbooks.slug")}</Text>
                    <Input
                      value={current().slug}
                      disabled={busy() || current().id !== undefined}
                      onValueChange={(slug) => editDraft({ slug })}
                    />
                  </label>
                  <label>
                    <Text tone="muted">{t("efficiency.playbooks.roles")}</Text>
                    <Input value={current().roles} disabled={busy()} onValueChange={(roles) => editDraft({ roles })} />
                  </label>
                  <label>
                    <Text tone="muted">{t("efficiency.playbooks.content")}</Text>
                    <Textarea
                      value={current().content}
                      rows={14}
                      disabled={busy()}
                      onValueChange={(content) => editDraft({ content })}
                    />
                  </label>
                  <div class="efficiency-actions">
                    <Button
                      disabled={
                        busy() || !current().slug.trim() || !current().roles.trim() || !current().content.trim()
                      }
                      onClick={() => void saveDraft()}
                    >
                      {t("efficiency.playbooks.save")}
                    </Button>
                    <Button variant="ghost" disabled={busy()} onClick={() => setDraft(null)}>
                      {t("efficiency.playbooks.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={playbooks()?.candidates.length}>
              <h3>{t("efficiency.playbooks.candidates")}</h3>
              <For each={playbooks()?.candidates ?? []} keyed={(candidate) => candidate.slug}>
                {(candidate) => (
                  <div class="efficiency-row">
                    <Text>
                      {t("efficiency.playbooks.candidate", {
                        slug: candidate().slug,
                        count: candidate().agentIds.length,
                      })}
                    </Text>
                    <Button
                      variant="secondary"
                      disabled={busy() || !candidate().agentIds[0]}
                      onClick={() => {
                        const agentId = candidate().agentIds[0];
                        const api = calls();
                        if (!agentId || !api) return;
                        void act(() =>
                          api.importPlaybook({
                            agentId,
                            slug: candidate().slug,
                            roles: [candidate().suggestedRole ?? candidate().slug],
                          }),
                        );
                      }}
                    >
                      {t("efficiency.playbooks.make")}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  );
}
