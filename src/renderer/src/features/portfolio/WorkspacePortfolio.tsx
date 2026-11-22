import type { RealityPage, RealityReport, ValueReport } from "@openbot/contracts/portfolio";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, SwitchField, Text, toast } from "@openbot/ui";
import { WorkspacePaneHeader } from "@openbot/ui/features/workspace/WorkspacePaneHeader";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useWorkspace } from "../workspace/workspace-context";
import { PortfolioQuality } from "./PortfolioQuality";
import { PortfolioTemplates } from "./PortfolioTemplates";
import "./portfolio.css";

type Tab = "value" | "quality" | "templates" | "reality";
const TABS = [
  { id: "value", label: "portfolio.tab.value" },
  { id: "quality", label: "portfolio.tab.quality" },
  { id: "templates", label: "portfolio.tab.templates" },
  { id: "reality", label: "portfolio.tab.reality" },
] as const satisfies readonly { id: Tab; label: AppTextKey }[];

const DAYS = [7, 30, 90] as const;
const WEEKDAYS = [
  "portfolio.reality.day.0",
  "portfolio.reality.day.1",
  "portfolio.reality.day.2",
  "portfolio.reality.day.3",
  "portfolio.reality.day.4",
  "portfolio.reality.day.5",
  "portfolio.reality.day.6",
] as const satisfies readonly AppTextKey[];

const EVIDENCE = {
  found: "portfolio.reality.found",
  missing: "portfolio.reality.missing",
  unknown: "portfolio.reality.unknown",
} as const satisfies Record<RealityReport["claims"][number]["evidence"], AppTextKey>;

/**
 * The Portfolio view: the value that each space and agent earns next to its cost, each agent's test
 * suite and live score, the space templates with their validation stage, and the weekly reality
 * check. For an owner or an admin of a host with portfolio-v1.
 */
