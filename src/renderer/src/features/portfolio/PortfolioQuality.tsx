import type {
  AgentQuality,
  AgentSuitePage,
  QualityPage,
  SuiteGate,
  SuiteRun,
  SuiteScenario,
} from "@openbot/contracts/portfolio";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, SwitchField, Text, Textarea, toast } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useWorkspace } from "../workspace/workspace-context";

const GATES = [
  { gate: "off", label: "portfolio.suite.gate.off" },
  { gate: "warn", label: "portfolio.suite.gate.warn" },
  { gate: "block", label: "portfolio.suite.gate.block" },
] as const satisfies readonly { gate: SuiteGate; label: AppTextKey }[];

const TRIGGERS = {
  manual: "portfolio.suite.trigger.manual",
  settings: "portfolio.suite.trigger.settings",
  learning: "portfolio.suite.trigger.learning",
} as const satisfies Record<SuiteRun["trigger"], AppTextKey>;

function blankScenario(index: number): SuiteScenario {
  return { id: `s${Date.now().toString(36)}${index}`, name: "", persona: "", input: "", rubric: "", turns: 2 };
}

/**
 * The Quality tab: the live score of each agent of the space with its weekly trend, and the test suite
 * of the agent the reader opens, with its scenarios, its settings and its runs.
 */
