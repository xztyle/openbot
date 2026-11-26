import { parseTrustApprovalCard } from "@openbot/contracts/agent-approvals";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import Folder from "lucide-react-native/icons/folder";
import ShieldAlert from "lucide-react-native/icons/shield-alert";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { showWarningAlert } from "@/features/analytics/failure-reports";
import {
  approvalIsPartial,
  InactiveRequestError,
  type PendingApproval,
} from "@/features/workspace/model/pending-approvals";
import { haptics } from "@/shared/lib/haptics";
import { type MobileText, useText } from "@/shared/lib/text";

export type ApprovalDecision = "accept" | "decline";

/**
 * A command that only wraps its body in a login shell, such as `/bin/zsh -lc "…"`. The body shows
 * only when the shell reads it literally: single quotes, or double quotes with no escape, variable or
 * substitution. Any other command shows as the host sent it.
 */
const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c (?:'([^']*)'|"([^"\\$`]*)")$/su;
const HOME_FOLDER = /^(?:\/Users|\/home)\/[^/]+(?=\/|$)/u;

export function approvalTitle(approval: PendingApproval, t: MobileText["t"]): string {
  if (approval.kind === "permissions" && parseTrustApprovalCard(approval.command))
    return t("mobile.chat.approval.title.trust");
  if (approval.kind === "command") return t("mobile.chat.approval.title.command");
  if (approval.kind === "file-change") return t("mobile.chat.approval.title.fileChange");
  return t("mobile.chat.approval.title.permissions");
}

function commandText(command: string) {
  const match = SHELL_WRAPPER.exec(command);
  return match?.[1] ?? match?.[2] ?? command;
}

function shortPath(path: string) {
  return path.replace(HOME_FOLDER, "~");
}

/**
 * An approval that an agent waits on, answered from the phone. It shows what the desktop card shows
 * and says what each answer does on the host. A request that the phone has only in part offers Deny
 * only: Allow must not cover text the user cannot see.
 */