export function WorkspacePortfolioView() {
  const { t } = useText();
  const ws = useWorkspace();
  const [tab, setTab] = createSignal<Tab>("value");
  return (
    <section class="ws-view" aria-label={t("portfolio.title")}>
      <WorkspacePaneHeader title={t("portfolio.title")} onBack={() => ws.back()} />
      <div class="portfolio-view">
        <fieldset class="portfolio-tabs" aria-label={t("portfolio.title")}>
          <For each={TABS}>
            {(entry) => (
              <Button
                variant={tab() === entry.id ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={tab() === entry.id ? "true" : "false"}
                onClick={() => setTab(entry.id)}
              >
                {t(entry.label)}
              </Button>
            )}
          </For>
        </fieldset>
        <Show when={tab() === "value"}>
          <PortfolioValue />
        </Show>
        <Show when={tab() === "quality"}>
          <PortfolioQuality />
        </Show>
        <Show when={tab() === "templates"}>
          <PortfolioTemplates />
        </Show>
        <Show when={tab() === "reality"}>
          <PortfolioReality />
        </Show>
      </div>
    </section>
  );
}

/** A dollar amount of a line that already says USD: cents under 100, whole dollars above, grouped. */
function useUsd(): (value: number) => string {
  const { format } = useText();
  return (value) => {
    const digits = Math.abs(value) >= 100 ? 0 : 2;
    return format.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
}

/** One decimal, as a ratio or a score reads: 6.7, 4.3. */
function useTenths(): (value: number) => string {
  const { format } = useText();
  return (value) => format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function PortfolioValue() {
  const { t, errorMessage } = useText();
  const usd = useUsd();
  const tenths = useTenths();
  const ws = useWorkspace();
  const calls = () => ws.env.portfolio?.();
  const [days, setDays] = createSignal<number>(30);
  const [report, setReport] = createSignal<ValueReport | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [worth, setWorth] = createSignal("");
  const [rating, setRating] = createSignal(4);
  const [agentId, setAgentId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const spaceName = (spaceId: string) => ws.spaces.list().find((space) => space.id === spaceId)?.name ?? spaceId;
  const agentName = (id: string) => ws.env.agents().find((agent) => agent.id === id)?.name ?? id;
  const agents = createMemo(() => (report()?.agents ?? []).filter((row) => ws.spaces.agentInCurrent(row.agentId)));

  async function load(next = days()): Promise<void> {
    const api = calls();
    if (!api) return;
    try {
      setReport(await api.value(next));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, t("portfolio.loadFailed")));
    }
  }
  onSettled(() => void load());

  async function rate(): Promise<void> {
    const api = calls();
    const spaceId = ws.spaces.current();
    if (!api || !title().trim() || busy()) return;
    const value = Number(worth().replace(",", "."));
    setBusy(true);
    try {
      const chosen = agentId();
      setReport(
        await api.rate({
          spaceId,
          ...(chosen ? { agentId: chosen } : {}),
          title: title().trim(),
          rating: rating(),
          ...(worth().trim() && Number.isFinite(value) && value >= 0 ? { valueUsd: value } : {}),
        }),
      );
      setTitle("");
      setWorth("");
    } catch (failure) {
      toast.error(t("portfolio.value.rateFailed"), { error: failure, fallback: t("portfolio.value.rateFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="portfolio-section">
      <div class="portfolio-row">
        <Text tone="muted">{t("portfolio.value.hint")}</Text>
        <fieldset class="portfolio-actions" aria-label={t("portfolio.value.days")}>
          <For each={DAYS}>
            {(count) => (
              <Button
                size="sm"
                variant={days() === count ? "secondary" : "ghost"}
                aria-pressed={days() === count ? "true" : "false"}
                onClick={() => {
                  setDays(count);
                  void load(count);
                }}
              >
                {t("portfolio.value.daysOption", { count })}
              </Button>
            )}
          </For>
        </fieldset>
      </div>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <Show when={report()}>
        {(value) => (
          <>
            <Show when={value().spaces.length > 0}>
              <h3>{t("portfolio.value.spaces")}</h3>
            </Show>
            <div class="portfolio-cards">
              <For each={value().spaces}>
                {(space) => (
                  <article class="portfolio-card">
                    <div class="portfolio-row">
                      <strong>{spaceName(space.spaceId)}</strong>
                      <span class="portfolio-ratio">
                        {space.valuePerDollar === null
                          ? t("portfolio.value.noCost")
                          : t("portfolio.value.perDollar", { ratio: tenths(space.valuePerDollar) })}
                      </span>
                    </div>
                    <Text tone="muted">
                      {t("portfolio.value.spaceLine", {
                        value: usd(space.valueUsd),
                        cost: usd(space.costUsd),
                        revenue: usd(space.revenueUsd),
                        ads: usd(space.adSpendUsd),
                        cards: space.cardsDone,
                      })}
                    </Text>
                  </article>
                )}
              </For>
            </div>
            <h3>{t("portfolio.value.agents")}</h3>
            <Show when={agents().length > 0} fallback={<Text tone="muted">{t("portfolio.value.noAgents")}</Text>}>
              <div class="portfolio-cards">
                <For each={agents()}>
                  {(row) => (
                    <article class="portfolio-card">
                      <div class="portfolio-row">
                        <strong>{agentName(row.agentId)}</strong>
                        <span class="portfolio-ratio">
                          {row.valuePerDollar === null
                            ? t("portfolio.value.noCost")
                            : t("portfolio.value.perDollar", { ratio: tenths(row.valuePerDollar) })}
                        </span>
                      </div>
                      <Text tone="muted">
                        {t("portfolio.value.agentLine", {
                          value: usd(row.valueUsd),
                          cost: usd(row.costUsd),
                          cards: row.cardsDone,
                        })}
                        <Show when={row.rating !== null}>
                          {" · "}
                          {t("portfolio.value.rating", { rating: row.rating === null ? "" : tenths(row.rating) })}
                        </Show>
                      </Text>
                    </article>
                  )}
                </For>
              </div>
            </Show>
            <Show when={value().converted.length > 0}>
              <Text tone="muted">{t("portfolio.value.converted", { currencies: value().converted.join(", ") })}</Text>
            </Show>
          </>
        )}
      </Show>
      <h3>{t("portfolio.value.rateTitle")}</h3>
      <Text tone="muted">{t("portfolio.value.rateHint")}</Text>
      <div class="portfolio-form">
        <label>
          <Text tone="muted">{t("portfolio.value.outcome")}</Text>
          <Input value={title()} onValueChange={setTitle} placeholder={t("portfolio.value.outcomePlaceholder")} />
        </label>
        <fieldset class="portfolio-actions" aria-label={t("portfolio.value.stars")}>
          <For each={[1, 2, 3, 4, 5]}>
            {(stars) => (
              <Button
                size="sm"
                variant={rating() === stars ? "secondary" : "ghost"}
                aria-pressed={rating() === stars ? "true" : "false"}
                onClick={() => setRating(stars)}
              >
                {t("portfolio.value.starsOption", { count: stars })}
              </Button>
            )}
          </For>
        </fieldset>
        <label>
          <Text tone="muted">{t("portfolio.value.worth")}</Text>
          <Input value={worth()} inputmode="decimal" onValueChange={setWorth} placeholder="0" />
        </label>
        <fieldset class="portfolio-actions" aria-label={t("portfolio.value.who")}>
          <Button
            size="sm"
            variant={agentId() === null ? "secondary" : "ghost"}
            aria-pressed={agentId() === null ? "true" : "false"}
            onClick={() => setAgentId(null)}
          >
            {t("portfolio.value.wholeSpace")}
          </Button>
          <For each={ws.env.agents().filter((agent) => ws.spaces.agentInCurrent(agent.id))}>
            {(agent) => (
              <Button
                size="sm"
                variant={agentId() === agent.id ? "secondary" : "ghost"}
                aria-pressed={agentId() === agent.id ? "true" : "false"}
                onClick={() => setAgentId(agent.id)}
              >
                {agent.name}
              </Button>
            )}
          </For>
        </fieldset>
        <div class="portfolio-actions">
          <Button disabled={busy() || !title().trim()} onClick={() => void rate()}>
            {t("portfolio.value.rate")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PortfolioReality() {
  const { t, format, errorMessage } = useText();
  const ws = useWorkspace();
  const calls = () => ws.env.portfolio?.();
  const [page, setPage] = createSignal<RealityPage | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const reports = createMemo(() => (page()?.reports ?? []).filter((report) => report.spaceId === ws.spaces.current()));

  async function load(settings?: RealityPage["settings"]): Promise<void> {
    const api = calls();
    if (!api) return;
    try {
      setPage(await api.reality(settings ? { settings } : {}));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, t("portfolio.loadFailed")));
    }
  }
  onSettled(() => void load());

  async function runNow(): Promise<void> {
    const api = calls();
    if (!api || busy()) return;
    setBusy(true);
    try {
      const report = await api.runReality(ws.spaces.current());
      setPage((current) => (current ? { ...current, reports: [report, ...current.reports] } : current));
    } catch (failure) {
      toast.error(t("portfolio.reality.runFailed"), { error: failure, fallback: t("portfolio.reality.runFailed") });
    } finally {
      setBusy(false);
    }
  }

  const change = (next: Partial<RealityPage["settings"]>) => {
    const current = page()?.settings;
    if (current) void load({ ...current, ...next });
  };

  return (
    <div class="portfolio-section">
      <Text tone="muted">{t("portfolio.reality.hint")}</Text>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <Show when={page()?.settings}>
        {(settings) => (
          <>
            <SwitchField
              label={t("portfolio.reality.weekly")}
              description={t("portfolio.reality.weeklyHint", {
                day: t(WEEKDAYS[settings().weekday] ?? WEEKDAYS[1]),
                hour: String(settings().hour).padStart(2, "0"),
              })}
              checked={settings().enabled}
              onChange={(enabled) => change({ enabled })}
            />
            <fieldset class="portfolio-actions" aria-label={t("portfolio.reality.dayLabel")}>
              <For each={WEEKDAYS}>
                {(label, index) => (
                  <Button
                    size="sm"
                    variant={settings().weekday === index() ? "secondary" : "ghost"}
                    aria-pressed={settings().weekday === index() ? "true" : "false"}
                    onClick={() => change({ weekday: index() })}
                  >
                    {t(label)}
                  </Button>
                )}
              </For>
            </fieldset>
          </>
        )}
      </Show>
      <div class="portfolio-actions">
        <Button disabled={busy()} onClick={() => void runNow()}>
          {busy() ? t("portfolio.reality.running") : t("portfolio.reality.run")}
        </Button>
      </div>
      <Show when={page() !== null && reports().length === 0}>
        <Text tone="muted">{t("portfolio.reality.empty")}</Text>
      </Show>
      <div class="portfolio-cards">
        <For each={reports()}>
          {(report) => (
            <article class="portfolio-card">
              <div class="portfolio-row">
                <strong>{format.date(Date.parse(report.at), { dateStyle: "medium" })}</strong>
                <span class="portfolio-ratio" data-flagged={report.flagged > 0 ? "" : undefined}>
                  {t("portfolio.reality.flagged", { count: report.flagged })}
                </span>
              </div>
              <p class="portfolio-summary">{report.summary}</p>
              <ul class="portfolio-claims">
                <For each={report.claims}>
                  {(claim) => (
                    <li data-evidence={claim.evidence}>
                      <span class="portfolio-evidence">{t(EVIDENCE[claim.evidence])}</span>
                      <span>{claim.text}</span>
                      <Text tone="muted">{claim.detail}</Text>
                    </li>
                  )}
                </For>
              </ul>
            </article>
          )}
        </For>
      </div>
    </div>
  );
}