/** A score out of 10 with one decimal: 6.3. */
function useScore(): (value: number) => string {
  const { format } = useText();
  return (value) => format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function PortfolioQuality() {
  const { t, errorMessage } = useText();
  const score = useScore();
  const ws = useWorkspace();
  const calls = () => ws.env.portfolio?.();
  const [page, setPage] = createSignal<QualityPage | null>(null);
  const [open, setOpen] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const agents = createMemo(() => ws.env.agents().filter((agent) => ws.spaces.agentInCurrent(agent.id)));
  const quality = (agentId: string): AgentQuality | undefined =>
    page()?.agents.find((entry) => entry.agentId === agentId);

  async function load(settings?: Partial<QualityPage["settings"]>): Promise<void> {
    const api = calls();
    if (!api) return;
    try {
      setPage(await api.quality(settings));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, t("portfolio.loadFailed")));
    }
  }
  onSettled(() => void load());

  return (
    <div class="portfolio-section">
      <Text tone="muted">{t("portfolio.quality.hint")}</Text>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <Show when={page()?.settings}>
        {(settings) => (
          <SwitchField
            label={t("portfolio.quality.live")}
            description={t("portfolio.quality.liveHint", { percent: Math.round(settings().sampleRate * 100) })}
            checked={settings().enabled}
            onChange={(enabled) => void load({ enabled })}
          />
        )}
      </Show>
      <div class="portfolio-cards">
        <For each={agents()}>
          {(agent) => (
            <article class="portfolio-card">
              <div class="portfolio-row">
                <strong>{agent.name}</strong>
                <Show
                  when={quality(agent.id)?.average7 !== null && quality(agent.id)?.average7 !== undefined}
                  fallback={<span class="portfolio-ratio">{t("portfolio.quality.noScore")}</span>}
                >
                  <span class="portfolio-ratio" data-flagged={quality(agent.id)?.dropped ? "" : undefined}>
                    {t("portfolio.quality.score", { score: score(quality(agent.id)?.average7 ?? 0) })}
                  </span>
                </Show>
              </div>
              <Show when={quality(agent.id)?.dropped}>
                <Text tone="warning">
                  {t("portfolio.quality.dropped", { before: score(quality(agent.id)?.previous7 ?? 0) })}
                </Text>
              </Show>
              <Show when={(quality(agent.id)?.trend.length ?? 0) > 1}>
                <div class="portfolio-trend" role="img" aria-label={t("portfolio.quality.trend")}>
                  <For each={quality(agent.id)?.trend ?? []}>
                    {(point) => (
                      <span
                        class="portfolio-trend-bar"
                        style={{ "--portfolio-bar": String(point.average / 10) }}
                        title={`${point.date}: ${score(point.average)}`}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <Show when={quality(agent.id)?.recent[0]}>
                {(sample) => <Text tone="muted">{t("portfolio.quality.last", { note: sample().note })}</Text>}
              </Show>
              <div class="portfolio-actions">
                <Button
                  size="sm"
                  variant={open() === agent.id ? "secondary" : "ghost"}
                  aria-expanded={open() === agent.id ? "true" : "false"}
                  onClick={() => setOpen((current) => (current === agent.id ? null : agent.id))}
                >
                  {t("portfolio.suite.open")}
                </Button>
              </div>
              <Show when={open() === agent.id}>
                <AgentSuite agentId={agent.id} />
              </Show>
            </article>
          )}
        </For>
      </div>
    </div>
  );
}

function AgentSuite(props: { agentId: string }) {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const calls = () => ws.env.portfolio?.();
  const [page, setPage] = createSignal<AgentSuitePage | null>(null);
  const [scenarios, setScenarios] = createSignal<SuiteScenario[]>([]);
  const [autoRun, setAutoRun] = createSignal(true);
  const [gate, setGate] = createSignal<SuiteGate>("warn");
  const [trials, setTrials] = createSignal(1);
  const [busy, setBusy] = createSignal<"save" | "run" | "draft" | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  function apply(next: AgentSuitePage): void {
    setPage(next);
    if (next.suite) {
      setScenarios(next.suite.scenarios);
      setAutoRun(next.suite.autoRun);
      setGate(next.suite.gate);
      setTrials(next.suite.trials);
    }
  }

  onSettled(() => {
    const api = calls();
    if (!api) return;
    void api
      .suite(props.agentId)
      .then(apply, (failure: unknown) => setError(errorMessage(failure, t("portfolio.loadFailed"))));
  });

  const edit = (index: number, change: Partial<SuiteScenario>) =>
    setScenarios((list) => list.map((scenario, at) => (at === index ? { ...scenario, ...change } : scenario)));
  const complete = () =>
    scenarios().every(
      (scenario) => scenario.name.trim() && scenario.persona.trim() && scenario.input.trim() && scenario.rubric.trim(),
    );

  async function run(kind: "save" | "run" | "draft", action: () => Promise<void>): Promise<void> {
    if (busy()) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure, t("portfolio.suite.failed")));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      const api = calls();
      if (!api) return;
      apply(
        await api.saveSuite({
          agentId: props.agentId,
          scenarios: scenarios().map((scenario) => ({
            ...scenario,
            ...(scenario.mustNot?.trim() ? { mustNot: scenario.mustNot.trim() } : { mustNot: undefined }),
          })),
          autoRun: autoRun(),
          gate: gate(),
          trials: trials(),
          passMark: page()?.suite?.passMark ?? 0.8,
        }),
      );
      toast.success(t("portfolio.suite.saved"));
    });

  const runNow = () =>
    run("run", async () => {
      const api = calls();
      if (!api) return;
      const result = await api.runSuite(props.agentId);
      setPage((current) => (current ? { ...current, runs: [result, ...current.runs] } : current));
    });

  const draft = () =>
    run("draft", async () => {
      const api = calls();
      if (!api) return;
      const drafted = await api.draftSuite(props.agentId);
      if (drafted.length === 0) {
        toast.error(t("portfolio.suite.draftEmpty"));
        return;
      }
      setScenarios((list) =>
        [
          ...list,
          ...drafted.map((scenario, index) => ({
            ...scenario,
            id: `${scenario.id}-${Date.now().toString(36)}${index}`,
          })),
        ].slice(0, 20),
      );
    });

  return (
    <div class="portfolio-suite">
      <Text tone="muted">{t("portfolio.suite.hint")}</Text>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      {/* Keyed by id: an edit replaces the scenario, and the fields must stay the same nodes, with focus. */}
      <For each={scenarios()} keyed={(scenario) => scenario.id}>
        {(scenario, index) => (
          <fieldset class="portfolio-scenario">
            <legend>{t("portfolio.suite.scenario", { number: index() + 1 })}</legend>
            <label>
              <Text tone="muted">{t("portfolio.suite.name")}</Text>
              <Input value={scenario().name} onValueChange={(name) => edit(index(), { name })} />
            </label>
            <label>
              <Text tone="muted">{t("portfolio.suite.persona")}</Text>
              <Textarea
                rows={2}
                value={scenario().persona}
                placeholder={t("portfolio.suite.personaPlaceholder")}
                onValueChange={(persona) => edit(index(), { persona })}
              />
            </label>
            <label>
              <Text tone="muted">{t("portfolio.suite.input")}</Text>
              <Textarea rows={2} value={scenario().input} onValueChange={(input) => edit(index(), { input })} />
            </label>
            <label>
              <Text tone="muted">{t("portfolio.suite.rubric")}</Text>
              <Textarea rows={2} value={scenario().rubric} onValueChange={(rubric) => edit(index(), { rubric })} />
            </label>
            <label>
              <Text tone="muted">{t("portfolio.suite.mustNot")}</Text>
              <Input value={scenario().mustNot ?? ""} onValueChange={(mustNot) => edit(index(), { mustNot })} />
            </label>
            <fieldset class="portfolio-actions" aria-label={t("portfolio.suite.turns")}>
              <For each={[1, 2, 3]}>
                {(turns) => (
                  <Button
                    size="sm"
                    variant={scenario().turns === turns ? "secondary" : "ghost"}
                    aria-pressed={scenario().turns === turns ? "true" : "false"}
                    onClick={() => edit(index(), { turns })}
                  >
                    {t("portfolio.suite.turnsOption", { count: turns })}
                  </Button>
                )}
              </For>
              <Button
                size="sm"
                variant="destructive-ghost"
                onClick={() => setScenarios((list) => list.filter((_, at) => at !== index()))}
              >
                {t("portfolio.suite.remove")}
              </Button>
            </fieldset>
          </fieldset>
        )}
      </For>
      <div class="portfolio-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={scenarios().length >= 20}
          onClick={() => setScenarios((list) => [...list, blankScenario(list.length)])}
        >
          {t("portfolio.suite.add")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy() !== null} onClick={() => void draft()}>
          {busy() === "draft" ? t("portfolio.suite.drafting") : t("portfolio.suite.draft")}
        </Button>
      </div>
      <SwitchField
        label={t("portfolio.suite.autoRun")}
        description={t("portfolio.suite.autoRunHint")}
        checked={autoRun()}
        onChange={setAutoRun}
      />
      <Text tone="muted">{t("portfolio.suite.gateLabel")}</Text>
      <fieldset class="portfolio-actions" aria-label={t("portfolio.suite.gateLabel")}>
        <For each={GATES}>
          {(entry) => (
            <Button
              size="sm"
              variant={gate() === entry.gate ? "secondary" : "ghost"}
              aria-pressed={gate() === entry.gate ? "true" : "false"}
              onClick={() => setGate(entry.gate)}
            >
              {t(entry.label)}
            </Button>
          )}
        </For>
      </fieldset>
      <fieldset class="portfolio-actions" aria-label={t("portfolio.suite.trials")}>
        <For each={[1, 2, 3]}>
          {(count) => (
            <Button
              size="sm"
              variant={trials() === count ? "secondary" : "ghost"}
              aria-pressed={trials() === count ? "true" : "false"}
              onClick={() => setTrials(count)}
            >
              {t("portfolio.suite.trialsOption", { count })}
            </Button>
          )}
        </For>
      </fieldset>
      <div class="portfolio-actions">
        <Button disabled={busy() !== null || !complete()} onClick={() => void save()}>
          {t("portfolio.suite.save")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy() !== null || !(page()?.suite?.scenarios.length ?? 0)}
          onClick={() => void runNow()}
        >
          {busy() === "run" ? t("portfolio.suite.running") : t("portfolio.suite.run")}
        </Button>
      </div>
      <For each={page()?.runs ?? []}>{(entry) => <SuiteRunCard run={entry} />}</For>
    </div>
  );
}

