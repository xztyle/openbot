import {
  STORAGE_HYGIENE_SETTING_RANGES,
  type StorageHygieneSettings,
  type StorageHygieneWebpTool,
} from "@openbot/contracts/ipc";
import {
  Alert,
  AlertContent,
  AlertDescription,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  SliderField,
  Switch,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import type { StorageHygieneCalls } from "./storage-hygiene-port";

type NumericSetting = keyof typeof STORAGE_HYGIENE_SETTING_RANGES;
type FlagSetting = "autoPrune" | "evidenceConvert" | "evidenceDelete";

/**
 * Server settings > Storage > Cleanup rules: the automatic rules (off by default) and the
 * thresholds of the cleanup plan. Owners and admins only. Changes wait for Save.
 */
export function StorageHygieneRules(props: { calls: StorageHygieneCalls }): JSX.Element {
  const { t } = useText();
  const [saved, setSaved] = createSignal<StorageHygieneSettings | null>(null);
  const [draft, setDraft] = createSignal<StorageHygieneSettings | null>(null);
  const [webpTool, setWebpTool] = createSignal<StorageHygieneWebpTool | null | undefined>(undefined);
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved" | "load-failed" | "save-failed">("idle");
  const dirty = () => {
    const current = draft();
    const base = saved();
    return Boolean(current && base && JSON.stringify(current) !== JSON.stringify(base));
  };

  onSettled(() => {
    let current = true;
    props.calls
      .getSettings()
      .then((settings) => {
        if (!current) return;
        setSaved(settings);
        setDraft(settings);
      })
      .catch(() => {
        if (current) setStatus("load-failed");
      });
    // Only to say whether the WebP rule can convert; no scan starts.
    props.calls
      .getState({})
      .then((state) => {
        if (current) setWebpTool(state?.webpTool ?? null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  });

  function update<Key extends keyof StorageHygieneSettings>(key: Key, value: StorageHygieneSettings[Key]) {
    const current = draft();
    if (!current) return;
    setDraft({ ...current, [key]: value });
    setStatus("idle");
  }

  async function save(): Promise<void> {
    const current = draft();
    if (!current) return;
    setStatus("saving");
    try {
      const next = await props.calls.setSettings(current);
      setSaved(next);
      setDraft(next);
      setStatus("saved");
    } catch {
      setStatus("save-failed");
    }
  }

  const busy = () => status() === "saving";

  function Toggle(toggle: { key: FlagSetting; title: string; description: JSX.Element; children?: JSX.Element }) {
    return (
      <Item>
        <ItemContent>
          <ItemTitle>{toggle.title}</ItemTitle>
          <ItemDescription>{toggle.description}</ItemDescription>
          <Show when={draft()?.[toggle.key]}>{toggle.children}</Show>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label={toggle.title}
            checked={draft()?.[toggle.key] ?? false}
            disabled={busy() || !draft()}
            onChange={(on: boolean) => update(toggle.key, on)}
          />
        </ItemActions>
      </Item>
    );
  }

  function Slider(slider: { key: NumericSetting; label: string; value: (count: number) => string }) {
    const [minimum, maximum] = STORAGE_HYGIENE_SETTING_RANGES[slider.key];
    return (
      <SliderField
        label={slider.label}
        value={draft()?.[slider.key] ?? minimum}
        minValue={minimum}
        maxValue={maximum}
        step={1}
        disabled={busy() || !draft()}
        formatValue={slider.value}
        onChange={(value) => update(slider.key, Math.round(value))}
      />
    );
  }

  const hours = (count: number) => t("storageHygiene.settings.hoursValue", { count });
  const days = (count: number) => t("storageHygiene.settings.daysValue", { count });

  return (
    <SettingsSection
      class="storage-hygiene-rules"
      title={t("storageHygiene.settings.title")}
      description={t("storageHygiene.settings.description")}
      actions={
        <Show when={dirty() || status() === "saving"}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy()}
            onClick={() => {
              setDraft(saved());
              setStatus("idle");
            }}
          >
            {t("storageHygiene.settings.reset")}
          </Button>
          <Button type="button" size="sm" disabled={busy() || !dirty()} onClick={() => void save()}>
            {t("storageHygiene.settings.save")}
          </Button>
        </Show>
      }
    >
      <Show when={status() === "load-failed" || status() === "save-failed"}>
        <Alert tone="danger" role="alert">
          <AlertContent>
            <AlertDescription>
              {status() === "load-failed"
                ? t("storageHygiene.settings.loadFailed")
                : t("storageHygiene.settings.saveFailed")}
            </AlertDescription>
          </AlertContent>
        </Alert>
      </Show>
      <Show when={status() === "saved" && !dirty()}>
        <p class="storage-hygiene-saved" role="status">
          {t("storageHygiene.settings.saved")}
        </p>
      </Show>
      <ItemGroup class="settings-modal-card">
        <Toggle
          key="autoPrune"
          title={t("storageHygiene.settings.autoPrune")}
          description={t("storageHygiene.settings.autoPruneDescription")}
        >
          <Slider
            key="autoPruneDiskPercent"
            label={t("storageHygiene.settings.diskPercent")}
            value={(value) => t("storageHygiene.settings.percentValue", { value })}
          />
          <Slider key="autoPruneIdleHours" label={t("storageHygiene.settings.idleHours")} value={hours} />
        </Toggle>
        <Toggle
          key="evidenceConvert"
          title={t("storageHygiene.settings.evidenceConvert")}
          description={
            <>
              {t("storageHygiene.settings.evidenceConvertDescription")}
              <Show when={webpTool() === null}> {t("storageHygiene.settings.evidenceConvertMissing")}</Show>
            </>
          }
        >
          <Slider key="evidenceConvertAfterDays" label={t("storageHygiene.settings.convertDays")} value={days} />
        </Toggle>
        <Toggle
          key="evidenceDelete"
          title={t("storageHygiene.settings.evidenceDelete")}
          description={t("storageHygiene.settings.evidenceDeleteDescription")}
        >
          <Slider key="evidenceDeleteAfterDays" label={t("storageHygiene.settings.deleteDays")} value={days} />
        </Toggle>
        <Item>
          <ItemContent>
            <ItemTitle>{t("storageHygiene.settings.thresholds")}</ItemTitle>
            <Slider key="staleIdleHours" label={t("storageHygiene.settings.staleHours")} value={hours} />
            <Slider
              key="recentMinutes"
              label={t("storageHygiene.settings.recentMinutes")}
              value={(count) => t("storageHygiene.settings.minutesValue", { count })}
            />
          </ItemContent>
        </Item>
      </ItemGroup>
    </SettingsSection>
  );
}
