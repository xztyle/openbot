import { router, useLocalSearchParams } from "expo-router";
import { Typography } from "heroui-native";
import { useState } from "react";
import { TrailingValue } from "@/features/servers/components/trailing-value";
import { type ProviderRow, providerRows, providerStatusText } from "@/features/servers/model/provider-admin";
import { useServerProviders } from "@/features/servers/model/use-server-providers";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import { haptics } from "@/shared/lib/haptics";
import { currentText, type MobileText, useText } from "@/shared/lib/text";

/** The status of a row, as the desktop Providers tab shows it. */
export function providerStatusLabel(row: ProviderRow, { t, format }: Pick<MobileText, "t" | "format">): string {
  const text = providerStatusText(row);
  return "percent" in text ? format.percent(Math.round(text.percent * 100) / 100) : t(text.key);
}

/**
 * Server settings > Providers: the AI providers of the computer that runs the server, for an owner or
 * admin of a host that serves `providers-v1`. A tap opens the provider, where it signs in, downloads
 * or updates on the host.
 */
export function ServerProvidersScreen() {
  const text = useText();
  const { t, errorMessage } = text;
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { available, admin, status, runtimes, rows, applyRuntimes } = useServerProviders(serverId);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  if (!available || !status.data)
    return (
      <SettingsContent>
        <SettingsNote>
          {!available
            ? t("mobile.server.providers.unavailable")
            : status.isError
              ? errorMessage(status.error, t("mobile.server.providers.loadFailed"))
              : t("mobile.server.providers.loading")}
        </SettingsNote>
      </SettingsContent>
    );
  return (
    <SettingsContent>
      <SettingsSection
        footer={
          runtimes.isError
            ? errorMessage(runtimes.error, t("mobile.server.providers.runtimesFailed"))
            : t("mobile.server.providers.description")
        }
      >
        {rows.map((row) => (
          <SettingsRow
            key={row.id}
            supportingText={row.status?.email ?? undefined}
            trailing={<TrailingValue value={providerStatusLabel(row, text)} />}
            onPress={() =>
              router.push({ pathname: "/server-settings/provider", params: { serverId, provider: row.id } })
            }
          >
            <Typography.Paragraph numberOfLines={1}>{row.name}</Typography.Paragraph>
          </SettingsRow>
        ))}
      </SettingsSection>
      {/* Only a host that downloads runtimes has updates to check. */}
      {runtimes.data && admin ? (
        <SettingsSection footer={checkResult ?? undefined}>
          <SettingsRow
            disclosure={false}
            disabled={checking}
            onPress={() => {
              setChecking(true);
              setCheckResult(null);
              admin
                .checkUpdates()
                .then(async (snapshot) => {
                  await applyRuntimes(snapshot);
                  const found = providerRows(status.data, snapshot, admin.capabilities).filter((row) => row.updatable);
                  setCheckResult(
                    found.length > 0
                      ? currentText().t("mobile.server.providers.updatesFound", {
                          names: currentText().format.list(found.map((row) => row.name)),
                        })
                      : currentText().t("mobile.server.providers.allUpToDate"),
                  );
                  void haptics.notification("success");
                })
                .catch((cause: unknown) => {
                  setCheckResult(errorMessage(cause, t("mobile.server.providers.checkFailed")));
                  void haptics.notification("error");
                })
                .finally(() => setChecking(false));
            }}
          >
            <Typography.Paragraph className="text-accent">
              {t(checking ? "mobile.server.providers.checking" : "mobile.server.providers.checkUpdates")}
            </Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ) : null}
    </SettingsContent>
  );
}