export function ChatApprovalCard({
  approval,
  agentName,
  showAgentName,
  serverName,
  canAnswer,
  respond,
}: {
  approval: PendingApproval;
  agentName: string;
  /** In a channel, several agents can ask. In an agent's own chat, the name is the chat's. */
  showAgentName: boolean;
  serverName: string;
  canAnswer: boolean;
  respond: (decision: ApprovalDecision) => Promise<void>;
}) {
  const { t, errorMessage, sourceText } = useText();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const [warningText] = useCSSVariable(["--openbot-warning-text"]);
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  // A trust card: the agent's purpose, the fixed action line, the amount, and the raw call behind
  // the technical details, as on the desktop and the web.
  const trust = approval.kind === "permissions" ? parseTrustApprovalCard(approval.command) : null;
  const reasonLines = (approval.reason ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const partial = approvalIsPartial(approval);
  const disabled = !canAnswer || pending !== null;
  const permissions = approval.kind === "permissions" ? approval.permissions : null;
  const permissionDetails = permissions
    ? [
        ...(permissions.network ? [t("mobile.chat.approval.network")] : []),
        ...permissions.fileSystem.read.map((path) => t("mobile.chat.approval.read", { path: shortPath(path) })),
        ...permissions.fileSystem.write.map((path) => t("mobile.chat.approval.write", { path: shortPath(path) })),
      ]
    : [];
  const names = { name: agentName, server: serverName };
  const effect = partial
    ? t("mobile.chat.approval.partial", names)
    : approval.kind === "command"
      ? t("mobile.chat.approval.effect.command", names)
      : approval.kind === "file-change"
        ? t("mobile.chat.approval.effect.fileChange", names)
        : t("mobile.chat.approval.effect.permissions", names);
  const hasDetails =
    (!trust && Boolean(approval.command)) || approval.kind === "file-change" || permissionDetails.length > 0;

  async function answer(decision: ApprovalDecision) {
    if (disabled) return;
    void haptics.selection();
    setPending(decision);
    setFailed(null);
    try {
      await respond(decision);
      void haptics.notification("success");
    } catch (error) {
      void haptics.notification("error");
      if (error instanceof InactiveRequestError) {
        // The card is gone with its request. The alert says why the answer did not count.
        showWarningAlert("turn", t("mobile.chat.approval.inactiveTitle"), error.message);
        return;
      }
      setFailed(errorMessage(error, t("mobile.chat.approval.sendFailed")));
    } finally {
      setPending(null);
    }
  }

  return (
    <View
      className="w-full gap-2.5"
      accessibilityLabel={t("mobile.chat.approval.label")}
      accessibilityState={{ busy: pending !== null }}
    >
      <View
        className="max-w-[88%] self-start gap-2.5 rounded-[30px] bg-control/60 px-4 py-3"
        style={{ borderCurve: "circular" }}
      >
        <View className="gap-1">
          {showAgentName ? (
            <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1}>
              {t("mobile.chat.approval.from", { name: agentName })}
            </Typography.Paragraph>
          ) : null}
          <View className="flex-row items-center gap-2">
            <ShieldAlert color={String(warningText)} size={16} strokeWidth={2.2} />
            <Typography.Paragraph weight="semibold" className="min-w-0 flex-1" accessibilityRole="header">
              {approvalTitle(approval, t)}
            </Typography.Paragraph>
          </View>
          {trust?.purpose ? (
            <View className="gap-0.5">
              {trust.purposeBy === "atelier" ? (
                <Typography.Paragraph type="body-xs" className="text-muted">
                  {t("mobile.chat.approval.atelierSummary")}
                </Typography.Paragraph>
              ) : null}
              <Typography.Paragraph>{trust.purpose}</Typography.Paragraph>
            </View>
          ) : null}
          {trust?.action.map((line) => (
            <Typography.Paragraph key={line} type="body-sm" className="text-text-secondary">
              {sourceText(line)}
            </Typography.Paragraph>
          ))}
          {trust?.amount ? (
            <Typography.Paragraph type="body-sm" weight="medium">
              {t("mobile.chat.approval.amount", { amount: trust.amount })}
            </Typography.Paragraph>
          ) : null}
          {reasonLines.map((line) =>
            trust ? (
              <Typography.Paragraph key={line} type="body-xs" className="text-muted">
                {sourceText(line)}
              </Typography.Paragraph>
            ) : (
              <Typography.Paragraph key={line}>{sourceText(line)}</Typography.Paragraph>
            ),
          )}
        </View>

        {trust?.details ? (
          <View className="gap-1.5">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: technical }}
              onPress={() => setTechnical((open) => !open)}
            >
              <Typography.Paragraph type="body-xs" className="text-muted">
                {t("mobile.chat.approval.technical")}
              </Typography.Paragraph>
            </Pressable>
            {technical ? (
              <View className="rounded-[18px] bg-control px-3 py-2.5" style={{ borderCurve: "continuous" }}>
                <Typography.Code
                  selectable
                  className="bg-transparent p-0"
                  style={{ color: foreground, fontSize: 13, lineHeight: 19 }}
                >
                  {trust.details}
                </Typography.Code>
              </View>
            ) : null}
          </View>
        ) : null}

        {hasDetails ? (
          <View className="gap-2 rounded-[18px] bg-control px-3 py-2.5" style={{ borderCurve: "continuous" }}>
            {approval.command && !trust ? (
              <Typography.Code
                selectable
                className="bg-transparent p-0"
                style={{ color: foreground, fontSize: 13, lineHeight: 19 }}
              >
                {approval.kind === "permissions"
                  ? // A trust card's lines are source text from the host, such as a money card's effect.
                    approval.command
                      .split("\n")
                      .map((line) => sourceText(line))
                      .join("\n")
                  : commandText(approval.command)}
              </Typography.Code>
            ) : null}
            {approval.kind === "file-change" ? (
              <View className="gap-0.5">
                <Typography.Paragraph type="body-xs" className="text-muted">
                  {t("mobile.chat.approval.files")}
                </Typography.Paragraph>
                <Typography.Paragraph type="body-sm" weight="medium" selectable>
                  {approval.grantRoot ? shortPath(approval.grantRoot) : t("mobile.chat.approval.agentWorkspace")}
                </Typography.Paragraph>
              </View>
            ) : null}
            {permissionDetails.length ? (
              <View className="gap-1" accessibilityLabel={t("mobile.chat.approval.permissions")}>
                {permissionDetails.map((detail) => (
                  <Typography.Paragraph key={detail} type="body-sm" selectable>
                    {detail}
                  </Typography.Paragraph>
                ))}
              </View>
            ) : null}
            {approval.command && approval.cwd ? (
              <View className="flex-row items-center gap-1.5">
                <Folder color={String(muted)} size={12} />
                <Typography.Paragraph type="body-xs" className="min-w-0 flex-1 text-muted" numberOfLines={1} selectable>
                  {shortPath(approval.cwd)}
                </Typography.Paragraph>
              </View>
            ) : null}
          </View>
        ) : null}

        <Typography.Paragraph type="body-xs" className="text-text-secondary">
          {effect}
        </Typography.Paragraph>
      </View>

      {/* Answer pills under the bubble, as the quick replies of the chat design. */}
      <View className="flex-row flex-wrap gap-2">
        {partial ? null : (
          <Button
            size="sm"
            variant="tertiary"
            className="rounded-full"
            isDisabled={disabled}
            onPress={() => void answer("accept")}
          >
            <Button.Label className="font-sans font-semibold">
              {pending === "accept" ? t("common.sending") : t("mobile.chat.approval.allow")}
            </Button.Label>
          </Button>
        )}
        <Button
          size="sm"
          variant="tertiary"
          className="rounded-full"
          isDisabled={disabled}
          onPress={() => void answer("decline")}
        >
          <Button.Label className="font-sans font-semibold">
            {pending === "decline" ? t("common.sending") : t("mobile.chat.approval.deny")}
          </Button.Label>
        </Button>
      </View>
      {!canAnswer ? (
        <Typography.Paragraph type="body-xs" className="text-text-secondary">
          {t("mobile.chat.approval.reconnect", { server: serverName })}
        </Typography.Paragraph>
      ) : null}
      {failed ? (
        <Typography.Paragraph type="body-xs" className="text-danger-text" accessibilityRole="alert">
          {failed}
        </Typography.Paragraph>
      ) : null}
    </View>
  );
}
