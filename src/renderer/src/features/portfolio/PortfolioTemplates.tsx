import {
  parseSpaceTemplate,
  type SpaceTemplateSummary,
  type TemplateImport,
  type TemplateImportState,
} from "@openbot/contracts/portfolio";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Input, Text, Textarea, toast } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, onSettled, Show } from "solid-js";
import { downloadText } from "../trust/trust-draft";
import { useWorkspace } from "../workspace/workspace-context";

const STATE_TEXT = {
  validating: "portfolio.templates.state.validating",
  ready: "portfolio.templates.state.ready",
  building: "portfolio.templates.state.building",
  stopped: "portfolio.templates.state.stopped",
} as const satisfies Record<TemplateImportState, AppTextKey>;

const VERDICT_TEXT = {
  go: "portfolio.templates.verdict.go",
  test: "portfolio.templates.verdict.test",
  stop: "portfolio.templates.verdict.stop",
} as const satisfies Record<NonNullable<TemplateImport["validation"]>["verdict"], AppTextKey>;

/** How often the tab asks the host again while a validation runs: the research agent takes minutes. */
const VALIDATION_POLL_MS = 15_000;

/**
 * The Templates tab: a new space from a starter template or a template file, the export of the space
 * that shows, and each import with its validation stage, Start building and Stop.
 */
