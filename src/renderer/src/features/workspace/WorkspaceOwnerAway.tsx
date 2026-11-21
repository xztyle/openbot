/*
 * The owner's away time in the workspace: the "When you're back" list at the top of Activity, the
 * status of quiet hours or focus with the focus menu, the focus button of the top bar, and the quiet
 * hours settings. Everything comes from `ws.env.ownerAway`, which only the web client of the owner or
 * an admin has.
 */
import type { OwnerAwaySettings } from "@openbot/contracts/team-protocol/owner-away-v1";
import { Field, FormDialog, Input, NativeSelect, SwitchField, toast } from "@openbot/ui";
import {
  type AwayQuiet,
  FocusMenu,
  type WhenBackAnswer,
  type WhenBackRow,
  WhenBackSection,
} from "@openbot/ui/features/workspace/WhenBack";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, Show } from "solid-js";
import { nextClockTime } from "./owner-away-store";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

function clock(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

/** The focus actions and the settings dialog, for one place that shows the focus menu. */
function useAwayControls() {
  const ws = useWorkspace();
  const { t } = useText();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const store = () => ws.env.ownerAway;
  const quiet = createMemo((): AwayQuiet | null => {
    const value = store()?.state()?.quiet;
    return value ? { kind: value.kind, until: clock(value.until) } : null;
  });
  const onFocus = (choice: number | "tomorrow" | null) => {
    const away = store();
    const state = away?.state();
    if (!away || !state) return;
    const until =
      choice === null
        ? null
        : choice === "tomorrow"
          ? nextClockTime(state.settings.quietHours.end)
          : Date.now() + choice * 60_000;
    void away.setFocus(until).catch(() => toast.error(t("workspace.away.focusFailed")));
  };
  return {
    supported: () => store()?.supported() ?? false,
    quiet,
    onFocus,
    openSettings: () => setSettingsOpen(true),
    dialog: () => (
      <Show when={settingsOpen() && store()?.state()}>
        {(state) => (
          <OwnerAwaySettingsDialog
            settings={state().settings}
            systemTimezone={state().systemTimezone}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </Show>
    ),
  };
}

/** The focus button of the top bar, on a computer. */
export function WorkspaceFocusButton() {
  const controls = useAwayControls();
  return (
    <Show when={controls.supported()}>
      <FocusMenu quiet={controls.quiet()} onFocus={controls.onFocus} onSettings={controls.openSettings} />
      {controls.dialog()}
    </Show>
  );
}

/** "When you're back" at the top of Activity, with the status of quiet hours and focus. */
export function WorkspaceWhenBackSection() {
  const ws = useWorkspace();
  const { t } = useText();
  const controls = useAwayControls();
  const rows = createMemo((): WhenBackRow[] => {
    const held = ws.env.ownerAway?.state()?.held ?? [];
    return held
      .filter((item) =>
        item.channelId ? ws.spaces.channelInCurrent(item.channelId) : ws.spaces.agentInCurrent(item.agentId),
      )
      .map((item) => {
        const agent = ws.env.agents().find((candidate) => candidate.id === item.agentId);
        const channel = item.channelId ? ws.summary(item.channelId) : undefined;
        return {
          key: item.id,
          member: memberById(ws.directory(), item.agentId, agent?.name ?? t("chat.message.agentFallback")),
          kind: item.kind,
          title: item.title,
          detail: item.detail,
          options: item.options,
          url: item.url,
          where: channel ? t("workspace.activity.in", { channel: channel.name }) : undefined,
          at: item.createdAt,
        };
      });
  });
  const answer = async (key: string, value: WhenBackAnswer) => {
    const away = ws.env.ownerAway;
    if (!away) return;
    const row = rows().find((candidate) => candidate.key === key);
    try {
      await away.answer({ id: key, ...value });
      if (row && value.decision !== "dismiss") toast.success(t("workspace.away.answered", { name: row.member.name }));
    } catch {
      toast.error(t("workspace.away.answerFailed"));
      away.refresh();
    }
  };
  return (
    <Show when={controls.supported()}>
      <WhenBackSection
        rows={rows()}
        onAnswer={answer}
        onOpenLink={(url) => {
          if (!ws.openLink(url)) void ws.channels.port().openUrl(url);
        }}
        status={
          // A phone has no top bar, so its Activity always has the focus menu.
          controls.quiet() || ws.env.phone() ? (
            <div class="ws-when-back-status">
              <FocusMenu
                labeled
                quiet={controls.quiet()}
                onFocus={controls.onFocus}
                onSettings={controls.openSettings}
              />
              <Show when={controls.quiet()}>
                <span>{t("workspace.away.quietNote")}</span>
              </Show>
            </div>
          ) : undefined
        }
      />
      {controls.dialog()}
    </Show>
  );
}

function zones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function OwnerAwaySettingsDialog(props: { settings: OwnerAwaySettings; systemTimezone: string; onClose: () => void }) {
  const ws = useWorkspace();
  const { t } = useText();
  const [enabled, setEnabled] = createSignal(props.settings.quietHours.enabled);
  const [start, setStart] = createSignal(props.settings.quietHours.start);
  const [end, setEnd] = createSignal(props.settings.quietHours.end);
  const [zone, setZone] = createSignal(props.settings.quietHours.timeZone ?? "");
  const [money, setMoney] = createSignal(String(props.settings.urgentMoneyUsd));
  const [deliverAt, setDeliverAt] = createSignal(props.settings.heldDeliverAt ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const valid = () =>
    /^\d{2}:\d{2}$/u.test(start()) &&
    /^\d{2}:\d{2}$/u.test(end()) &&
    (deliverAt() === "" || /^\d{2}:\d{2}$/u.test(deliverAt())) &&
    /^\d{1,7}$/u.test(money().trim());
  const submit = () => {
    const away = ws.env.ownerAway;
    if (!away || !valid() || busy()) return;
    setBusy(true);
    setError(null);
    away
      .saveSettings({
        quietHours: { enabled: enabled(), start: start(), end: end(), timeZone: zone() || null },
        urgentMoneyUsd: Number(money().trim()),
        heldDeliverAt: deliverAt() || null,
      })
      .then(
        () => props.onClose(),
        () => setError(t("workspace.away.saveFailed")),
      )
      .finally(() => setBusy(false));
  };
  return (
    <FormDialog
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("workspace.away.settingsTitle")}
      description={t("workspace.away.settingsDescription")}
      submitLabel={t("workspace.away.save")}
      submitDisabled={!valid()}
      busy={busy()}
      error={error()}
      onSubmit={submit}
    >
      <SwitchField
        checked={enabled()}
        onChange={setEnabled}
        label={t("workspace.away.quietOn")}
        description={t("workspace.away.quietOnDescription")}
      />
      <div class="ws-away-times">
        <Field label={t("workspace.away.start")}>
          <Input
            type="time"
            value={start()}
            disabled={!enabled()}
            onInput={(event) => setStart(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("workspace.away.end")}>
          <Input
            type="time"
            value={end()}
            disabled={!enabled()}
            onInput={(event) => setEnd(event.currentTarget.value)}
          />
        </Field>
      </div>
      <Field label={t("workspace.away.zone")}>
        <NativeSelect value={zone()} onChange={(event) => setZone(event.currentTarget.value)}>
          <option value="">{t("workspace.away.zoneServer", { zone: props.systemTimezone })}</option>
          {zones().map((name) => (
            <option value={name}>{name}</option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("workspace.away.money")}>
        <Input
          type="number"
          inputmode="numeric"
          min="0"
          max="1000000"
          value={money()}
          onInput={(event) => setMoney(event.currentTarget.value)}
        />
      </Field>
      <Field label={t("workspace.away.deliverAt")} description={t("workspace.away.deliverAtDescription")}>
        <Input type="time" value={deliverAt()} onInput={(event) => setDeliverAt(event.currentTarget.value)} />
      </Field>
    </FormDialog>
  );
}
