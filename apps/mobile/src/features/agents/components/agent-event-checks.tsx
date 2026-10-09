import { Host, Switch } from "@expo/ui";
import type { EventCheck, EventCheckExecution } from "@openbot/contracts/event-checks";
import type { MobileTextKey } from "@openbot/i18n/mobile";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { Typography } from "heroui-native";
import { useState } from "react";
import { useUniwind } from "uniwind";
import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { type MobileAgent, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { haptics } from "@/shared/lib/haptics";
import { currentText, useText } from "@/shared/lib/text";

const STATUS_TEXT = {
  baseline: "mobile.agent.eventCheck.status.baseline",
  unchanged: "mobile.agent.eventCheck.status.unchanged",
  triggered: "mobile.agent.eventCheck.status.triggered",
  error: "mobile.agent.eventCheck.status.error",
  cancelled: "mobile.agent.eventCheck.status.cancelled",
} as const satisfies Record<EventCheckExecution["status"], MobileTextKey>;

/**
 * Agent info > Event checks. An owner or admin pauses or resumes a check, runs it now, and sees how
 * its last check ended. Settings, programs and private variables stay on the computer.
 */
export function AgentEventChecks({
  agent,
  checks,
  queryKey,
}: {
  agent: MobileAgent;
  checks: EventCheck[];
  /** The query that holds `checks`. A saved change is written to it, so the list shows the host result. */
  queryKey: QueryKey;
}) {
  const { t, format, sourceText } = useText();
  const { theme } = useUniwind();
  const workspace = useMobileWorkspace();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function replace(next: EventCheck) {
    queryClient.setQueryData<EventCheck[] | undefined>(queryKey, (list) =>
      list?.map((item) => (item.id === next.id ? next : item)),
    );
  }

  function run(check: EventCheck, send: () => Promise<void>, failure: string, onFailure?: () => void) {
    setError(null);
    setBusy((current) => new Set(current).add(check.id));
    send()
      .then(() => void haptics.notification("success"))
      .catch((cause: unknown) => {
        void haptics.notification("error");
        onFailure?.();
        setError(currentText().errorMessage(cause, failure));
      })
      .finally(() =>
        setBusy((current) => {
          const next = new Set(current);
          next.delete(check.id);
          return next;
        }),
      );
  }

  function setActive(check: EventCheck, active: boolean) {
    void haptics.selection();
    // The switch moves at once. A read that started earlier must not put the old state back.
    void queryClient.cancelQueries({ queryKey, exact: true });
    replace({ ...check, active });
    run(
      check,
      async () => {
        const saved = await workspace.setEventCheckActive(check, active, agent.serverId);
        // The save answer has no health, so the row keeps the one it had.
        replace({ ...saved, ...(check.health ? { health: check.health } : {}) });
      },
      currentText().t("mobile.agent.eventCheck.toggleFailed", { name: check.name }),
      () => replace(check),
    );
  }

  function checkNow(check: EventCheck) {
    void haptics.impact("light");
    run(
      check,
      async () => {
        await workspace.runEventCheck(agent.id, check.id, agent.serverId);
        await queryClient.invalidateQueries({ queryKey, exact: true });
      },
      currentText().t("mobile.agent.eventCheck.checkFailed", { name: check.name }),
    );
  }

  function summary(check: EventCheck): string {
    const health = check.health;
    if ((health?.consecutiveErrors ?? 0) > 0)
      return t("mobile.agent.eventCheck.failing", {
        error: health?.lastError ? sourceText(health.lastError) : t("mobile.agent.eventCheck.noReason"),
      });
    if (!health?.lastStatus || !health.lastCheckedAt) return t("mobile.agent.eventCheck.neverChecked");
    return t("mobile.agent.eventCheck.lastCheck", {
      time: format.date(new Date(health.lastCheckedAt), { dateStyle: "medium", timeStyle: "short" }),
      status: t(STATUS_TEXT[health.lastStatus]),
    });
  }

  if (!checks.length)
    return (
      <SettingsSection>
        <SettingsRow>
          <Typography.Paragraph className="text-grouped-secondary">
            {t("mobile.agent.info.noEventChecks")}
          </Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
    );
  return (
    <>
      {checks.map((check) => (
        <SettingsSection key={check.id}>
          <SettingsRow supportingText={summary(check)}>
            <Host
              matchContents={{ vertical: true }}
              style={{ width: "100%" }}
              colorScheme={theme === "dark" ? "dark" : "light"}
            >
              <Switch
                label={check.name}
                value={check.active}
                disabled={busy.has(check.id)}
                onValueChange={(active) => setActive(check, active)}
              />
            </Host>
          </SettingsRow>
          <SettingsRow
            disclosure={false}
            disabled={busy.has(check.id) || !check.active}
            accessibilityLabel={t("mobile.agent.eventCheck.checkNowNamed", { name: check.name })}
            onPress={() => checkNow(check)}
          >
            <Typography.Paragraph>
              {t(busy.has(check.id) ? "mobile.agent.eventCheck.checking" : "mobile.agent.eventCheck.checkNow")}
            </Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ))}
      {error ? (
        <Typography.Paragraph accessibilityRole="alert" className="px-4 text-danger-text">
          {error}
        </Typography.Paragraph>
      ) : null}
    </>
  );
}