export function PortfolioTemplates() {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const calls = () => ws.env.portfolio?.();
  const [starters, setStarters] = createSignal<SpaceTemplateSummary[]>([]);
  const [imports, setImports] = createSignal<TemplateImport[]>([]);
  const [name, setName] = createSignal("");
  const [file, setFile] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function load(): Promise<void> {
    const api = calls();
    if (!api) return;
    try {
      const page = await api.templates();
      setStarters(page.starters);
      setImports(page.imports);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, t("portfolio.loadFailed")));
    }
  }
  onSettled(() => {
    void load();
    // The host scores an import after the answer that made it, so the tab asks until none waits.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && imports().some((entry) => entry.state === "validating"))
        void load();
    }, VALIDATION_POLL_MS);
    return () => clearInterval(timer);
  });

  /** Whether the host made the change. A failure shows as a toast. */
  async function act(run: () => Promise<TemplateImport>, failed: AppTextKey): Promise<boolean> {
    if (busy()) return false;
    setBusy(true);
    try {
      const record = await run();
      setImports((list) => [record, ...list.filter((entry) => entry.id !== record.id)]);
      void ws.spaces.refresh();
      return true;
    } catch (failure) {
      toast.error(t(failed), { error: failure, fallback: t(failed) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  // The name is of one new space: a made space clears it, so the next one does not take it too.
  const fromStarter = (starterId: string) =>
    act(
      () =>
        calls()?.importTemplate({ starterId, ...(name().trim() ? { name: name().trim() } : {}) }) ??
        Promise.reject(new Error("unsupported")),
      "portfolio.templates.importFailed",
    ).then((done) => {
      if (done) setName("");
    });

  function fromFile(): void {
    let template: ReturnType<typeof parseSpaceTemplate>;
    try {
      template = parseSpaceTemplate(JSON.parse(file()));
    } catch {
      toast.error(t("portfolio.templates.fileInvalid"));
      return;
    }
    void act(
      () =>
        calls()?.importTemplate({ template, ...(name().trim() ? { name: name().trim() } : {}) }) ??
        Promise.reject(new Error("unsupported")),
      "portfolio.templates.importFailed",
    ).then((done) => {
      // A failed import keeps the pasted text, so the owner can try again.
      if (!done) return;
      setFile("");
      setName("");
    });
  }

  async function exportSpace(): Promise<void> {
    const api = calls();
    if (!api || busy()) return;
    setBusy(true);
    try {
      const template = await api.exportTemplate(ws.spaces.current());
      // downloadText keeps the file's address a moment after the click, which Safari reads late.
      downloadText(
        `${template.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "space"}.atelier-template.json`,
        JSON.stringify(template, null, 2),
        "application/json",
      );
      toast.success(t("portfolio.templates.exported"));
    } catch (failure) {
      toast.error(t("portfolio.templates.exportFailed"), {
        error: failure,
        fallback: t("portfolio.templates.exportFailed"),
      });
    } finally {
      setBusy(false);
    }
  }

  const spaceName = (spaceId: string) => ws.spaces.space(spaceId)?.name ?? spaceId;

  return (
    <div class="portfolio-section">
      <Text tone="muted">{t("portfolio.templates.hint")}</Text>
      <Show when={error()}>{(message) => <Text role="alert">{message()}</Text>}</Show>
      <label>
        <Text tone="muted">{t("portfolio.templates.name")}</Text>
        <Input value={name()} onValueChange={setName} placeholder={t("portfolio.templates.namePlaceholder")} />
      </label>
      <div class="portfolio-cards">
        <For each={starters()}>
          {(starter) => (
            <article class="portfolio-card">
              <div class="portfolio-row">
                <strong>
                  {starter.icon ? `${starter.icon} ` : ""}
                  {starter.name}
                </strong>
                <span class="portfolio-ratio">{t("portfolio.templates.agents", { count: starter.agents })}</span>
              </div>
              <Text tone="muted">{starter.description}</Text>
              <div class="portfolio-actions">
                <Button size="sm" disabled={busy()} onClick={() => void fromStarter(starter.id)}>
                  {t("portfolio.templates.create")}
                </Button>
              </div>
            </article>
          )}
        </For>
      </div>
      <h3>{t("portfolio.templates.fileTitle")}</h3>
      <Textarea
        rows={4}
        value={file()}
        placeholder={t("portfolio.templates.filePlaceholder")}
        onValueChange={setFile}
      />
      <div class="portfolio-actions">
        <Button size="sm" variant="secondary" disabled={busy() || !file().trim()} onClick={fromFile}>
          {t("portfolio.templates.import")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void exportSpace()}>
          {t("portfolio.templates.export", { space: spaceName(ws.spaces.current()) })}
        </Button>
      </div>
      <Show when={imports().length > 0}>
        <h3>{t("portfolio.templates.imports")}</h3>
        <div class="portfolio-cards">
          <For each={imports()}>
            {(record) => (
              <article class="portfolio-card">
                <div class="portfolio-row">
                  <strong>{spaceName(record.spaceId)}</strong>
                  <span class="portfolio-ratio">{t(STATE_TEXT[record.state])}</span>
                </div>
                <Text tone="muted">{t("portfolio.templates.from", { template: record.templateName })}</Text>
                <Show
                  when={record.validation}
                  fallback={
                    <Show when={record.state === "validating"}>
                      <Text tone="muted">{t("portfolio.templates.validating")}</Text>
                    </Show>
                  }
                >
                  {(validation) => (
                    <div class="portfolio-validation">
                      <strong>
                        {t("portfolio.templates.score", { score: validation().score })} ·{" "}
                        {t(VERDICT_TEXT[validation().verdict])}
                      </strong>
                      <p class="portfolio-summary">{validation().summary}</p>
                      <Show when={validation().demand}>
                        <Text tone="muted">{t("portfolio.templates.demand", { text: validation().demand })}</Text>
                      </Show>
                      <Show when={validation().competition}>
                        <Text tone="muted">
                          {t("portfolio.templates.competition", { text: validation().competition })}
                        </Text>
                      </Show>
                      <Show when={validation().risks}>
                        <Text tone="muted">{t("portfolio.templates.risks", { text: validation().risks })}</Text>
                      </Show>
                    </div>
                  )}
                </Show>
                <For each={record.notes}>{(note) => <Text tone="warning">{note}</Text>}</For>
                <Show when={record.state === "ready" || record.state === "validating"}>
                  <div class="portfolio-actions">
                    <Button
                      size="sm"
                      disabled={busy()}
                      onClick={() =>
                        void act(
                          () => calls()?.decideImport(record.id, "build") ?? Promise.reject(new Error("unsupported")),
                          "portfolio.templates.decideFailed",
                        )
                      }
                    >
                      {t("portfolio.templates.build")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() =>
                        void act(
                          () => calls()?.decideImport(record.id, "stop") ?? Promise.reject(new Error("unsupported")),
                          "portfolio.templates.decideFailed",
                        )
                      }
                    >
                      {t("portfolio.templates.stop")}
                    </Button>
                  </div>
                </Show>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