function SuiteRunCard(props: { run: SuiteRun }) {
  const { t, format } = useText();
  const [expanded, setExpanded] = createSignal(false);
  return (
    <article class="portfolio-run" data-passed={props.run.passed ? "" : undefined}>
      <div class="portfolio-row">
        <strong>
          {props.run.status === "failed"
            ? t("portfolio.suite.runFailed")
            : t("portfolio.suite.passRate", { percent: Math.round(props.run.passRate * 100) })}
        </strong>
        <span class="portfolio-ratio" data-flagged={props.run.regression ? "" : undefined}>
          {props.run.regression ? t("portfolio.suite.regression") : t(TRIGGERS[props.run.trigger])}
        </span>
      </div>
      <Text tone="muted">
        {format.date(Date.parse(props.run.at), { dateStyle: "medium", timeStyle: "short" })} · {props.run.label}
      </Text>
      <Show when={props.run.error}>{(message) => <Text tone="danger">{message()}</Text>}</Show>
      <Show when={props.run.diff.length > 0}>
        <ul class="portfolio-claims">
          <For each={props.run.diff}>
            {(line) => (
              <li data-evidence={line.after ? "found" : "missing"}>
                <span class="portfolio-evidence">
                  {line.before === null
                    ? t("portfolio.suite.diff.new")
                    : line.after
                      ? t("portfolio.suite.diff.fixed")
                      : t("portfolio.suite.diff.broke")}
                </span>
                <span>{line.name}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={expanded() ? "true" : "false"}
        onClick={() => setExpanded(!expanded())}
      >
        {expanded() ? t("portfolio.suite.hideResults") : t("portfolio.suite.showResults")}
      </Button>
      <Show when={expanded()}>
        <For each={props.run.results}>
          {(result) => (
            <div class="portfolio-result" data-pass={result.pass ? "" : undefined}>
              <div class="portfolio-row">
                <strong>{result.name}</strong>
                <span class="portfolio-ratio">
                  {t("portfolio.suite.resultLine", {
                    score: result.score,
                    passes: result.passes,
                    trials: result.trials,
                  })}
                </span>
              </div>
              <Text tone="muted">{result.note}</Text>
              <ol class="portfolio-transcript">
                <For each={result.transcript}>
                  {(line) => (
                    <li data-from={line.from}>
                      <strong>
                        {line.from === "customer" ? t("portfolio.suite.customer") : t("portfolio.suite.agent")}
                      </strong>{" "}
                      {line.text}
                    </li>
                  )}
                </For>
              </ol>
              <Show when={result.tools.length > 0}>
                <Text tone="muted">{t("portfolio.suite.tools", { tools: result.tools.join(", ") })}</Text>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </article>
  );
}
